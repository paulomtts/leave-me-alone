#!/usr/bin/env node
// Deterministic, single-attempt merge of one story's tip into the
// milestone's integration branch. The orchestrator calls this once per
// story, in dependency-level order, and handles what happens on a conflict
// itself (dispatch a resolution agent) — this script only ever attempts one
// merge and reports what happened.
//
//   bun scripts/integrate.mjs --repo-dir /abs/repo --worktree /abs/repo/.claude/worktrees/m12-integrate \
//     --integration-branch m12-integrate --base-branch master --merge-tip m12/story-a/task-x-a1b2c3d4 --compact
//
// Idempotent like worktree.mjs: a fresh integration branch is cut from
// origin/<base-branch> only if it does not already exist; a later call for
// the same milestone reuses it, carrying forward whatever already merged.
//
// On conflict, the merge is left IN PROGRESS — conflict markers in the
// working tree, MERGE_HEAD set — never aborted. That is deliberate: it is
// the state a resolution agent needs to work in directly (read the markers,
// edit, `git add`, `git commit`). A call made while an earlier conflict is
// still unresolved is a caller error, not a condition this script guesses
// its way through.

import { gitRunner, readFlags } from './gh.mjs'
import { worktreePaths, branchExists } from './worktree.mjs'

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--repo-dir': 'value', '--worktree': 'value', '--integration-branch': 'value',
    '--base-branch': 'value', '--merge-tip': 'value', '--compact': 'boolean',
  })
  const out = {
    repoDir: flags['--repo-dir'], worktree: flags['--worktree'],
    integrationBranch: flags['--integration-branch'], baseBranch: flags['--base-branch'],
    mergeTip: flags['--merge-tip'], compact: flags['--compact'] === true,
  }
  for (const [key, ok, msg] of [
    ['repoDir', v => typeof v === 'string' && v.startsWith('/'), '--repo-dir <absolute path>'],
    ['worktree', v => typeof v === 'string' && v.startsWith('/'), '--worktree <absolute path>'],
    ['integrationBranch', v => typeof v === 'string' && v.length > 0, '--integration-branch <name>'],
    ['baseBranch', v => typeof v === 'string' && v.length > 0, '--base-branch <name>'],
    ['mergeTip', v => typeof v === 'string' && v.length > 0, '--merge-tip <branch>'],
  ]) if (!ok(out[key])) throw new Error(`integrate needs ${msg}`)
  return out
}

export async function attempt(options, git = gitRunner) {
  const { repoDir, worktree, integrationBranch, baseBranch, mergeTip } = options

  const worktreeExists = worktreePaths(
    await git(['-C', repoDir, 'worktree', 'list', '--porcelain'])).includes(worktree)

  const result = { created: false, conflict: false, files: [], merged: null, detail: '' }

  if (!worktreeExists) {
    // Check if the integration branch already exists locally
    const branches = String(await git(['-C', repoDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').map(l => l.trim()).filter(Boolean)
    const branchAlreadyExists = branches.includes(integrationBranch)

    if (branchAlreadyExists) {
      // Branch exists but worktree was removed; reuse the existing branch
      await git(['-C', repoDir, 'worktree', 'add', worktree, integrationBranch])
    } else {
      // Fresh branch creation off origin/<base-branch>
      await git(['-C', repoDir, 'worktree', 'add', worktree, '-b', integrationBranch, `origin/${baseBranch}`])
    }
    result.created = true
  }

  // A merge already in progress means a prior conflict was never resolved —
  // never silently proceed on top of that.
  try {
    await git(['-C', worktree, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
    throw new Error(
      `integrate: a merge is already in progress in ${worktree} — resolve or handle it before calling integrate.mjs again`)
  } catch (err) {
    // With --quiet, git rev-parse exits with code 1 (not 128) when the ref does not exist
    if (!(err && err.code === 1)) throw err   // 1 == "no MERGE_HEAD", the expected case with --quiet
  }

  try {
    await git(['-C', worktree, 'merge', '--no-ff', mergeTip])
    result.merged = mergeTip
  } catch (err) {
    // Check if this is a real content conflict by looking for unmerged files
    const unmerged = await git(['-C', worktree, 'diff', '--name-only', '--diff-filter=U'])
    const unmergedFiles = String(unmerged ?? '').split('\n').map(l => l.trim()).filter(Boolean)

    if (unmergedFiles.length === 0) {
      // Not a real conflict (bad ref, I/O error, etc.) — rethrow the original error
      throw err
    }

    // Real content conflict: leave merge in progress for resolution agent
    result.conflict = true
    result.files = unmergedFiles
    result.detail = String((err && err.message) || err).split('\n')[0]
  }
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await attempt(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (result.conflict) process.exitCode = 1
}
