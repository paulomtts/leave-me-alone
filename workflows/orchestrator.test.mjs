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
  prMatchesSubtask, candidatePrs, selectPr, attachPullRequests, dropCommandsNamingMissingPaths,
} = await loadPure(join(HERE, 'orchestrator.js'), [
  'orderSubtasks', 'isSubtaskDone', 'remainingSubtasks', 'computeLevels',
  'assertNoBlockerCycles', 'subtaskBranch', 'storyTip', 'storyRoot', 'stackBases', 'escalation',
  'prMatchesSubtask', 'normalizePr', 'candidatePrs', 'selectPr', 'attachPullRequests',
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

test("a PR's real head ref wins over the derived name (prefix drift)", () => {
  const A = { number: 100, blockedBy: [], subtasks: [sub(1, '1.1 a', openPr(9, 'aq-1')), sub(2, '1.2 b')] }
  assert.equal(stackBases(A, mk([A]), PREFIX, PAT, BASE).get(2), 'aq-1')
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

// ── candidatePrs (pass 1: base-blind) ───────────────────────────────────────

const pr = (number, ref, base, over = {}) => ({ number, ref, base, url: `u/${number}`, state: 'open', ...over })

test('pass 1 selects by head ref alone, so the geometry can see real branches', () => {
  // Base is deliberately NOT consulted here: stackBases() derives every base
  // from these refs, so consulting it now would be circular.
  const found = candidatePrs(14, [pr(7, 'task-14', 'anything-at-all'), pr(1, 'task-99', 'main')])
  assert.equal(found.length, 1)
  assert.equal(found[0].number, 7)
  assert.equal(found[0].state, 'OPEN')   // REST says "open"; downstream compares uppercase
})

test('merged_at is what makes a PR merged, not the issue being closed', () => {
  assert.equal(candidatePrs(14, [pr(7, 'task-14', 'main', { merged_at: '2026-08-19T00:00:00Z' })])[0].merged, true)
  assert.equal(candidatePrs(14, [pr(8, 'task-14', 'main', { merged_at: null })])[0].merged, false)
})

test('pass 1 ranks merged first, then most recent', () => {
  const ranked = candidatePrs(14, [
    pr(4, 'task-14', 'main'),
    pr(9, 'task-14', 'main'),
    pr(3, 'task-14', 'main', { merged_at: '2026-08-01T00:00:00Z' }),
  ])
  assert.deepEqual(ranked.map(candidate => candidate.number), [3, 9, 4])
})

test('no candidates at all', () => {
  assert.deepEqual(candidatePrs(13, [pr(1, 'task-99', 'main')]), [])
  assert.deepEqual(candidatePrs(13, []), [])
  assert.deepEqual(candidatePrs(13, null), [])
})

// ── selectPr (pass 2: the graph's base is a FILTER) ──────────────────────────

test('no candidates means no PR — unstarted work, not a failure', () => {
  assert.deepEqual(selectPr([], 'main', 13), { pr: null, note: null })
  assert.deepEqual(selectPr(null, 'main', 13), { pr: null, note: null })
})

test('the PR on the expected stack parent is chosen, whatever its rank was', () => {
  // This is the whole point of the two passes. The merged PR on main outranks
  // the open one in pass 1, but the graph says #14 targets task-13, so the
  // ranking does not get a vote.
  const candidates = candidatePrs(14, [
    pr(9, 'task-14', 'main', { merged_at: '2026-08-01T00:00:00Z' }),
    pr(4, 'task-14', 'task-13'),
  ])
  assert.equal(candidates[0].number, 9)                    // pass 1 ranked the merged one first
  assert.equal(selectPr(candidates, 'task-13', 14).pr.number, 4)   // pass 2 filters by the known base
})

test('a PR against the wrong base is rejected, and is NOT the same as no PR', () => {
  // The #1133 bug: head task-1133, base main instead of its stack parent,
  // counted as done across many runs. 'wrong-base' is a distinct sentinel from
  // null precisely so isSubtaskDone cannot read it as finished work.
  const { pr: found, note } = selectPr(candidatePrs(14, [pr(7, 'task-14', 'main')]), 'task-13', 14)
  assert.equal(found, 'wrong-base')
  assert.match(note, /base "main" is not its stack parent "task-13"/)
})

test('an unreported base is unverifiable — it halts rather than guesses', () => {
  const { pr: found, note } = selectPr(candidatePrs(14, [pr(7, 'task-14', '')]), 'task-13', 14)
  assert.equal(found, 'unknown')
  assert.match(note, /subtask #14 reported no base branch/)
})

test('a correct PR outweighs a sibling with an unreported base', () => {
  // "unknown" halts the whole run, so it must only fire when the answer really
  // is unobtainable — not when a valid PR is sitting right there.
  const candidates = candidatePrs(14, [pr(7, 'task-14', ''), pr(8, 'task-14', 'task-13')])
  assert.equal(selectPr(candidates, 'task-13', 14).pr.number, 8)
})

test('among several PRs on the CORRECT base, pass 1 order decides', () => {
  const candidates = candidatePrs(14, [
    pr(4, 'task-14', 'task-13'),
    pr(3, 'task-14', 'task-13', { merged_at: '2026-08-01T00:00:00Z' }),
  ])
  assert.equal(selectPr(candidates, 'task-13', 14).pr.number, 3)
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

// ── attachPullRequests: the ORDER of the two passes ──────────────────────────

const attach = (stories, pulls, failed = false) =>
  attachPullRequests(stories, pulls, failed, PREFIX, PAT, BASE)

test('a stack resumed under an OLDER prefix still lines up (the ordering bug)', () => {
  // #13 was built in a previous run when the prefix was "aq-", so its PR's head
  // ref is aq-13 and #14's PR correctly targets aq-13 -- not task-13.
  //
  // This only works if pass 1 attaches the refs BEFORE the geometry is
  // computed: stackBases() derives #14's base from subtaskBranch(#13), which
  // prefers the PR's real head ref. Compute the geometry first and #14's
  // expected base is "task-13", the real PR gets rejected as wrong-base, and
  // finished work is re-dispatched onto an empty diff.
  const story = { number: 1, blockedBy: [], subtasks: [
    { number: 13, title: '1.1 first', state: 'OPEN' },
    { number: 14, title: '1.2 second', state: 'OPEN' },
  ] }
  const notes = attach([story], [
    { number: 20, ref: 'aq-13', base: 'main', merged_at: null, state: 'open' },
    { number: 21, ref: 'aq-14', base: 'aq-13', merged_at: null, state: 'open' },
  ])
  assert.deepEqual(notes, [], 'nothing should have been rejected')
  assert.equal(story.subtasks[0].pr.number, 20)
  assert.equal(story.subtasks[1].pr.number, 21)
})

test('a PR on the derived name is still rejected when the stack actually drifted', () => {
  // The mirror image: #14 targets task-13, but #13's real branch is aq-13. That
  // PR is NOT this subtask's stack member, and saying so is the point.
  const story = { number: 1, blockedBy: [], subtasks: [
    { number: 13, title: '1.1 first', state: 'OPEN' },
    { number: 14, title: '1.2 second', state: 'OPEN' },
  ] }
  const notes = attach([story], [
    { number: 20, ref: 'aq-13', base: 'main', merged_at: null, state: 'open' },
    { number: 21, ref: 'task-14', base: 'task-13', merged_at: null, state: 'open' },
  ])
  assert.equal(story.subtasks[1].pr, 'wrong-base')
  assert.match(notes[0], /is not its stack parent "aq-13"/)
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

test('the scratch field never survives into the result', () => {
  // Pass 1 parks candidates on the subtask; anything left behind would ride
  // into the dry-run output and the dispatch payload.
  const story = { number: 1, blockedBy: [], subtasks: [{ number: 13, title: '1.1 a', state: 'OPEN' }] }
  attach([story], [{ number: 20, ref: 'task-13', base: 'main', merged_at: null, state: 'open' }])
  assert.equal('candidates' in story.subtasks[0], false)
})

test('multi-blocker shapes still throw from inside the passes', () => {
  const a = { number: 1, blockedBy: [], subtasks: [{ number: 13, title: '1.1 a', state: 'OPEN' }] }
  const b = { number: 2, blockedBy: [], subtasks: [{ number: 14, title: '2.1 b', state: 'OPEN' }] }
  const c = { number: 3, blockedBy: [1, 2], subtasks: [{ number: 15, title: '3.1 c', state: 'OPEN' }] }
  assert.throws(() => attach([a, b, c], []), /blocked by 2 stories/)
})
