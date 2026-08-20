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
} = await loadPure(join(HERE, 'orchestrator.js'), [
  'orderSubtasks', 'isSubtaskDone', 'remainingSubtasks', 'computeLevels',
  'assertNoBlockerCycles', 'subtaskBranch', 'storyTip', 'storyRoot', 'stackBases', 'escalation',
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
