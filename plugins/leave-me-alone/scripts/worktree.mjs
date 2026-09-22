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

import { gitRunner, readFlags } from './gh.mjs'

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--branch': 'value', '--base': 'value',
    '--worktree': 'value', '--repo-dir': 'value', '--compact': 'boolean',
  })
  const out = {
    branch: flags['--branch'], base: flags['--base'],
    worktree: flags['--worktree'], repoDir: flags['--repo-dir'],
    compact: flags['--compact'] === true,
  }
  for (const [key, ok, msg] of [
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

export async function prepare(options, git = gitRunner, wait) {
  const { branch, base, worktree, repoDir } = options
  const result = { branch, worktree, branchExisted: false, worktreeExisted: false, created: false, commitCount: 0 }

  result.branchExisted = branchExists(
    await git(['-C', repoDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/']), branch)
  result.worktreeExisted = worktreePaths(
    await git(['-C', repoDir, 'worktree', 'list', '--porcelain'])).includes(worktree)

  // `base` names a real remote branch only when it IS the milestone's own
  // baseBranch — every other base is another subtask's or story's own local
  // branch, which this run created and never pushes. Prefer origin/<base>
  // when it resolves; fall back to the bare local ref otherwise, rather than
  // requiring the caller to say which kind of base it passed.
  let resolvedBase = base
  try {
    await git(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `origin/${base}`])
    resolvedBase = `origin/${base}`
  } catch { /* no such remote ref — use the local branch directly */ }

  if (!result.worktreeExisted) {
    const args = result.branchExisted
      ? ['-C', repoDir, 'worktree', 'add', worktree, branch]
      : ['-C', repoDir, 'worktree', 'add', worktree, '-b', branch, resolvedBase]
    await git(args)
    result.created = true
  }

  result.commitCount = Number(String(
    await git(['-C', worktree, 'rev-list', '--count', `${resolvedBase}..HEAD`])).trim()) || 0
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await prepare(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
}
