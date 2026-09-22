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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadPure } from './load-pure.mjs'
import {
  shortId as realShortId, slugify as realSlugify,
  taskStem as realTaskStem, taskBranch as realTaskBranch,
} from '../scripts/naming.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_PATH = join(HERE, 'orchestrator.js')

const {
  isSubtaskDone, remainingSubtasks, computeLevels, storyRollupAnchor,
  assertNoBlockerCycles, subtaskBranch, storyRoot, stackBases, escalation,
  dropCommandsNamingMissingPaths,
  shortId, slugify, taskStem, taskBranch,
  resolveMilestone, resolveBranchPrefix,
} = await loadPure(ORCHESTRATOR_PATH, [
  'isSubtaskDone', 'remainingSubtasks', 'computeLevels', 'storyRollupAnchor',
  'assertNoBlockerCycles', 'subtaskBranch', 'storyTip', 'storyRoot', 'stackBases', 'escalation',
  'dropCommandsNamingMissingPaths',
  'shortId', 'slugify', 'taskStem', 'taskBranch',
  'resolveMilestone', 'resolveBranchPrefix', 'shellQuote',
])

// A card id is a UUID string; taskBranch() (inside orchestrator.js) derives its
// branch from the first 8 hex characters. `uid('11111111')` builds a valid one
// out of a memorable 8-hex-char stem so branch names in assertions stay legible.
const uid = stem => `${stem}-0000-4000-8000-000000000000`

const PREFIX = 'm12'
const BASE = 'main'

const mk = stories => new Map(stories.map(s => [s.id, s]))

// ── drift alarm: orchestrator.js's inlined naming copy vs scripts/naming.mjs ──
// orchestrator.js cannot `import` naming.mjs (workflow scripts have no module
// resolution), so it carries its own copy of shortId/slugify/taskStem/
// taskBranch. The only thing preventing that copy from drifting is this test:
// if it drifts, detect.mjs (the real naming.mjs) and orchestrator.js (this
// copy) disagree about what a branch is called, and the orchestrator hunts for
// PRs at addresses detect never reports — a failure that looks like "no PRs
// exist" rather than what it is. This is a drift alarm, not a re-test of
// naming.mjs's own behavior — that lives in naming.test.mjs.
test('the inlined naming copy in orchestrator.js agrees with scripts/naming.mjs', () => {
  const cards = [
    { id: uid('11111111'), title: 'abcdefghij klmnopqrst uvwxyz' },   // truncates at a word boundary
    { id: uid('22222222'), title: '???' },                            // slugifies to nothing
    { id: 'A32AF745-15EF-45CD-B52C-64C19AE82C17', title: 'anything' }, // uppercase-hex id
  ]
  for (const card of cards) {
    assert.equal(shortId(card.id), realShortId(card.id))
    assert.equal(slugify(card.title), realSlugify(card.title))
    assert.equal(taskStem(card), realTaskStem(card))
    assert.equal(taskBranch('m12', card), realTaskBranch('m12', card))
  }

  // A non-UUID id must throw in BOTH copies, identically.
  assert.throws(() => shortId('nope'), /not a card id/)
  assert.throws(() => realShortId('nope'), /not a card id/)
})

// ── doneness (brd's own status field is the only signal) ────────────────────
// isSubtaskDone/isStoryClosed read `status` alone — the field
// flattenMilestone() (census.mjs) actually emits. There is no `state`
// anywhere in the census; fixtures built as `state` would model a shape the
// census can never produce and hide a dead contract (see the finding this
// fixed: orchestrator.js used to read a `state` field nothing emitted, so its
// doneness protection always evaluated false).

test('isSubtaskDone reads brd status alone — no PR object involved', () => {
  assert.equal(isSubtaskDone({ status: 'done' }), true)
  assert.equal(isSubtaskDone({ status: 'todo' }), false)
  assert.equal(isSubtaskDone({ status: 'in_progress' }), false)
  assert.equal(isSubtaskDone({ status: 'blocked' }), false)
})

test('remainingSubtasks drops done ones and skips a story marked done entirely', () => {
  const s1 = { id: uid('10000001'), title: 'a', status: 'done' }
  const s2 = { id: uid('10000002'), title: 'b', status: 'todo' }
  const story = { id: uid('10000000'), status: 'todo', blockedBy: [], subtasks: [s1, s2] }
  assert.deepEqual(remainingSubtasks(story).map(s => s.id), [s2.id])
  assert.deepEqual(remainingSubtasks({ ...story, status: 'done' }), [])
})

test('subtasks keep the order the census gave them — no re-sorting by title', () => {
  // Titles carry no ordinal any more; the census already ordered these by
  // their blocked_by chain, so the orchestrator must not reorder them. Titles
  // are deliberately given ORDINAL-LOOKING prefixes in REVERSED order — '1.2'
  // before '1.1' — so this assertion fails loudly if title-based sorting is
  // ever reintroduced. (Titles free of any ordinal, as an earlier version of
  // this test used, cannot distinguish "kept the census order" from "sorted
  // and happened not to move" — the old orderSubtasks() would have passed it
  // too.)
  const s1 = { id: uid('10000003'), title: '1.2 quoting', status: 'todo' }
  const s2 = { id: uid('10000004'), title: '1.1 write rows', status: 'todo' }
  const story = { id: uid('10000000'), status: 'todo', blockedBy: [], subtasks: [s1, s2] }
  assert.deepEqual(remainingSubtasks(story).map(s => s.id), [s1.id, s2.id])
})

// ── story-completion gap: rollup anchor ─────────────────────────────────────

test('storyRollupAnchor picks an already-done subtask to reassert', () => {
  const s1 = { id: uid('50000001'), title: 'a', status: 'done' }
  const s2 = { id: uid('50000002'), title: 'b', status: 'todo' }
  const story = { id: uid('50000000'), status: 'todo', blockedBy: [], subtasks: [s1, s2] }
  assert.equal(storyRollupAnchor(story), s1)
})

test('storyRollupAnchor returns null when nothing on the story is done', () => {
  const s1 = { id: uid('50000003'), title: 'a', status: 'todo' }
  const story = { id: uid('50000000'), status: 'todo', blockedBy: [], subtasks: [s1] }
  assert.equal(storyRollupAnchor(story), null)
})

test('storyRollupAnchor returns null for a story with no subtasks', () => {
  const story = { id: uid('50000000'), status: 'done', blockedBy: [], subtasks: [] }
  assert.equal(storyRollupAnchor(story), null)
})

// ── levels ──────────────────────────────────────────────────────────────────

test('independent stories land in one level; a blocked story in the next', () => {
  const A = { id: uid('20000001'), status: 'todo', blockedBy: [], subtasks: [{ id: uid('20000011'), title: 'a', status: 'todo' }] }
  const B = { id: uid('20000002'), status: 'todo', blockedBy: [A.id], subtasks: [{ id: uid('20000012'), title: 'b', status: 'todo' }] }
  const C = { id: uid('20000003'), status: 'todo', blockedBy: [], subtasks: [{ id: uid('20000013'), title: 'c', status: 'todo' }] }
  const levels = computeLevels([A, B, C])
  assert.deepEqual(levels.map(l => l.map(s => s.id)), [[A.id, C.id], [B.id]])
})

test('computeLevels preserves the census order within a level — it does not re-sort story ids', () => {
  // Passed in an order a naive alphabetical (or any other) re-sort of the ids
  // would disturb: 'cccccccc', 'aaaaaaaa', 'bbbbbbbb' is not ascending, so a
  // reintroduced sort would visibly reorder this level.
  const C = { id: uid('cccccccc'), status: 'todo', blockedBy: [], subtasks: [{ id: uid('c0000001'), title: 'c', status: 'todo' }] }
  const A = { id: uid('aaaaaaaa'), status: 'todo', blockedBy: [], subtasks: [{ id: uid('a0000001'), title: 'a', status: 'todo' }] }
  const B = { id: uid('bbbbbbbb'), status: 'todo', blockedBy: [], subtasks: [{ id: uid('b0000001'), title: 'b', status: 'todo' }] }
  const levels = computeLevels([C, A, B])
  assert.deepEqual(levels.map(l => l.map(s => s.id)), [[C.id, A.id, B.id]])
})

test('a story whose blocker has no remaining work is unblocked immediately', () => {
  const A = { id: uid('20000004'), status: 'todo', blockedBy: [], subtasks: [{ id: uid('20000014'), title: 'a', status: 'done' }] }
  const B = { id: uid('20000005'), status: 'todo', blockedBy: [A.id], subtasks: [{ id: uid('20000015'), title: 'b', status: 'todo' }] }
  assert.deepEqual(computeLevels([A, B]).map(l => l.map(s => s.id)), [[B.id]])
})

// ── cycles ──────────────────────────────────────────────────────────────────

test('assertNoBlockerCycles catches a two-story cycle and names it', () => {
  const A = { id: uid('30000001'), blockedBy: [uid('30000002')], subtasks: [{ id: uid('30000011'), title: 'a' }] }
  const B = { id: uid('30000002'), blockedBy: [uid('30000001')], subtasks: [{ id: uid('30000012'), title: 'b' }] }
  assert.throws(() => assertNoBlockerCycles([A, B]), new RegExp(`cycle among stories .*#${uid('30000001')}`))
})

test('assertNoBlockerCycles catches a three-story cycle', () => {
  const A = { id: uid('30000003'), blockedBy: [uid('30000005')], subtasks: [] }
  const B = { id: uid('30000004'), blockedBy: [uid('30000003')], subtasks: [] }
  const C = { id: uid('30000005'), blockedBy: [uid('30000004')], subtasks: [] }
  assert.throws(() => assertNoBlockerCycles([A, B, C]), /cycle/)
})

test('assertNoBlockerCycles allows a diamond (shared blocker, no cycle)', () => {
  const A = { id: uid('30000006'), blockedBy: [], subtasks: [] }
  const B = { id: uid('30000007'), blockedBy: [A.id], subtasks: [] }
  const C = { id: uid('30000008'), blockedBy: [A.id], subtasks: [] }
  assert.doesNotThrow(() => assertNoBlockerCycles([A, B, C]))
})

test('storyRoot alone does NOT detect a cycle between populated stories', () => {
  // Documents a real limitation rather than papering over it: storyTip returns
  // a branch immediately when a story has subtasks, so the recursion never
  // comes back to trip storyRoot's `seen` guard. assertNoBlockerCycles is what
  // actually protects this, and it runs first.
  const tb = { id: uid('30000102'), title: 'b' }
  const A = { id: uid('30000009'), blockedBy: [uid('3000000a')], subtasks: [{ id: uid('30000101'), title: 'a' }] }
  const B = { id: uid('3000000a'), blockedBy: [uid('30000009')], subtasks: [tb] }
  assert.equal(storyRoot(A, mk([A, B]), PREFIX, BASE), `${PREFIX}/task-b-30000102`)
})

// ── stack geometry ──────────────────────────────────────────────────────────

test('a story with no blockers roots at the milestone base and stacks on itself', () => {
  const s1 = { id: uid('40000001'), title: 'a' }
  const s2 = { id: uid('40000002'), title: 'b' }
  const s3 = { id: uid('40000003'), title: 'c' }
  const A = { id: uid('40000000'), blockedBy: [], subtasks: [s1, s2, s3] }
  const bases = stackBases(A, mk([A]), PREFIX, BASE)
  assert.equal(bases.get(s1.id), 'main')
  assert.equal(bases.get(s2.id), `${PREFIX}/task-a-40000001`)
  assert.equal(bases.get(s3.id), `${PREFIX}/task-b-40000002`)
})

test('a blocked story roots on its blocker TIP, not on the base', () => {
  const a1 = { id: uid('40000011'), title: 'a1' }
  const a2 = { id: uid('40000012'), title: 'a2' }
  const A = { id: uid('40000010'), blockedBy: [], subtasks: [a1, a2] }
  const b1 = { id: uid('40000021'), title: 'x' }
  const b2 = { id: uid('40000022'), title: 'y' }
  const B = { id: uid('40000020'), blockedBy: [A.id], subtasks: [b1, b2] }
  const by = mk([A, B])
  assert.equal(storyRoot(B, by, PREFIX, BASE), `${PREFIX}/task-a2-40000012`)
  const bases = stackBases(B, by, PREFIX, BASE)
  assert.equal(bases.get(b1.id), `${PREFIX}/task-a2-40000012`)
  assert.equal(bases.get(b2.id), `${PREFIX}/task-x-40000021`)
})

test('a DONE predecessor still supplies the base (full list, not remaining)', () => {
  const s1 = { id: uid('40000031'), title: 'a', status: 'done' }
  const s2 = { id: uid('40000032'), title: 'b', status: 'todo' }
  const A = { id: uid('40000030'), blockedBy: [], subtasks: [s1, s2] }
  assert.equal(stackBases(A, mk([A]), PREFIX, BASE).get(s2.id), `${PREFIX}/task-a-40000031`)
})

test('a DONE blocker still supplies its tip — done does not mean landed', () => {
  const s1 = { id: uid('40000041'), title: 'a', status: 'done' }
  const A = { id: uid('40000040'), blockedBy: [], subtasks: [s1] }
  const s2 = { id: uid('40000051'), title: 'b', status: 'todo' }
  const B = { id: uid('40000050'), blockedBy: [A.id], subtasks: [s2] }
  assert.equal(storyRoot(B, mk([A, B]), PREFIX, BASE), `${PREFIX}/task-a-40000041`)
})

test('the geometry is derived from the graph alone, never discovered', () => {
  // Branch names come from taskBranch(prefix, card), reproducible from the
  // graph alone with no lookup — there is no external system (no PR) whose
  // state the geometry could depend on any more.
  const s1 = { id: uid('40000061'), title: 'a', status: 'done' }
  const s2 = { id: uid('40000062'), title: 'b', status: 'todo' }
  const A = { id: uid('40000060'), blockedBy: [], subtasks: [s1, s2] }
  assert.equal(stackBases(A, mk([A]), PREFIX, BASE).get(s2.id), `${PREFIX}/task-a-40000061`)
})

test('a chain of three stories roots transitively', () => {
  const A = { id: uid('40000070'), blockedBy: [], subtasks: [{ id: uid('40000071'), title: 'a' }] }
  const B = { id: uid('40000080'), blockedBy: [A.id], subtasks: [{ id: uid('40000081'), title: 'b' }] }
  const C = { id: uid('40000090'), blockedBy: [B.id], subtasks: [{ id: uid('40000091'), title: 'c' }] }
  assert.equal(storyRoot(C, mk([A, B, C]), PREFIX, BASE), `${PREFIX}/task-b-40000081`)
})

test('blockers OUTSIDE the milestone are ignored', () => {
  const A = { id: uid('400000a0'), blockedBy: [uid('9999999a')], subtasks: [{ id: uid('400000a1'), title: 'a' }] }
  assert.equal(storyRoot(A, mk([A]), PREFIX, BASE), 'main')
})

test('TWO blockers refuse to guess and say why', () => {
  const A = { id: uid('400000b0'), blockedBy: [], subtasks: [{ id: uid('400000b1'), title: 'a' }] }
  const B = { id: uid('400000c0'), blockedBy: [], subtasks: [{ id: uid('400000c1'), title: 'b' }] }
  const C = { id: uid('400000d0'), blockedBy: [A.id, B.id], subtasks: [{ id: uid('400000d1'), title: 'c' }] }
  assert.throws(() => storyRoot(C, mk([A, B, C]), PREFIX, BASE), /blocked by 2 stories/)
})

test('a blocker with NO subtasks falls through to its own root', () => {
  const A = { id: uid('400000e0'), blockedBy: [], subtasks: [] }
  const B = { id: uid('400000f0'), blockedBy: [A.id], subtasks: [{ id: uid('400000f1'), title: 'b' }] }
  assert.equal(storyRoot(B, mk([A, B]), PREFIX, BASE), 'main')
})

// ── escalation ──────────────────────────────────────────────────────────────
// Generic: story/subtask are opaque identifiers passed through unexamined.

test('escalation rejects triggers that no longer exist', () => {
  // 'conflict' died with the merge phase; accepting it would let a stale caller
  // build a payload describing a merge that never happens.
  assert.throws(() => escalation({ trigger: 'conflict', story: 1, subtask: 2, baseBranch: 'main' }), /unknown escalation trigger/)
})

test('escalation says plainly that nothing was merged', () => {
  const payload = escalation({ level: 0, story: 1, subtask: 2, trigger: 'tests', baseBranch: 'main', attempts: [] })
  assert.equal(payload.escalated, true)
  assert.match(payload.message, /Nothing was merged/)
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

// ── milestone-scoped branch prefixes ─────────────────────────────────────────

test('a milestone-scoped prefix groups branches without disturbing the geometry', () => {
  const t1 = { id: uid('60000001'), title: 'first', status: 'todo' }
  const t2 = { id: uid('60000002'), title: 'second', status: 'todo' }
  const story = { id: uid('60000000'), blockedBy: [], subtasks: [t1, t2] }
  const bases = stackBases(story, mk([story]), 'm12', BASE)
  assert.equal(bases.get(t1.id), 'main')
  assert.equal(bases.get(t2.id), 'm12/task-first-60000001')
})

// ── the dispatch: card + branch, no board ─────────────────────────────────────

test('the branch the orchestrator dispatches is the one it derives', async () => {
  // subtaskBranch is already in the loadPure name list above — it is what the
  // dry-run table uses. This pins that the dispatch cannot drift from that
  // derivation.
  const S1 = uid('11111111')
  assert.equal(subtaskBranch({ id: S1, title: 'write rows' }, 'm12'), 'm12/task-write-rows-11111111')
})

test('the dispatch passes card and branch, and no longer passes issue', () => {
  const source = readFileSync(ORCHESTRATOR_PATH, 'utf8')
  assert.match(source, /card: subtask\.id/)
  assert.doesNotMatch(source, /issue: subtask\.id/,
    'the GitHub key must be gone, not merely unused')
})

test('the board is no longer a concept here', () => {
  const source = readFileSync(ORCHESTRATOR_PATH, 'utf8')
  assert.doesNotMatch(source, /resolveBoardIds|hasResolvedBoardIds|optionIds|fieldId/)
})

test('branchPrefix is not forwarded to task.js — task.js never reads it', () => {
  const source = readFileSync(ORCHESTRATOR_PATH, 'utf8')
  const dispatch = source.slice(source.indexOf('dispatched = await workflow('), source.indexOf('dispatched = await workflow(') + 400)
  assert.doesNotMatch(dispatch, /branchPrefix/)
})

test('a status-write failure from task.js is carried through the subtask result, not swallowed', () => {
  const source = readFileSync(ORCHESTRATOR_PATH, 'utf8')
  assert.match(source, /statusWritten: dispatched\.statusWritten !== false/)
  assert.match(source, /statusWriteError/)
})

test('the final run-summary note describes local branches, not GitHub PRs', () => {
  const source = readFileSync(ORCHESTRATOR_PATH, 'utf8')
  assert.doesNotMatch(source, /still OPEN and their cards sit at "In review"/,
    'the note still describes retired GitHub issues and an "In review" column that no longer exists')
  assert.doesNotMatch(source, /the PR is open, not that it is merged/,
    'the note still promises a PR, which this mode never opens')
  assert.match(source, /nothing was pushed and main\/master was not touched/)
})

// ── resolveMilestone / resolveBranchPrefix ───────────────────────────────────
// A milestone may be a positive integer, a brd card id, or a title
// substring (census.mjs's findMilestone() accepts all three and fails loudly
// on ambiguity). Only the numeric form has a safe default branchPrefix — a
// title fed through `m${milestone}` naively would produce an invalid git ref
// like `mMilestone 12: CSV export`.

test('a positive integer milestone is numeric and defaults its branchPrefix', () => {
  assert.deepEqual(resolveMilestone(12), { milestone: 12, isNumeric: true })
  assert.deepEqual(resolveMilestone('12'), { milestone: 12, isNumeric: true })
  assert.equal(resolveBranchPrefix(undefined, 12, true), 'm12')
})

test('a card id or title substring is not numeric', () => {
  const cardId = 'aaaaaaaa-0000-4000-8000-000000000000'
  assert.deepEqual(resolveMilestone(cardId), { milestone: cardId, isNumeric: false })
  assert.deepEqual(resolveMilestone('CSV export'), { milestone: 'CSV export', isNumeric: false })
})

test('a missing/empty milestone throws rather than silently addressing nothing', () => {
  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(() => resolveMilestone(bad), /needs args\.milestone/)
  }
})

test('a non-numeric milestone with no branchPrefix throws a clear, actionable error', () => {
  assert.throws(
    () => resolveBranchPrefix(undefined, 'CSV export', false),
    /needs args\.branchPrefix.*"CSV export".*not a positive integer/s)
})

test('a non-numeric milestone WITH an explicit branchPrefix is accepted verbatim', () => {
  assert.equal(resolveBranchPrefix('csv-export', 'CSV export', false), 'csv-export')
})

test('an explicit branchPrefix wins even for a numeric milestone', () => {
  assert.equal(resolveBranchPrefix('custom', 12, true), 'custom')
})

// ── story-completion gap: dispatch wiring (source-level) ────────────────────
// The dispatch itself sits outside the PURE region (it calls agent()), so this
// is source-level, matching how phase 2 tested task.js's equivalent rollup
// dispatches.
test('a story whose subtasks are all already shipped still gets its card rolled up', () => {
  const source = readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8')
  // storyRollupAnchor's own definition also matches a bare `rollup.mjs` /
  // `storyRollupAnchor(` search, so these assertions target the actual CALL
  // site (an assignment) and the full --card invocation, not just the pure
  // helper's presence.
  assert.match(source, /const anchor = storyRollupAnchor\(/,
    'the orchestrator must pick an anchor subtask for each already-complete story')
  assert.match(source, /rollup\.mjs --card \$\{anchor\.id\}/,
    "and must dispatch rollup.mjs against that anchor's full card id, re-asserting its own status")
  assert.match(source, /statusWriteFailures/,
    'and a failure here must surface the same way task.js\'s does, not vanish')
})

test('a halted run still reports stale-rollup failures, not just per-subtask ones', () => {
  // Regression pin: the halted-escalation return used to spread `...halted`
  // and `completed` only, dropping staleRollupErrors entirely — a stale-rollup
  // failure that happened before a later story escalated would vanish rather
  // than surface, unlike a per-subtask statusWriteError (which survives
  // nested inside `completed.stories[].subtasks[]`, even though its count
  // does not). Pin the halted return so it folds staleRollupErrors in the
  // same additive way the other two return shapes already do.
  const source = readFileSync(ORCHESTRATOR_PATH, 'utf8')
  assert.match(source,
    /if \(halted\) return \{ repo, milestone, baseBranch, mode: 'stacked', \.\.\.halted, completed: results,\n\s*\.\.\.\(staleRollupErrors\.length > 0 \? \{ statusWriteFailures: staleRollupErrors\.length \} : \{\}\) \}/,
    'the top-level halted-run return must fold staleRollupErrors into statusWriteFailures, the same key the other two returns use — a stale-rollup failure that happened before a later story escalated must not vanish')
})
