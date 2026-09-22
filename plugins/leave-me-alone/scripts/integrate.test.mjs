import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attempt, parseArgs } from './integrate.mjs'

test('every argument is checked at the door', () => {
  assert.throws(() => parseArgs([]), /--repo-dir/)
  assert.throws(() => parseArgs(['--repo-dir', '/r']), /--worktree/)
  assert.throws(() => parseArgs(['--repo-dir', '/r', '--worktree', '/w']), /--integration-branch/)
})

test('a fresh integration branch is created off origin/<base-branch>', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args.includes('worktree') && args.includes('list')) return ''
    if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    return ''
  }
  await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-a-tip' }, git)
  const addCall = calls.find(c => c[2] === 'worktree' && c[3] === 'add')
  assert.deepEqual(addCall, ['-C', '/r', 'worktree', 'add', '/w', '-b', 'm12-integrate', 'origin/master'])
})

test('an existing integration branch is reused, not recreated', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args.includes('worktree') && args.includes('list')) return 'worktree /w\n'
    if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    return ''
  }
  await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-b-tip' }, git)
  assert.equal(calls.some(c => c[1] === 'worktree' && c[2] === 'add'), false, 'must not recreate an existing worktree')
})

test('a clean merge reports conflict: false and what was merged', async () => {
  const git = async args => {
    if (args.includes('worktree') && args.includes('list')) return 'worktree /w\n'
    if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    if (args.includes('merge')) return 'Merge made by the ort strategy.'
    return ''
  }
  const result = await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-a-tip' }, git)
  assert.equal(result.conflict, false)
  assert.equal(result.merged, 'm12/story-a-tip')
})

test('a conflicting merge reports the file list and leaves the merge in progress', async () => {
  const git = async args => {
    if (args.includes('worktree') && args.includes('list')) return 'worktree /w\n'
    if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    if (args.includes('merge')) { const e = new Error('CONFLICT (content): Merge conflict in a.js'); e.code = 1; throw e }
    if (args.includes('diff') && args.includes('--diff-filter=U')) return 'a.js\n'
    return ''
  }
  const result = await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-b-tip' }, git)
  assert.equal(result.conflict, true)
  assert.deepEqual(result.files, ['a.js'])
  // must NOT have run `merge --abort`
})

test('calling attempt while a previous conflict is unresolved fails loudly', async () => {
  const git = async args => {
    if (args.includes('worktree') && args.includes('list')) return 'worktree /w\n'
    if (args.includes('rev-parse') && args.includes('MERGE_HEAD')) return 'abc123\n'
    return ''
  }
  await assert.rejects(
    () => attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-c-tip' }, git),
    /already in progress/)
})
