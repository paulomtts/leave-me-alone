import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, worktreePaths, branchExists, prepare } from './worktree.mjs'

const ARGS = ['--repo=o/n', '--branch=m1/task-9', '--base=main', '--worktree=/wt', '--repo-dir=/repo']

test('every argument is checked at the door', () => {
  assert.equal(parseArgs(ARGS).branch, 'm1/task-9')
  for (const drop of ARGS) {
    assert.throws(() => parseArgs(ARGS.filter(a => a !== drop)), /worktree needs/, `dropping ${drop}`)
  }
})

test('worktree paths are read from porcelain, not guessed', () => {
  const out = 'worktree /repo\nHEAD abc\nbranch refs/heads/master\n\nworktree /wt\nHEAD def\nbranch refs/heads/m1/task-9\n'
  assert.deepEqual(worktreePaths(out), ['/repo', '/wt'])
  assert.deepEqual(worktreePaths(''), [])
})

test('branch existence is an exact match, not a prefix', () => {
  const refs = 'master\nm1/task-9\nm1/task-90\n'
  assert.equal(branchExists(refs, 'm1/task-9'), true)
  assert.equal(branchExists(refs, 'm1/task-'), false)   // must not match by prefix
  assert.equal(branchExists(refs, 'nope'), false)
})

const gitFake = (routes, log = []) => async (args) => {
  const joined = args.join(' ')
  log.push(joined)
  for (const [needle, reply] of routes) if (joined.includes(needle)) return reply
  return ''
}
const ghNone = async () => '[]'
const opts = () => parseArgs(ARGS)

test('a brand new subtask gets a branch cut from the base', async () => {
  const log = []
  const got = await prepare(opts(), gitFake([['rev-list', '0\n']], log), ghNone)
  assert.equal(got.created, true)
  assert.equal(got.branchExisted, false)
  assert.match(log.find(c => c.includes('worktree add')), /worktree add \/wt -b m1\/task-9 origin\/main/)
})

test('an existing branch is checked out, NOT re-cut from the base', async () => {
  // Re-cutting would silently discard a killed run's commits.
  const log = []
  const got = await prepare(opts(),
    gitFake([['for-each-ref', 'master\nm1/task-9\n'], ['rev-list', '3\n']], log), ghNone)
  assert.equal(got.branchExisted, true)
  assert.equal(got.commitCount, 3)
  assert.match(log.find(c => c.includes('worktree add')), /worktree add \/wt m1\/task-9$/)
})

test('an existing worktree is left completely alone', async () => {
  const log = []
  const got = await prepare(opts(), gitFake([
    ['for-each-ref', 'm1/task-9\n'], ['worktree list', 'worktree /wt\n'], ['rev-list', '2\n'],
  ], log), ghNone)
  assert.equal(got.worktreeExisted, true)
  assert.equal(got.created, false)
  assert.equal(log.some(c => c.includes('worktree add')), false)
})

test('a live PR stops everything before a single git command runs', async () => {
  // Something else is driving this branch; resetting or committing over it is
  // a human's call. Nothing is created.
  const log = []
  const got = await prepare(opts(), gitFake([], log), async () => '[41]')
  assert.equal(got.openPr, 41)
  assert.deepEqual(log, [])
})

test('a failed PR lookup is reported, not treated as "no PR"', async () => {
  // "The API did not answer" and "the branch is clear" must stay distinct.
  const got = await prepare(opts(), gitFake([['rev-list', '0\n']]), async () => { throw new Error('502 bad gateway') }, () => Promise.resolve())
  assert.match(got.prLookupError, /502/)
  assert.equal(got.openPr, null)
  assert.equal(got.created, true)
})

test('it never resets, deletes or commits', async () => {
  const log = []
  await prepare(opts(), gitFake([['for-each-ref', 'm1/task-9\n'], ['rev-list', '9\n']], log), ghNone)
  for (const forbidden of ['reset', 'checkout -f', 'clean', 'commit', 'push', 'worktree remove', 'prune']) {
    assert.equal(log.some(c => c.includes(forbidden)), false, `must not run ${forbidden}`)
  }
})
