// Tests for orchestrator.js's decision logic — the DAG, doneness, and the
// stacked-PR geometry. These run against the real source: loadPure() slices the
// PURE:BEGIN/PURE:END region out of orchestrator.js and evaluates it, so there
// is no second copy to drift out of sync.
//
// This is the only part of the pipeline covered by tests rather than by a live
// run, which is exactly why it is worth covering: it decides what gets
// dispatched, in what order, and onto which branch.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadPure } from './load-pure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const {
  orderSubtasks, isSubtaskDone, remainingSubtasks, computeLevels,
  assertNoBlockerCycles, storyRoot, stackBases, escalation,
  prMatchesSubtask, matchPr, attachPullRequests, dropCommandsNamingMissingPaths,
} = await loadPure(join(HERE, 'orchestrator.js'), [
  'orderSubtasks', 'isSubtaskDone', 'remainingSubtasks', 'computeLevels',
  'assertNoBlockerCycles', 'subtaskBranch', 'storyTip', 'storyRoot', 'stackBases', 'escalation',
  'prMatchesSubtask', 'normalizePr', 'matchPr', 'attachPullRequests',
  'dropCommandsNamingMissingPaths',
])

const PREFIX = 'task-'
const PAT = '^[A-Za-z]?\\d+(?:\\.\\d+)*\\.(\\d+)\\b'
const BASE = 'main'

const sub = (n, title, pr = null, state = 'OPEN') => ({ number: n, title, state, pr })
const openPr = (n, ref, base = 'main') => ({ number: n, state: 'OPEN', merged: false, ref, base })
const mk = stories => new Map(stories.map(s => [s.number, s]))

// ── ordering ────────────────────────────────────────────────────────────────

test('with no ordinal-tagged titles, endpoint order IS the order', () => {
  const list = [sub(7, 'do this'), sub(3, 'then this'), sub(9, 'finally')]
  assert.deepEqual(orderSubtasks(list, PAT).map(s => s.number), [7, 3, 9])
})

test('ordinal-tagged titles sort by ordinal, not issue number', () => {
  const list = [sub(50, '4.3 third'), sub(10, '4.1 first'), sub(30, '4.2 second')]
  assert.deepEqual(orderSubtasks(list, PAT).map(s => s.number), [10, 30, 50])
})

test('untagged subtasks sink to the end but keep relative order', () => {
  const list = [sub(1, 'loose'), sub(2, '4.1 tagged'), sub(3, 'also loose')]
  assert.deepEqual(orderSubtasks(list, PAT).map(s => s.number), [2, 1, 3])
})

// ── doneness (stacked mode: an open PR means DONE) ──────────────────────────

test('an OPEN PR counts as done — nothing merges in stacked mode', () => {
  assert.equal(isSubtaskDone(sub(1, 'x', openPr(9, 'task-1'))), true)
})

test('a closed issue with NO PR ever found counts as done', () => {
  assert.equal(isSubtaskDone(sub(1, 'x', null, 'CLOSED')), true)
})

test('an open issue with no PR is NOT done', () => {
  assert.equal(isSubtaskDone(sub(1, 'x', null, 'OPEN')), false)
})

test("a rejected wrong-base PR is NOT done, even on a closed issue", () => {
  // The sentinel is a string, not an object — this is the #1133 guard, and it
  // matters more now that an open PR alone counts as done.
  assert.equal(isSubtaskDone(sub(1, 'x', 'wrong-base', 'CLOSED')), false)
  assert.equal(isSubtaskDone(sub(1, 'x', 'wrong-base', 'OPEN')), false)
})

test('remainingSubtasks drops done ones and skips a CLOSED story entirely', () => {
  const story = { number: 100, state: 'OPEN', blockedBy: [], subtasks: [sub(1, '1.1 a', openPr(9, 'task-1')), sub(2, '1.2 b')] }
  assert.deepEqual(remainingSubtasks(story, PAT).map(s => s.number), [2])
  assert.deepEqual(remainingSubtasks({ ...story, state: 'CLOSED' }, PAT), [])
})

// ── levels ──────────────────────────────────────────────────────────────────

test('independent stories land in one level; a blocked story in the next', () => {
  const A = { number: 100, state: 'OPEN', blockedBy: [], subtasks: [sub(1, '1.1 a')] }
  const B = { number: 200, state: 'OPEN', blockedBy: [100], subtasks: [sub(2, '2.1 b')] }
  const C = { number: 300, state: 'OPEN', blockedBy: [], subtasks: [sub(3, '3.1 c')] }
  const levels = computeLevels([A, B, C], PAT)
  assert.deepEqual(levels.map(l => l.map(s => s.number)), [[100, 300], [200]])
})

test('a story whose blocker has no remaining work is unblocked immediately', () => {
  const A = { number: 100, state: 'OPEN', blockedBy: [], subtasks: [sub(1, '1.1 a', openPr(9, 'task-1'))] }
  const B = { number: 200, state: 'OPEN', blockedBy: [100], subtasks: [sub(2, '2.1 b')] }
  assert.deepEqual(computeLevels([A, B], PAT).map(l => l.map(s => s.number)), [[200]])
})

// ── cycles ──────────────────────────────────────────────────────────────────

test('assertNoBlockerCycles catches a two-story cycle and names it', () => {
  const A = { number: 100, blockedBy: [200], subtasks: [sub(1, '1.1 a')] }
  const B = { number: 200, blockedBy: [100], subtasks: [sub(2, '2.1 b')] }
  assert.throws(() => assertNoBlockerCycles([A, B]), /cycle among stories .*#100/)
})

test('assertNoBlockerCycles catches a three-story cycle', () => {
  const A = { number: 100, blockedBy: [300], subtasks: [] }
  const B = { number: 200, blockedBy: [100], subtasks: [] }
  const C = { number: 300, blockedBy: [200], subtasks: [] }
  assert.throws(() => assertNoBlockerCycles([A, B, C]), /cycle/)
})

test('assertNoBlockerCycles allows a diamond (shared blocker, no cycle)', () => {
  const A = { number: 100, blockedBy: [], subtasks: [] }
  const B = { number: 200, blockedBy: [100], subtasks: [] }
  const C = { number: 300, blockedBy: [100], subtasks: [] }
  assert.doesNotThrow(() => assertNoBlockerCycles([A, B, C]))
})

test('storyRoot alone does NOT detect a cycle between populated stories', () => {
  // Documents a real limitation rather than papering over it: storyTip returns
  // a branch immediately when a story has subtasks, so the recursion never
  // comes back to trip storyRoot's `seen` guard. assertNoBlockerCycles is what
  // actually protects this, and it runs first.
  const A = { number: 100, blockedBy: [200], subtasks: [sub(1, '1.1 a')] }
  const B = { number: 200, blockedBy: [100], subtasks: [sub(2, '2.1 b')] }
  assert.equal(storyRoot(A, mk([A, B]), PREFIX, PAT, BASE), 'task-2')
})

// ── stack geometry ──────────────────────────────────────────────────────────

test('a story with no blockers roots at the milestone base and stacks on itself', () => {
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a'), sub(2, '1.2 b'), sub(3, '1.3 c')] }
  const bases = stackBases(A, mk([A]), PREFIX, PAT, BASE)
  assert.equal(bases.get(1), 'main')
  assert.equal(bases.get(2), 'task-1')
  assert.equal(bases.get(3), 'task-2')
})

test('a blocked story roots on its blocker TIP, not on the base', () => {
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a'), sub(2, '1.2 b')] }
  const B = { number: 200, blockedBy: [100], subtasks: [sub(5, '2.1 x'), sub(6, '2.2 y')] }
  const by = mk([A, B])
  assert.equal(storyRoot(B, by, PREFIX, PAT, BASE), 'task-2')
  const bases = stackBases(B, by, PREFIX, PAT, BASE)
  assert.equal(bases.get(5), 'task-2')
  assert.equal(bases.get(6), 'task-5')
})

test('a DONE predecessor still supplies the base (full list, not remaining)', () => {
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a', openPr(9, 'task-1')), sub(2, '1.2 b')] }
  assert.equal(stackBases(A, mk([A]), PREFIX, PAT, BASE).get(2), 'task-1')
})

test('a DONE blocker still supplies its tip — done does not mean landed', () => {
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a', openPr(9, 'task-1'))] }
  const B = { number: 200, blockedBy: [100], subtasks: [sub(2, '2.1 b')] }
  assert.equal(storyRoot(B, mk([A, B]), PREFIX, PAT, BASE), 'task-1')
})

test('the geometry is derived from the graph, never from a PR head ref', () => {
  // A PR under a different name does NOT bend the stack toward itself. The
  // geometry has to be reproducible from the graph alone -- when it read head
  // refs instead, the bases depended on the PRs and the PR matching depended on
  // the bases, and that circularity produced two bugs in one afternoon.
  // matchPr() is where a stray branch gets noticed, and it halts rather than
  // quietly re-shaping the stack.
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a', openPr(9, 'aq-1')), sub(2, '1.2 b')] }
  assert.equal(stackBases(A, mk([A]), PREFIX, PAT, BASE).get(2), 'task-1')
})

test('a chain of three stories roots transitively', () => {
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a')] }
  const B = { number: 200, blockedBy: [100], subtasks: [sub(2, '2.1 b')] }
  const C = { number: 300, blockedBy: [200], subtasks: [sub(3, '3.1 c')] }
  assert.equal(storyRoot(C, mk([A, B, C]), PREFIX, PAT, BASE), 'task-2')
})

test('blockers OUTSIDE the milestone are ignored', () => {
  const A = { number: 100, blockedBy: [999], subtasks: [sub(1, '1.1 a')] }
  assert.equal(storyRoot(A, mk([A]), PREFIX, PAT, BASE), 'main')
})

test('TWO blockers refuse to guess and say why', () => {
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a')] }
  const B = { number: 200, blockedBy: [], subtasks: [sub(2, '2.1 b')] }
  const C = { number: 300, blockedBy: [100, 200], subtasks: [sub(3, '3.1 c')] }
  assert.throws(() => storyRoot(C, mk([A, B, C]), PREFIX, PAT, BASE), /blocked by 2 stories/)
})

test('a blocker with NO subtasks falls through to its own root', () => {
  const A = { number: 100, blockedBy: [], subtasks: [] }
  const B = { number: 200, blockedBy: [100], subtasks: [sub(2, '2.1 b')] }
  assert.equal(storyRoot(B, mk([A, B]), PREFIX, PAT, BASE), 'main')
})

// ── escalation ──────────────────────────────────────────────────────────────

test('escalation rejects triggers that no longer exist', () => {
  // 'conflict' died with the merge phase; accepting it would let a stale caller
  // build a payload describing a merge that never happens.
  assert.throws(() => escalation({ trigger: 'conflict', story: 1, subtask: 2, baseBranch: 'main' }), /unknown escalation trigger/)
})

test('escalation says plainly that nothing was merged', () => {
  const payload = escalation({ level: 0, story: 1, subtask: 2, pr: null, trigger: 'tests', baseBranch: 'main', attempts: [] })
  assert.equal(payload.escalated, true)
  assert.match(payload.message, /Nothing was merged/)
})

// ── prMatchesSubtask ─────────────────────────────────────────────────────────

test('a subtask number matches any prefix, and a bare number', () => {
  // The whole point: doneness survives a branch-prefix change.
  for (const ref of ['task-1050', 'aq-1050', 'wip/1050', '1050', 'feature/x-1050']) {
    assert.equal(prMatchesSubtask(ref, 1050), true, ref)
  }
})

test('a longer number that merely ENDS with the subtask number does not match', () => {
  // task-11050 is subtask 11050's branch. Matching it to 1050 would report
  // someone else's work as this subtask's, which is the #1050 bug's shape.
  assert.equal(prMatchesSubtask('task-11050', 1050), false)
  assert.equal(prMatchesSubtask('task-01050', 1050), false)
})

test('the number must be a SUFFIX, not merely present', () => {
  assert.equal(prMatchesSubtask('task-1050-followup', 1050), false)
  assert.equal(prMatchesSubtask('1050-task', 1050), false)
})

test('a missing or empty ref never matches', () => {
  for (const ref of [null, undefined, '']) assert.equal(prMatchesSubtask(ref, 1050), false)
})

// ── matchPr: exact branch, exact base ───────────────────────────────────────

const pr = (number, ref, base, over = {}) => ({ number, ref, base, url: `u/${number}`, state: 'open', ...over })

test('the PR on the derived branch and the graph-derived base is the match', () => {
  const { pr: found, note } = matchPr(14, 'task-14', 'task-13', [pr(7, 'task-14', 'task-13')])
  assert.equal(found.number, 7)
  assert.equal(found.state, 'OPEN')   // REST says "open"; downstream compares uppercase
  assert.equal(note, null)
})

test('merged_at is what makes a PR merged, not the issue being closed', () => {
  assert.equal(matchPr(14, 'task-14', 'main', [pr(7, 'task-14', 'main', { merged_at: '2026-08-19T00:00:00Z' })]).pr.merged, true)
  assert.equal(matchPr(14, 'task-14', 'main', [pr(8, 'task-14', 'main', { merged_at: null })]).pr.merged, false)
})

test('nothing matching means unstarted work, silently', () => {
  assert.deepEqual(matchPr(13, 'task-13', 'main', [pr(1, 'task-99', 'main')]), { pr: null, note: null })
  assert.deepEqual(matchPr(13, 'task-13', 'main', []), { pr: null, note: null })
  assert.deepEqual(matchPr(13, 'task-13', 'main', null), { pr: null, note: null })
})

test('a PR on the right branch but the wrong base is rejected, and is NOT no-PR', () => {
  // The #1133 bug: head task-1133, base main instead of its stack parent,
  // counted as done across many runs. 'wrong-base' is a distinct sentinel from
  // null precisely so isSubtaskDone cannot read it as finished work.
  const { pr: found, note } = matchPr(14, 'task-14', 'task-13', [pr(7, 'task-14', 'main')])
  assert.equal(found, 'wrong-base')
  assert.match(note, /base "main" is not its stack parent "task-13"/)
})

test('an unreported base is unverifiable — it halts rather than guesses', () => {
  const { pr: found, note } = matchPr(14, 'task-14', 'task-13', [pr(7, 'task-14', '')])
  assert.equal(found, 'unknown')
  assert.match(note, /reported no base branch/)
})

test('ranking applies only WITHIN the right branch and base', () => {
  // It can never override either, so a merged PR on the wrong base cannot win.
  const pulls = [pr(9, 'task-14', 'main', { merged_at: '2026-08-01T00:00:00Z' }), pr(4, 'task-14', 'task-13')]
  assert.equal(matchPr(14, 'task-14', 'task-13', pulls).pr.number, 4)

  const both = [pr(4, 'task-14', 'task-13'), pr(3, 'task-14', 'task-13', { merged_at: '2026-08-01T00:00:00Z' })]
  assert.equal(matchPr(14, 'task-14', 'task-13', both).pr.number, 3)
})

// ── near misses: the branchPrefix changed ────────────────────────────────────

test('a MERGED PR under another name halts instead of re-implementing it', () => {
  // #1050: the prefix changed between runs, exact matching found nothing, and
  // finished work was re-dispatched onto an empty diff. Derived naming brings
  // that risk back, so it is met head-on: stop and name the likely cause.
  const { pr: found, note } = matchPr(13, 'task-13', 'main',
    [pr(20, 'aq-13', 'main', { merged_at: '2026-08-01T00:00:00Z' })])
  assert.equal(found, 'unknown')
  assert.match(note, /MERGED PR #20 on branch "aq-13"/)
  assert.match(note, /branchPrefix/)
})

test('an UNMERGED near miss is reported but does not halt the milestone', () => {
  // A human branch that happens to end in the number, or an abandoned attempt.
  // Loud, but not worth stopping a milestone for.
  const { pr: found, note } = matchPr(13, 'task-13', 'main', [pr(21, 'wip/13', 'main')])
  assert.equal(found, null)
  assert.match(note, /ignoring unmerged PR #21 on "wip\/13"/)
})

test('a longer number is not a near miss', () => {
  // task-113 belongs to subtask 113, not 13. Treating it as a near miss would
  // halt milestones over unrelated work.
  assert.deepEqual(matchPr(13, 'task-13', 'main',
    [pr(20, 'task-113', 'main', { merged_at: '2026-08-01T00:00:00Z' })]), { pr: null, note: null })
})

// ── dropCommandsNamingMissingPaths ───────────────────────────────────────────

test('commands survive when nothing is missing', () => {
  const { kept, dropped } = dropCommandsNamingMissingPaths(['npm test', 'npm run lint'], [])
  assert.deepEqual(kept, ['npm test', 'npm run lint'])
  assert.deepEqual(dropped, [])
})

test('a command naming an absent path is dropped, and says which path', () => {
  // Bug two: a suite command naming a test file that exists only on another
  // branch. Every worktree is cut from origin/<base>, so it crashed there.
  const { kept, dropped } = dropCommandsNamingMissingPaths(
    ['node --test workflows/orchestrator.test.mjs', 'npm test'],
    ['workflows/orchestrator.test.mjs'])
  assert.deepEqual(kept, ['npm test'])
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].path, 'workflows/orchestrator.test.mjs')
})

test('dropping EVERY command is reported, never silently returned as green', () => {
  // Bug three: the over-correction. An empty kept list with a non-empty dropped
  // list is the signature the caller warns on -- the two must stay
  // distinguishable from "this repo documented nothing at all".
  const wiped = dropCommandsNamingMissingPaths(['node --test a.mjs'], ['a.mjs'])
  assert.deepEqual(wiped.kept, [])
  assert.equal(wiped.dropped.length, 1)

  const nothingFound = dropCommandsNamingMissingPaths([], ['a.mjs'])
  assert.deepEqual(nothingFound.kept, [])
  assert.deepEqual(nothingFound.dropped, [])
})

test('blank commands and blank missing paths are ignored, not matched', () => {
  // An empty-string path would substring-match EVERY command and wipe the suite.
  const { kept, dropped } = dropCommandsNamingMissingPaths(['npm test', '', '  '], ['', '   ', null])
  assert.deepEqual(kept, ['npm test'])
  assert.deepEqual(dropped, [])
})

test('missing/absent inputs are handled without throwing', () => {
  assert.deepEqual(dropCommandsNamingMissingPaths(undefined, undefined), { kept: [], dropped: [] })
  assert.deepEqual(dropCommandsNamingMissingPaths(null, null), { kept: [], dropped: [] })
})

// ── attachPullRequests ──────────────────────────────────────────────────────

const attach = (stories, pulls, failed = false) =>
  attachPullRequests(stories, pulls, failed, PREFIX, PAT, BASE)

test('every branch and base comes from the graph, with no PR consulted', () => {
  const story = { number: 1, blockedBy: [], subtasks: [
    { number: 13, title: '1.1 first', state: 'OPEN' },
    { number: 14, title: '1.2 second', state: 'OPEN' },
  ] }
  const notes = attach([story], [
    { number: 20, ref: 'task-13', base: 'main', merged_at: null, state: 'open' },
    { number: 21, ref: 'task-14', base: 'task-13', merged_at: null, state: 'open' },
  ])
  assert.deepEqual(notes, [])
  assert.equal(story.subtasks[0].pr.number, 20)
  assert.equal(story.subtasks[1].pr.number, 21)
})

test('a whole stack built under an older prefix halts on its first merged PR', () => {
  const story = { number: 1, blockedBy: [], subtasks: [
    { number: 13, title: '1.1 first', state: 'CLOSED' },
    { number: 14, title: '1.2 second', state: 'OPEN' },
  ] }
  const notes = attach([story], [
    { number: 20, ref: 'aq-13', base: 'main', merged_at: '2026-08-01T00:00:00Z', state: 'closed' },
    { number: 21, ref: 'aq-14', base: 'aq-13', merged_at: null, state: 'open' },
  ])
  assert.equal(story.subtasks[0].pr, 'unknown')
  assert.match(notes[0], /branchPrefix/)
})

test('the first subtask of a blocked story roots on its blocker tip', () => {
  const a = { number: 1, blockedBy: [], subtasks: [{ number: 13, title: '1.1 a', state: 'OPEN' }] }
  const b = { number: 2, blockedBy: [1], subtasks: [{ number: 15, title: '2.1 b', state: 'OPEN' }] }
  attach([a, b], [
    { number: 20, ref: 'task-13', base: 'main', merged_at: null, state: 'open' },
    { number: 22, ref: 'task-15', base: 'task-13', merged_at: null, state: 'open' },
  ])
  assert.equal(b.subtasks[0].pr.number, 22)
})

test('a failed lookup marks every subtask unknown and rejects nothing', () => {
  const story = { number: 1, blockedBy: [], subtasks: [
    { number: 13, title: '1.1 a', state: 'OPEN' }, { number: 14, title: '1.2 b', state: 'OPEN' },
  ] }
  const notes = attach([story], [], true)
  assert.deepEqual(notes, [])
  assert.deepEqual(story.subtasks.map(s => s.pr), ['unknown', 'unknown'])
})

test('multi-blocker shapes throw even when the PR lookup failed', () => {
  // The shape is a human decision and must surface regardless of API health.
  const a = { number: 1, blockedBy: [], subtasks: [{ number: 13, title: '1.1 a', state: 'OPEN' }] }
  const b = { number: 2, blockedBy: [], subtasks: [{ number: 14, title: '2.1 b', state: 'OPEN' }] }
  const c = { number: 3, blockedBy: [1, 2], subtasks: [{ number: 15, title: '3.1 c', state: 'OPEN' }] }
  assert.throws(() => attach([a, b, c], [], true), /blocked by 2 stories/)
})
