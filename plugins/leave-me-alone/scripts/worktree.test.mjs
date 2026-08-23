import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, worktreePaths, branchExists, prepare, acquireLock, isLockContention } from './worktree.mjs'

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
  const got = await prepare(opts(), gitFake([['rev-list', '0\n']], log), ghNone, undefined, { lock: memLock() })
  assert.equal(got.created, true)
  assert.equal(got.branchExisted, false)
  assert.match(log.find(c => c.includes('worktree add')), /worktree add \/wt -b m1\/task-9 origin\/main/)
})

test('an existing branch is checked out, NOT re-cut from the base', async () => {
  // Re-cutting would silently discard a killed run's commits.
  const log = []
  const got = await prepare(opts(),
    gitFake([['for-each-ref', 'master\nm1/task-9\n'], ['rev-list', '3\n']], log), ghNone, undefined, { lock: memLock() })
  assert.equal(got.branchExisted, true)
  assert.equal(got.commitCount, 3)
  assert.match(log.find(c => c.includes('worktree add')), /worktree add \/wt m1\/task-9$/)
})

test('an existing worktree is left completely alone', async () => {
  const log = []
  const got = await prepare(opts(), gitFake([
    ['for-each-ref', 'm1/task-9\n'], ['worktree list', 'worktree /wt\n'], ['rev-list', '2\n'],
  ], log), ghNone, undefined, { lock: memLock() })
  assert.equal(got.worktreeExisted, true)
  assert.equal(got.created, false)
  assert.equal(log.some(c => c.includes('worktree add')), false)
})

test('a live PR stops everything before a single git command runs', async () => {
  // Something else is driving this branch; resetting or committing over it is
  // a human's call. Nothing is created, and no lock is taken.
  const log = []
  const lock = memLock({}, log)
  const got = await prepare(opts(), gitFake([], log), async () => '[41]', undefined, { lock })
  assert.equal(got.openPr, 41)
  assert.deepEqual(log, [])
  assert.equal(lock.state.holder, null)
})

test('a failed PR lookup is reported, not treated as "no PR"', async () => {
  // "The API did not answer" and "the branch is clear" must stay distinct.
  const got = await prepare(opts(), gitFake([['rev-list', '0\n']]), async () => { throw new Error('502 bad gateway') }, () => Promise.resolve(), { lock: memLock() })
  assert.match(got.prLookupError, /502/)
  assert.equal(got.openPr, null)
  assert.equal(got.created, true)
})

test('it never resets, deletes or commits', async () => {
  const log = []
  await prepare(opts(), gitFake([['for-each-ref', 'm1/task-9\n'], ['rev-list', '9\n']], log), ghNone, undefined, { lock: memLock() })
  for (const forbidden of ['reset', 'checkout -f', 'clean', 'commit', 'push', 'worktree remove', 'prune']) {
    assert.equal(log.some(c => c.includes(forbidden)), false, `must not run ${forbidden}`)
  }
})

// Stand-in for the lockfile: `acquire` refuses while someone holds it, exactly
// like writeFile(..., { flag: 'wx' }).
function memLock({ holder = null, heldAtMs = 0 } = {}, events = []) {
  const state = { holder, heldAtMs }
  return {
    state,
    events,
    async acquire(path, who) {
      if (state.holder !== null) throw new Error(`EEXIST: ${path}`)
      state.holder = who
      state.heldAtMs = 0
      events.push(`acquire ${path}`)
    },
    async read() { return state.holder },
    async age(_path, nowMs) { return state.holder === null ? null : nowMs - state.heldAtMs },
    async release(path) { state.holder = null; events.push(`release ${path}`) },
  }
}

test('a contended lock is retried with doubling backoff, then acquired', async () => {
  const lock = memLock({ holder: 'pid 4242' })
  const delays = []
  const wait = async (ms) => { delays.push(ms); lock.state.holder = null }
  const got = await acquireLock('/repo/.git/leave-me-alone-worktree.lock',
    { lock, wait, now: () => 0, tries: 4, baseDelayMs: 250 })
  assert.equal(got.reclaimed, false)
  assert.deepEqual(delays, [250])
  assert.equal(lock.state.holder, 'pid ' + process.pid)
})

test('an exhausted lock budget rejects with a labelled error naming the holder', async () => {
  const lock = memLock({ holder: 'pid 4242' })
  const delays = []
  await assert.rejects(
    () => acquireLock('/repo/.git/leave-me-alone-worktree.lock',
      { lock, wait: async (ms) => { delays.push(ms) }, now: () => 0, tries: 3, baseDelayMs: 250 }),
    /worktree: could not acquire \/repo\/\.git\/leave-me-alone-worktree\.lock after 3 attempts \(held by pid 4242\)/)
  assert.deepEqual(delays, [250, 500])
})

test('a lock older than the stale threshold is reclaimed, not waited on', async () => {
  const events = []
  const lock = memLock({ holder: 'pid 4242 (killed)', heldAtMs: 0 }, events)
  const delays = []
  const got = await acquireLock('/repo/.git/leave-me-alone-worktree.lock',
    { lock, wait: async (ms) => { delays.push(ms) }, now: () => 11 * 60 * 1000 })
  assert.equal(got.reclaimed, true)
  assert.deepEqual(delays, [])
  assert.deepEqual(events, [
    'release /repo/.git/leave-me-alone-worktree.lock',
    'acquire /repo/.git/leave-me-alone-worktree.lock',
  ])
})

test('only real git lock contention counts as contention', async () => {
  assert.equal(isLockContention(new Error("fatal: Unable to create '/repo/.git/index.lock': File exists")), true)
  assert.equal(isLockContention(new Error("fatal: cannot lock ref 'refs/heads/m1/task-9'")), true)
  assert.equal(isLockContention({ stderr: 'fatal: .git/worktrees/wt/locked is present' }), true)
  assert.equal(isLockContention(new Error("fatal: '/wt' already exists")), false)
  assert.equal(isLockContention(undefined), false)
})

const LOCK = '/repo/.git/leave-me-alone-worktree.lock'

test('the lock is held across the whole check-and-create section', async () => {
  const log = []
  const lock = memLock({}, log)
  const got = await prepare(opts(), gitFake([['rev-list', '0\n']], log), ghNone, undefined, { lock })
  const at = needle => log.findIndex(line => line.includes(needle))
  assert.equal(at(`acquire ${LOCK}`), 0, log.join(' | '))
  assert.ok(at('for-each-ref') < at('worktree list'), log.join(' | '))
  assert.ok(at('worktree list') < at('worktree add'), log.join(' | '))
  assert.ok(at('worktree add') < at(`release ${LOCK}`), log.join(' | '))
  assert.ok(at(`release ${LOCK}`) < at('rev-list'), log.join(' | '))
  assert.equal(got.created, true)
})

test('the lock is released when `worktree add` throws', async () => {
  const log = []
  const lock = memLock({}, log)
  const git = async (args) => {
    const joined = args.join(' ')
    log.push(joined)
    if (joined.includes('worktree add')) throw new Error('fatal: could not create leading directories')
    if (joined.includes('rev-list')) return '0\n'
    return ''
  }
  await assert.rejects(() => prepare(opts(), git, ghNone, async () => {}, { lock }),
    /could not create leading directories/)
  assert.equal(lock.state.holder, null)
  assert.equal(log.at(-1), `release ${LOCK}`)
})

test('an exhausted lock budget rejects without touching git', async () => {
  const log = []
  const lock = memLock({ holder: 'pid 4242' }, log)
  const delays = []
  await assert.rejects(
    () => prepare(opts(), gitFake([], log), ghNone, async (ms) => { delays.push(ms) },
      { lock, tries: 3, baseDelayMs: 250, now: () => 0 }),
    /worktree: could not acquire .*leave-me-alone-worktree\.lock after 3 attempts \(held by pid 4242\)/)
  assert.deepEqual(delays, [250, 500])
  assert.deepEqual(log, [])
})

test('a stale lock is reclaimed instead of wedging the dispatch', async () => {
  const log = []
  const lock = memLock({ holder: 'pid 4242 (killed)', heldAtMs: 0 }, log)
  const got = await prepare(opts(), gitFake([['rev-list', '0\n']], log), ghNone, async () => {},
    { lock, now: () => 11 * 60 * 1000 })
  assert.equal(got.lockReclaimed, true)
  assert.equal(got.created, true)
  assert.deepEqual(log.filter(line => line.startsWith('acquire') || line.startsWith('release')),
    [`release ${LOCK}`, `acquire ${LOCK}`, `release ${LOCK}`])
})

test('a contended `worktree add` re-checks existence instead of repeating the write', async () => {
  const log = []
  const lock = memLock({}, log)
  const listings = ['worktree /repo\n', 'worktree /repo\n\nworktree /wt\n']
  const git = async (args) => {
    const joined = args.join(' ')
    log.push(joined)
    if (joined.includes('worktree list')) return listings.shift() ?? 'worktree /repo\n\nworktree /wt\n'
    if (joined.includes('worktree add')) throw new Error("fatal: cannot lock ref 'refs/heads/m1/task-9'")
    if (joined.includes('rev-list')) return '0\n'
    return ''
  }
  const got = await prepare(opts(), git, ghNone, async () => {}, { lock })
  assert.equal(got.created, false)
  assert.equal(log.filter(line => line.includes('worktree add')).length, 1)
  assert.equal(lock.state.holder, null)
})

test('a non-contention `worktree add` failure is not retried', async () => {
  const log = []
  const lock = memLock({}, log)
  const git = async (args) => {
    const joined = args.join(' ')
    log.push(joined)
    if (joined.includes('worktree add')) throw new Error("fatal: '/wt' already exists")
    return ''
  }
  await assert.rejects(() => prepare(opts(), git, ghNone, async () => {}, { lock }), /'\/wt' already exists/)
  assert.equal(log.filter(line => line.includes('worktree add')).length, 1)
})

test('two concurrent dispatches serialize: one creates, the other finds', async () => {
  // The bug this whole file exists for: both calls read "no worktree" and both
  // add. The shared memLock makes the check-and-create section exclusive.
  const log = []
  const lock = memLock({}, log)
  const world = { added: false }
  const git = async (args) => {
    const joined = args.join(' ')
    log.push(joined)
    if (joined.includes('worktree list')) return world.added ? 'worktree /repo\n\nworktree /wt\n' : 'worktree /repo\n'
    if (joined.includes('worktree add')) { world.added = true; return '' }
    if (joined.includes('rev-list')) return '0\n'
    return ''
  }
  // A macrotask, so the holder's microtask chain always finishes between the
  // waiter's attempts.
  const wait = () => new Promise(resolve => setImmediate(resolve))

  const results = await Promise.all([
    prepare(opts(), git, ghNone, wait, { lock }),
    prepare(opts(), git, ghNone, wait, { lock }),
  ])

  assert.equal(log.filter(line => line.includes('worktree add')).length, 1)
  const creator = results.find(r => r.created === true)
  const finder = results.find(r => r.created === false)
  assert.ok(creator, `expected exactly one creator: ${JSON.stringify(results)}`)
  assert.ok(finder, `expected exactly one finder: ${JSON.stringify(results)}`)
  assert.equal(finder.worktreeExisted, true)
  assert.equal(lock.state.holder, null)
})
