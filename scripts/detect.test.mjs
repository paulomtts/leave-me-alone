// Tests for the deterministic census. The `gh` calls sit behind an injectable
// runner, so everything here runs against the real logic with no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, parseNdjson, filterPullRequests, jsonFrom, lastLine, detect } from './detect.mjs'

// A fake `gh`: matches on a distinctive fragment of the argv it is given.
const fakeGh = (routes, log = []) => {
  const run = async (args) => {
    log.push(args)
    const joined = args.join(' ')
    for (const [needle, reply] of routes) {
      if (joined.includes(needle)) {
        if (reply instanceof Error) throw reply
        return typeof reply === 'string' ? reply : JSON.stringify(reply)
      }
    }
    throw new Error(`unrouted gh call: ${joined}`)
  }
  run.log = log
  return run
}

const BASE_ROUTES = [
  ['milestones/12', 'Sprint one\n'],
  ['issue list', [{ number: 40, title: 'CSV writer', state: 'OPEN' }]],
  ['blockedBy', { data: { repository: { issue: { blockedBy: { nodes: [] } } } } }],
  ['issues/40/sub_issues', [
    { number: 41, title: '40.1 rows', state: 'open' },
    { number: 42, title: '40.2 quoting', state: 'open' },
  ]],
  ['pulls?state=all', '{"number":7,"url":"u7","state":"open","merged_at":null,"ref":"m12/task-41","base":"main"}\n'],
]

const opts = (run) => ({ repo: 'you/thing', milestone: 12, labels: { story: 'story', subtask: 'subtask' }, run })

// ── parseArgs ────────────────────────────────────────────────────────────────

test('parses both --flag value and --flag=value', () => {
  assert.equal(parseArgs(['--repo', 'a/b', '--milestone', '12']).repo, 'a/b')
  assert.equal(parseArgs(['--repo=a/b', '--milestone=12']).milestone, 12)
})

test('--compact is a bare flag, not a value flag', () => {
  const got = parseArgs(['--repo=a/b', '--milestone=1', '--compact'])
  assert.equal(got.compact, true)
  assert.equal(got.milestone, 1)
  // It must not swallow the next argument as its value.
  assert.equal(parseArgs(['--repo=a/b', '--compact', '--milestone=1']).milestone, 1)
})

test('labels default, and are overridable', () => {
  assert.deepEqual(parseArgs(['--repo=a/b', '--milestone=1']).labels, { story: 'story', subtask: 'subtask' })
  assert.equal(parseArgs(['--repo=a/b', '--milestone=1', '--story-label=epic']).labels.story, 'epic')
})

test('bad input fails at the door, not mid-census', () => {
  assert.throws(() => parseArgs(['--milestone=1']), /--repo/)
  assert.throws(() => parseArgs(['--repo=a/b']), /--milestone/)
  assert.throws(() => parseArgs(['--repo=notarepo', '--milestone=1']), /--repo/)
  assert.throws(() => parseArgs(['--repo=a/b', '--milestone=0']), /--milestone/)
  assert.throws(() => parseArgs(['--repo=a/b', '--milestone=1', '--wat']), /unknown argument/)
})

// ── parseNdjson ──────────────────────────────────────────────────────────────

test('one object per line, blank lines ignored', () => {
  assert.deepEqual(parseNdjson('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }])
  assert.deepEqual(parseNdjson(''), [])
  assert.deepEqual(parseNdjson(null), [])
})

// ── filterPullRequests ───────────────────────────────────────────────────────

test('the filter is loose on purpose — over-report, never under-report', () => {
  const pulls = [{ ref: 'm12/task-41' }, { ref: 'aq-41' }, { ref: 'wip/41-hotfix' }, { ref: 'task-99' }]
  const kept = filterPullRequests(pulls, [41])
  assert.deepEqual(kept.map(p => p.ref), ['m12/task-41', 'aq-41', 'wip/41-hotfix'])
})

test('the filter never decides — exactness is the orchestrator\'s job', () => {
  // task-411 is kept even though it belongs to a different subtask. Dropping it
  // here would hide it from the near-miss check that catches a prefix change.
  assert.equal(filterPullRequests([{ ref: 'task-411' }], [41]).length, 1)
})

test('no subtasks means no pull requests', () => {
  assert.deepEqual(filterPullRequests([{ ref: 'task-41' }], []), [])
  assert.deepEqual(filterPullRequests(null, [41]), [])
})

// ── detect ───────────────────────────────────────────────────────────────────

test('builds the census the orchestrator expects', async () => {
  const got = await detect(opts(fakeGh(BASE_ROUTES)))
  assert.equal(got.milestoneTitle, 'Sprint one')
  assert.equal(got.stories.length, 1)
  assert.deepEqual(got.stories[0].blockedBy, [])
  assert.deepEqual(got.stories[0].subtasks.map(s => s.number), [41, 42])
  assert.equal(got.stories[0].subtasks[0].state, 'OPEN')   // normalized from "open"
  assert.equal(got.prLookupFailed, false)
  assert.equal(got.pullRequests[0].ref, 'm12/task-41')
})

test('sub-issue ORDER is preserved exactly — it is the stack geometry', async () => {
  const reversed = BASE_ROUTES.map(([n, r]) => n === 'issues/40/sub_issues'
    ? [n, [{ number: 42, title: '40.2 quoting', state: 'open' }, { number: 41, title: '40.1 rows', state: 'open' }]]
    : [n, r])
  const got = await detect(opts(fakeGh(reversed)))
  // Reported in endpoint order; the orchestrator re-sorts by title ordinal.
  assert.deepEqual(got.stories[0].subtasks.map(s => s.number), [42, 41])
  assert.deepEqual(got.stories[0].subtasks.map(s => s.title), ['40.2 quoting', '40.1 rows'])
})

test('blockedBy edges are read, not invented', async () => {
  const withEdge = BASE_ROUTES.map(([n, r]) => n === 'blockedBy'
    ? [n, { data: { repository: { issue: { blockedBy: { nodes: [{ number: 39 }] } } } } }] : [n, r])
  const got = await detect(opts(fakeGh(withEdge)))
  assert.deepEqual(got.stories[0].blockedBy, [39])
})

test('a FAILED dependency query stops the run rather than reporting no deps', async () => {
  // [] means "genuinely independent". An error means "we do not know", and
  // letting those collapse is how every story lands at level 0 at once.
  const broken = BASE_ROUTES.map(([n, r]) => n === 'blockedBy' ? [n, new Error('502')] : [n, r])
  await assert.rejects(() => detect(opts(fakeGh(broken))), /502/)
})

test('a failed PR listing sets prLookupFailed, NOT an empty list', async () => {
  const broken = BASE_ROUTES.map(([n, r]) => n === 'pulls?state=all' ? [n, new Error('no server available')] : [n, r])
  const got = await detect(opts(fakeGh(broken)))
  assert.equal(got.prLookupFailed, true)
  assert.deepEqual(got.pullRequests, [])
  // The stories still came back — a PR outage does not erase the census.
  assert.equal(got.stories.length, 1)
})

test('the PR listing is retried three times before giving up', async () => {
  const log = []
  const broken = BASE_ROUTES.map(([n, r]) => n === 'pulls?state=all' ? [n, new Error('502')] : [n, r])
  await detect(opts(fakeGh(broken, log)))
  assert.equal(log.filter(args => args.join(' ').includes('pulls?state=all')).length, 3)
})

test('it uses the REST pulls endpoint, never `gh pr list`', async () => {
  // gh pr list goes through GraphQL, which reported merged PRs as absent
  // during the 2026-08-17 incident. REST kept answering.
  const log = []
  await detect(opts(fakeGh(BASE_ROUTES, log)))
  assert.equal(log.some(args => args[0] === 'pr' && args[1] === 'list'), false)
  assert.equal(log.some(args => args.join(' ').includes('pulls?state=all')), true)
})

test('an empty milestone title is a hard stop', async () => {
  const blank = BASE_ROUTES.map(([n, r]) => n === 'milestones/12' ? [n, '\n'] : [n, r])
  await assert.rejects(() => detect(opts(fakeGh(blank))), /wrong number or wrong repo/)
})

// ── tool-manager banners in stdout ───────────────────────────────────────────
// The first real run of this script died on a line mise printed into stdout
// while resolving `gh`. Not mise-specific -- direnv and nvm do it too.

const BANNER = 'mise ~/.config/mise/config.toml tools: gh@2.97.0\n'

test('JSON is parsed from the first structural character, not byte zero', () => {
  assert.deepEqual(jsonFrom(`${BANNER}{"a":1}`), { a: 1 })
  assert.deepEqual(jsonFrom(`${BANNER}[{"a":1}]`), [{ a: 1 }])
  assert.deepEqual(jsonFrom('{"a":1}'), { a: 1 })
})

test('output with no JSON at all reports what it actually saw', () => {
  // The failure mode to avoid is "Unexpected token m", which tells you nothing.
  assert.throws(() => jsonFrom(BANNER), /expected JSON, got: mise/)
  assert.throws(() => jsonFrom(''), /\(empty\)/)
})

test('plain-text output takes the LAST line, below any banner', () => {
  assert.equal(lastLine(`${BANNER}Sprint one\n`), 'Sprint one')
  assert.equal(lastLine('Sprint one'), 'Sprint one')
  assert.equal(lastLine(''), '')
})

test('NDJSON skips banner lines instead of throwing on them', () => {
  assert.deepEqual(parseNdjson(`${BANNER}{"a":1}\n{"a":2}\n`), [{ a: 1 }, { a: 2 }])
})

test('a full census survives a banner on every single call', async () => {
  const noisy = BASE_ROUTES.map(([needle, reply]) => [
    needle,
    typeof reply === 'string' ? BANNER + reply : BANNER + JSON.stringify(reply),
  ])
  const got = await detect(opts(fakeGh(noisy)))
  assert.equal(got.milestoneTitle, 'Sprint one')
  assert.equal(got.stories[0].subtasks.length, 2)
  assert.equal(got.pullRequests[0].ref, 'm12/task-41')
})

// ── prepareCheckout ──────────────────────────────────────────────────────────

test('the shared checkout is refreshed ONCE, here, not inside every subtask', async () => {
  // `worktree prune` is a global sweep: it removes registrations whose
  // directories are missing. Run from inside Implement, with several stories in
  // flight against one .git, one lane can prune another lane's worktree in the
  // window between `worktree add` registering it and the directory appearing.
  const log = []
  const got = await detect({ ...opts(fakeGh(BASE_ROUTES)), repoDir: '/abs/repo',
    git: async (args) => { log.push(args.join(' ')); return '' } })
  assert.equal(got.prepared, true)
  assert.deepEqual(log, ['-C /abs/repo fetch origin', '-C /abs/repo worktree prune'])
})

test('the fetch happens BEFORE the census, not after', async () => {
  const order = []
  await detect({
    repo: 'you/thing', milestone: 12, labels: { story: 'story', subtask: 'subtask' }, repoDir: '/abs/repo',
    run: async (args) => { order.push('gh'); return fakeGh(BASE_ROUTES)(args) },
    git: async () => { order.push('git'); return '' },
  })
  assert.equal(order[0], 'git', 'the checkout must be current before anything is read')
})

test('without --repo-dir nothing touches the checkout', async () => {
  // Standalone use: inspecting a board should never mutate a working copy.
  const log = []
  const got = await detect({ ...opts(fakeGh(BASE_ROUTES)), git: async (a) => { log.push(a); return '' } })
  assert.equal(got.prepared, false)
  assert.deepEqual(log, [])
})

test('--repo-dir must be absolute', () => {
  assert.equal(parseArgs(['--repo=a/b', '--milestone=1', '--repo-dir=/r']).repoDir, '/r')
  assert.equal(parseArgs(['--repo=a/b', '--milestone=1']).repoDir, undefined)
  assert.throws(() => parseArgs(['--repo=a/b', '--milestone=1', '--repo-dir=rel']), /absolute/)
})

test('a flaky fetch is retried — it is the first network call of the run', async () => {
  // An HTTP2 framing error here killed a milestone at Detect, before any
  // subtask was dispatched, while the same class of failure on the PR listing
  // was already absorbed three attempts deep.
  let attempts = 0
  const git = async (args) => {
    if (args.includes('fetch')) { attempts += 1; if (attempts < 3) throw new Error('HTTP2 framing layer') }
    return ''
  }
  const got = await detect({ ...opts(fakeGh(BASE_ROUTES)), repoDir: '/abs/repo', git })
  assert.equal(got.prepared, true)
  assert.equal(attempts, 3)
})

test('a fetch that never recovers still fails the run', async () => {
  const git = async (args) => { if (args.includes('fetch')) throw new Error('no network'); return '' }
  await assert.rejects(() => detect({ ...opts(fakeGh(BASE_ROUTES)), repoDir: '/abs/repo', git }), /no network/)
})

test('worktree prune is NOT retried — a failure there is the checkout, not the network', async () => {
  let pruneAttempts = 0
  const git = async (args) => {
    if (args.includes('prune')) { pruneAttempts += 1; throw new Error('locked') }
    return ''
  }
  await assert.rejects(() => detect({ ...opts(fakeGh(BASE_ROUTES)), repoDir: '/abs/repo', git }), /locked/)
  assert.equal(pruneAttempts, 1)
})
