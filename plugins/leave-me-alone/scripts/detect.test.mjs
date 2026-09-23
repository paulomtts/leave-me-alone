// Tests for the deterministic census. The `gh` calls sit behind an injectable
// runner, so everything here runs against the real logic with no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, detect } from './detect.mjs'
import { parseNdjson, jsonFrom, lastLine } from './gh.mjs'
import { shortId } from './naming.mjs'

const MILESTONE_ID = 'aaaaaaaa-0000-4000-8000-000000000000'
const STORY_ID = 'bbbbbbbb-0000-4000-8000-000000000000'
const SUB_ID = 'cccccccc-0000-4000-8000-000000000000'

const TREE = {
  ok: true,
  data: [{
    id: MILESTONE_ID, title: 'Sprint one', status: 'todo', blocked_by: [],
    created_at: '2026-01-01T00:00:00Z',
    children: [{
      id: STORY_ID, title: 'CSV writer', status: 'todo', blocked_by: [],
      created_at: '2026-01-02T00:00:00Z',
      children: [{
        id: SUB_ID, title: 'write rows', status: 'todo', blocked_by: [],
        created_at: '2026-01-03T00:00:00Z', children: [],
      }],
    }],
  }],
}

const fakeBrd = () => async () => JSON.stringify(TREE)

// ── parseArgs ────────────────────────────────────────────────────────────────

test('parseArgs takes a milestone as a title or an id, not an integer', () => {
  assert.equal(parseArgs(['--repo', 'a/b', '--milestone', 'Sprint one']).milestone, 'Sprint one')
  assert.equal(parseArgs(['--repo=a/b', `--milestone=${MILESTONE_ID}`]).milestone, MILESTONE_ID)
})

test('--compact is a bare flag, not a value flag', () => {
  const got = parseArgs(['--repo=a/b', '--milestone=Sprint one', '--compact'])
  assert.equal(got.compact, true)
  assert.equal(got.milestone, 'Sprint one')
})

test('parseArgs rejects an empty milestone', () => {
  assert.throws(() => parseArgs(['--repo', 'a/b', '--milestone', '']), /needs --milestone/)
})

test('bad input fails at the door, not mid-census', () => {
  assert.throws(() => parseArgs(['--milestone=1']), /--repo/)
  assert.throws(() => parseArgs(['--repo=a/b']), /--milestone/)
  assert.throws(() => parseArgs(['--repo=notarepo', '--milestone=1']), /--repo/)
  assert.throws(() => parseArgs(['--repo=a/b', '--milestone=1', '--wat']), /unknown argument/)
})

// ── parseNdjson ──────────────────────────────────────────────────────────────

test('one object per line, blank lines ignored', () => {
  assert.deepEqual(parseNdjson('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }])
  assert.deepEqual(parseNdjson(''), [])
  assert.deepEqual(parseNdjson(null), [])
})

// ── detect ───────────────────────────────────────────────────────────────────

test('detect returns no pull-request fields at all — the census is brd alone', async () => {
  const runBrd = async () => JSON.stringify({ ok: true, data: [
    { id: 'a1b2c3d4-0000-0000-0000-000000000000', title: 'M', parent_id: null, status: 'todo', blocked_by: [], children: [] },
  ] })
  const result = await detect({ repo: 'o/n', milestone: 'M', repoDir: null, runBrd })
  assert.equal('pullRequests' in result, false)
  assert.equal('prLookupFailed' in result, false)
})

test('brd is invoked exactly once — brd calls are never retried', async () => {
  // Stated global invariant: a brd failure is real and local, so calling it more
  // than once would silently paper over that.
  let calls = 0
  const runBrd = async () => { calls += 1; return JSON.stringify(TREE) }
  await detect({ repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    runBrd, git: async () => '' })
  assert.equal(calls, 1)
})

test('a brd failure stops the run instead of yielding an empty milestone', async () => {
  const failing = async () => '{"ok": false, "error": {"type": "ProjectNotFoundError", "message": "no .brd marker found above /abs/repo"}}'
  await assert.rejects(
    detect({ repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
      runBrd: failing, git: async () => '' }),
    /ProjectNotFoundError/)
})

test('a malformed card id aborts the run', async () => {
  const brokenTree = JSON.parse(JSON.stringify(TREE))
  brokenTree.data[0].children[0].children[0].id = 'not-a-uuid'
  await assert.rejects(
    detect({ repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
      runBrd: async () => JSON.stringify(brokenTree), git: async () => '' }),
    /not a card id/)
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

// ── prepareCheckout ──────────────────────────────────────────────────────────

test('the shared checkout is refreshed ONCE, here, not inside every subtask', async () => {
  // `worktree prune` is a global sweep: it removes registrations whose
  // directories are missing. Run from inside Implement, with several stories in
  // flight against one .git, one lane can prune another lane's worktree in the
  // window between `worktree add` registering it and the directory appearing.
  const log = []
  const got = await detect({
    repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    runBrd: fakeBrd(),
    git: async (args) => {
      log.push(args.join(' '))
      return args.includes('remote') ? 'origin\n' : ''
    } })
  assert.equal(got.prepared, true)
  assert.deepEqual(log, [
    '-C /abs/repo remote',
    '-C /abs/repo fetch origin',
    '-C /abs/repo worktree prune',
  ])
})

test('a fully local repo (no origin remote) skips the fetch but still prunes', async () => {
  // A fully local repo (no remote at all) has nothing for `git fetch origin`
  // to reach — that used to fail the whole run before a single subtask was
  // dispatched. The prune must still run; it is always local and safe.
  const log = []
  const got = await detect({
    repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    runBrd: fakeBrd(),
    git: async (args) => { log.push(args.join(' ')); return '' } })
  assert.equal(got.prepared, true)
  assert.deepEqual(log, ['-C /abs/repo remote', '-C /abs/repo worktree prune'])
})

test('the fetch happens BEFORE the census, not after', async () => {
  const order = []
  await detect({
    repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    runBrd: async () => { order.push('brd'); return JSON.stringify(TREE) },
    git: async () => { order.push('git'); return '' },
  })
  assert.equal(order[0], 'git', 'the checkout must be current before anything is read')
})

test('without --repo-dir nothing touches the checkout', async () => {
  // Standalone use: inspecting a board should never mutate a working copy.
  const log = []
  const got = await detect({
    repo: 'you/thing', milestone: 'Sprint one',
    runBrd: fakeBrd(), git: async (a) => { log.push(a); return '' } })
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
  // subtask was dispatched.
  let attempts = 0
  const git = async (args) => {
    if (args.includes('remote')) return 'origin\n'
    if (args.includes('fetch')) { attempts += 1; if (attempts < 3) throw new Error('HTTP2 framing layer') }
    return ''
  }
  const got = await detect({
    repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    runBrd: fakeBrd(), git, wait: () => Promise.resolve() })
  assert.equal(got.prepared, true)
  assert.equal(attempts, 3)
})

test('a fetch that never recovers still fails the run', async () => {
  const git = async (args) => {
    if (args.includes('remote')) return 'origin\n'
    if (args.includes('fetch')) throw new Error('no network')
    return ''
  }
  await assert.rejects(() => detect({
    repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    runBrd: fakeBrd(), git, wait: () => Promise.resolve() }), /no network/)
})

test('worktree prune is NOT retried — a failure there is the checkout, not the network', async () => {
  let pruneAttempts = 0
  const git = async (args) => {
    if (args.includes('prune')) { pruneAttempts += 1; throw new Error('locked') }
    return ''
  }
  await assert.rejects(() => detect({
    repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    runBrd: fakeBrd(), git, wait: () => Promise.resolve() }), /locked/)
  assert.equal(pruneAttempts, 1)
})
