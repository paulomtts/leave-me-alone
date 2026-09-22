// plugins/leave-me-alone/workflows/orchestrator.integration.test.mjs
//
// Builds a REAL local git history with two independent branches carrying a
// deliberate conflict on the same file, and drives integrate.mjs's attempt()
// against it directly (not through the full Workflow harness — that is
// covered by the PURE-region tests above; this proves the git mechanics).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attempt } from '../scripts/integrate.mjs'

function git(...args) { return execFileSync('git', args, { encoding: 'utf8' }) }
// integrate.mjs's own default git runner (gitRunner, in scripts/gh.mjs) wraps
// promisify(execFile), NOT execFileSync — and that distinction is not
// cosmetic: on a non-zero exit, execFileSync's thrown error carries the exit
// code on `.status`, while promisify(execFile)'s carries it on `.code` (a
// number, not the string 'ENOENT'-style code a spawn failure would set).
// integrate.mjs's own conflict detection only works because it is written
// against the LATTER shape (`err.code === 1` after `--quiet` finds no
// MERGE_HEAD) — a wrapper built on execFileSync would report every "no
// MERGE_HEAD yet" check as a genuine failure and never reach the merge at
// all. Mirroring gitRunner's real shape here is what makes this test
// exercise integrate.mjs's actual mechanics rather than a variant of them.
const execFileAsync = promisify(execFile)
const realGit = async args => {
  const { stdout } = await execFileAsync('git', args, { encoding: 'utf8' })
  return stdout
}

test('two independent branches with a real file conflict: detected correctly, originals untouched', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'lma-integrate-'))
  git('-C', repo, 'init', '-q')
  git('-C', repo, 'config', 'user.email', 'test@test')
  git('-C', repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'base')
  git('-C', repo, 'checkout', '-q', '-b', 'origin-stand-in')   // stand in for a remote

  git('-C', repo, 'checkout', '-q', '-b', 'story-a')
  writeFileSync(join(repo, 'shared.txt'), 'story A\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'story A change')
  const storyASha = git('-C', repo, 'rev-parse', 'story-a').trim()

  git('-C', repo, 'checkout', '-q', 'origin-stand-in')
  git('-C', repo, 'checkout', '-q', '-b', 'story-b')
  writeFileSync(join(repo, 'shared.txt'), 'story B\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'story B change')
  const storyBSha = git('-C', repo, 'rev-parse', 'story-b').trim()

  // Fake an "origin" remote pointing at this same repo, so integrate.mjs's
  // `origin/<base>` resolution works without a real network remote.
  git('-C', repo, 'remote', 'add', 'origin', repo)
  git('-C', repo, 'fetch', '-q', 'origin')

  const wtDir = join(repo, '.claude', 'worktrees', 'm1-integrate')

  const first = await attempt({ repoDir: repo, worktree: wtDir, integrationBranch: 'm1-integrate', baseBranch: 'origin-stand-in', mergeTip: 'story-a' }, realGit)
  assert.equal(first.conflict, false)

  const second = await attempt({ repoDir: repo, worktree: wtDir, integrationBranch: 'm1-integrate', baseBranch: 'origin-stand-in', mergeTip: 'story-b' }, realGit)
  assert.equal(second.conflict, true)
  assert.deepEqual(second.files, ['shared.txt'])

  // Both original branches must be untouched by the conflicting attempt.
  assert.equal(git('-C', repo, 'rev-parse', 'story-a').trim(), storyASha)
  assert.equal(git('-C', repo, 'rev-parse', 'story-b').trim(), storyBSha)

  rmSync(repo, { recursive: true, force: true })
})

// This exercises the fix for the "resolved conflict abandons every later
// story" bug: orchestrator.js's Integrate walk used to `break` on a conflict
// and never resume, even after a successful resolution. Proving that at the
// orchestrator level would mean driving the full Workflow dispatch, which
// this file's own established pattern (see the header comment) deliberately
// does not do — so this proves the same thing one layer down, directly
// against integrate.mjs: after a conflict between story-a and story-b is
// resolved (a commit made the same way the resolution agent would make it —
// staging the conflicting file and committing with --no-edit), a THIRD
// story's attempt() against the now-resolved integration branch still
// succeeds. If the walk could not meaningfully continue past a resolved
// conflict, this merge would be attempted against a branch stuck mid-merge.
test('a resolved conflict lets integration continue: a third branch merges cleanly afterward', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'lma-integrate-resume-'))
  git('-C', repo, 'init', '-q')
  git('-C', repo, 'config', 'user.email', 'test@test')
  git('-C', repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  writeFileSync(join(repo, 'other.txt'), 'base\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'base')
  git('-C', repo, 'checkout', '-q', '-b', 'origin-stand-in')

  git('-C', repo, 'checkout', '-q', '-b', 'story-a')
  writeFileSync(join(repo, 'shared.txt'), 'story A\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'story A change')

  git('-C', repo, 'checkout', '-q', 'origin-stand-in')
  git('-C', repo, 'checkout', '-q', '-b', 'story-b')
  writeFileSync(join(repo, 'shared.txt'), 'story B\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'story B change')

  git('-C', repo, 'checkout', '-q', 'origin-stand-in')
  git('-C', repo, 'checkout', '-q', '-b', 'story-c')
  writeFileSync(join(repo, 'other.txt'), 'story C\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'story C change')

  git('-C', repo, 'remote', 'add', 'origin', repo)
  git('-C', repo, 'fetch', '-q', 'origin')

  const wtDir = join(repo, '.claude', 'worktrees', 'm1-integrate')

  const first = await attempt({ repoDir: repo, worktree: wtDir, integrationBranch: 'm1-integrate', baseBranch: 'origin-stand-in', mergeTip: 'story-a' }, realGit)
  assert.equal(first.conflict, false)

  const second = await attempt({ repoDir: repo, worktree: wtDir, integrationBranch: 'm1-integrate', baseBranch: 'origin-stand-in', mergeTip: 'story-b' }, realGit)
  assert.equal(second.conflict, true)
  assert.deepEqual(second.files, ['shared.txt'])

  // Mimic what the resolution agent does: edit the conflicting file to a
  // resolved state, stage it, and commit with --no-edit (finishing the merge
  // already in progress).
  writeFileSync(join(wtDir, 'shared.txt'), 'story A and story B, resolved\n')
  git('-C', wtDir, 'add', 'shared.txt')
  git('-C', wtDir, 'commit', '-q', '--no-edit')

  // No merge should be in progress any more.
  assert.throws(() => git('-C', wtDir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'))

  // The walk continues to the NEXT story — its attempt() must succeed against
  // the now-resolved integration branch, not against a branch still mid-merge.
  const third = await attempt({ repoDir: repo, worktree: wtDir, integrationBranch: 'm1-integrate', baseBranch: 'origin-stand-in', mergeTip: 'story-c' }, realGit)
  assert.equal(third.conflict, false)
  assert.equal(third.merged, 'story-c')

  rmSync(repo, { recursive: true, force: true })
})
