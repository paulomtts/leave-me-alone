#!/usr/bin/env node
// Create a subtask's worktree, idempotently, and report what was already there.
//
// This used to be a decision tree inside Implement's prompt. It is pure
// mechanism — does the branch exist, does the directory exist, is there a live
// PR — and it has to happen EARLY now: the spec and the plan are written inside
// the worktree so they travel with the subtask's own PR, which means the
// worktree must exist before the first stage that writes.
//
//   bun scripts/worktree.mjs --repo o/n --branch m1/task-9 --base main \
//     --worktree /abs/wt --repo-dir /abs/repo --compact
//
// It creates and reports. It never resets, never deletes, and never commits:
// deciding RESUME vs RESET needs the plan hash, which does not exist yet.
//
// Concurrent dispatches share one `.git`, so the check-and-create section runs
// under `.git/leave-me-alone-worktree.lock` — an atomic `wx` lockfile, retried
// with backoff, reclaimed when stale.

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { ghRunner, gitRunner, ghError, jsonFrom, readFlags, sleep, withRetries } from './gh.mjs'

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--repo': 'value', '--branch': 'value', '--base': 'value',
    '--worktree': 'value', '--repo-dir': 'value', '--compact': 'boolean',
  })
  const out = {
    repo: flags['--repo'], branch: flags['--branch'], base: flags['--base'],
    worktree: flags['--worktree'], repoDir: flags['--repo-dir'],
    compact: flags['--compact'] === true,
  }
  for (const [key, ok, msg] of [
    ['repo', v => typeof v === 'string' && /^[^/\s]+\/[^/\s]+$/.test(v), '--repo owner/name'],
    ['branch', v => typeof v === 'string' && v.length > 0, '--branch <name>'],
    ['base', v => typeof v === 'string' && v.length > 0, '--base <name>'],
    ['worktree', v => typeof v === 'string' && v.startsWith('/'), '--worktree <absolute path>'],
    ['repoDir', v => typeof v === 'string' && v.startsWith('/'), '--repo-dir <absolute path>'],
  ]) if (!ok(out[key])) throw new Error(`worktree needs ${msg}`)
  return out
}

// `git worktree list --porcelain` prints a "worktree <path>" line per entry.
export function worktreePaths(porcelain) {
  return String(porcelain ?? '').split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
}

export function branchExists(refList, branch) {
  return String(refList ?? '').split('\n').map(l => l.trim()).filter(Boolean).includes(branch)
}

export const LOCK_STALE_MS = 10 * 60 * 1000

export function lockPathFor(repoDir) {
  return `${repoDir}/.git/leave-me-alone-worktree.lock`
}

export const fileLock = {
  // `wx` fails when the file already exists, so creation is atomic across processes.
  async acquire(path, holder) { await writeFile(path, holder, { flag: 'wx' }) },
  async read(path) { try { return String(await readFile(path, 'utf8')).trim() } catch { return null } },
  async age(path, nowMs) { try { return nowMs - (await stat(path)).mtimeMs } catch { return null } },
  async release(path) { await rm(path, { force: true }) },
}

export async function acquireLock(lockPath, {
  lock = fileLock,
  holder = `pid ${process.pid}`,
  tries = 8,
  baseDelayMs = 250,
  staleMs = LOCK_STALE_MS,
  wait = sleep,
  now = () => Date.now(),
} = {}) {
  let reclaimed = false
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await lock.acquire(lockPath, holder)
      return { reclaimed }
    } catch {
      const ageMs = await lock.age(lockPath, now())
      if (ageMs !== null && ageMs > staleMs) {
        await lock.release(lockPath)
        reclaimed = true
        continue
      }
      if (attempt < tries - 1) await wait(baseDelayMs * (2 ** attempt))
    }
  }
  throw new Error(`worktree: could not acquire ${lockPath} after ${tries} attempts (held by ${await lock.read(lockPath) ?? 'unknown'})`)
}

export function isLockContention(err) {
  const text = `${(err && err.stderr) || ''} ${(err && err.message) || ''}`
  return /index\.lock/.test(text)
    || /\.git\/worktrees\/[^\s]+\/locked/.test(text)
    || /cannot lock ref/i.test(text)
}

export async function addWorktreeWithRetry(git, plan, { tries = 3, baseDelayMs = 250, wait = sleep } = {}) {
  const { repoDir, worktree, branch, base, branchExisted } = plan
  const args = branchExisted
    ? ['-C', repoDir, 'worktree', 'add', worktree, branch]
    : ['-C', repoDir, 'worktree', 'add', worktree, '-b', branch, `origin/${base}`]

  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await git(args)
      return { created: true }
    } catch (err) {
      if (!isLockContention(err)) throw err
      // A contended add can be partially applied, so ask git what exists now
      // rather than repeating a write.
      const paths = worktreePaths(await git(['-C', repoDir, 'worktree', 'list', '--porcelain']))
      if (paths.includes(worktree)) return { created: false }
      if (attempt === tries - 1) throw err
      await wait(baseDelayMs * (2 ** attempt))
    }
  }
  throw new Error(`worktree: add of ${worktree} exhausted ${tries} attempts`)
}

export async function prepare(options, git = gitRunner, gh = ghRunner, wait, lockOptions = {}) {
  const { repo, branch, base, worktree, repoDir } = options
  const result = { branch, worktree, branchExisted: false, worktreeExisted: false, created: false, openPr: null, commitCount: 0 }

  // A live PR on this branch means something else is driving it. Report and
  // change NOTHING — this is the only place that check happens, and the caller
  // stops on it rather than resetting someone's work.
  try {
    const open = jsonFrom(await withRetries('worktree: open-PR check',
      () => gh(['api', `repos/${repo}/pulls?state=open&per_page=100`,
        '--jq', `[.[] | select(.head.ref=="${branch}") | .number]`]), { wait }))
    if (Array.isArray(open) && open.length > 0) {
      result.openPr = open[0]
      return result
    }
  } catch (err) {
    // Not fatal on its own: the caller decides. Say so rather than pretending
    // the branch is clear.
    result.prLookupError = ghError(err)
  }

  const lock = lockOptions.lock ?? fileLock
  const lockPath = lockOptions.lockPath ?? lockPathFor(repoDir)
  const { reclaimed } = await acquireLock(lockPath, { wait, ...lockOptions, lock })
  if (reclaimed) result.lockReclaimed = true

  try {
    result.branchExisted = branchExists(
      await git(['-C', repoDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/']), branch)
    result.worktreeExisted = worktreePaths(
      await git(['-C', repoDir, 'worktree', 'list', '--porcelain'])).includes(worktree)

    if (!result.worktreeExisted) {
      const added = await addWorktreeWithRetry(git,
        { repoDir, worktree, branch, base, branchExisted: result.branchExisted }, { wait })
      result.created = added.created
    }
  } finally {
    await lock.release(lockPath)
  }

  result.commitCount = Number(String(
    await git(['-C', worktree, 'rev-list', '--count', `origin/${base}..HEAD`])).trim()) || 0
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await prepare(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (result.openPr) process.exitCode = 1
}
