import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, worktreePaths, branchExists, prepare } from './worktree.mjs'

const ARGS = ['--branch=m1/task-9', '--base=main', '--worktree=/wt', '--repo-dir=/repo']

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
  const got = await prepare(opts(), gitFake([['rev-list', '0\n']], log))
  assert.equal(got.created, true)
  assert.equal(got.branchExisted, false)
  assert.match(log.find(c => c.includes('worktree add')), /worktree add \/wt -b m1\/task-9 origin\/main/)
})

test('an existing branch is checked out, NOT re-cut from the base', async () => {
  // Re-cutting would silently discard a killed run's commits.
  const log = []
  const got = await prepare(opts(),
    gitFake([['for-each-ref', 'master\nm1/task-9\n'], ['rev-list', '3\n']], log))
  assert.equal(got.branchExisted, true)
  assert.equal(got.commitCount, 3)
  assert.match(log.find(c => c.includes('worktree add')), /worktree add \/wt m1\/task-9$/)
})

test('a base that only exists locally (a prior subtask/story branch, never pushed) is used directly, not as origin/<base>', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args.includes('rev-parse') && args.includes('origin/story-a-tip')) {
      const err = new Error('fatal: bad revision'); err.code = 128; throw err
    }
    if (args.includes('for-each-ref')) return ''
    if (args.includes('worktree') && args.includes('list')) return ''
    if (args.includes('rev-list')) return '0\n'
    return ''
  }
  await prepare({ branch: 'm1/task-b', base: 'story-a-tip', worktree: '/wt', repoDir: '/repo' }, git)
  const addCall = calls.find(c => c[2] === 'worktree' && c[3] === 'add')
  assert.deepEqual(addCall.slice(-1), ['story-a-tip'], 'must branch from the local ref, not origin/story-a-tip')
})

test('a base that IS on the remote (the milestone baseBranch) still uses origin/<base>', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args.includes('rev-parse') && args.includes('origin/master')) return 'abc123\n'
    if (args.includes('for-each-ref')) return ''
    if (args.includes('worktree') && args.includes('list')) return ''
    if (args.includes('rev-list')) return '0\n'
    return ''
  }
  await prepare({ branch: 'm1/task-a', base: 'master', worktree: '/wt', repoDir: '/repo' }, git)
  const addCall = calls.find(c => c[2] === 'worktree' && c[3] === 'add')
  assert.deepEqual(addCall.slice(-1), ['origin/master'], 'a real remote base must still use origin/<base>')
})

test('an existing worktree is left completely alone', async () => {
  const log = []
  const got = await prepare(opts(), gitFake([
    ['for-each-ref', 'm1/task-9\n'], ['worktree list', 'worktree /wt\n'], ['rev-list', '2\n'],
  ], log))
  assert.equal(got.worktreeExisted, true)
  assert.equal(got.created, false)
  assert.equal(log.some(c => c.includes('worktree add')), false)
})

test('it never resets, deletes or commits', async () => {
  const log = []
  await prepare(opts(), gitFake([['for-each-ref', 'm1/task-9\n'], ['rev-list', '9\n']], log))
  for (const forbidden of ['reset', 'checkout -f', 'clean', 'commit', 'push', 'worktree remove', 'prune']) {
    assert.equal(log.some(c => c.includes(forbidden)), false, `must not run ${forbidden}`)
  }
})
