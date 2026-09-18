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
import {
  shortId as realShortId, slugify as realSlugify,
  taskStem as realTaskStem, taskBranch as realTaskBranch,
} from '../scripts/naming.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const {
  isSubtaskDone, remainingSubtasks, computeLevels,
  assertNoBlockerCycles, storyRoot, stackBases, escalation,
  prMatchesSubtask, matchPr, attachPullRequests, dropCommandsNamingMissingPaths,
  resolveBoardIds, hasResolvedBoardIds,
  shortId, slugify, taskStem, taskBranch,
} = await loadPure(join(HERE, 'orchestrator.js'), [
  'isSubtaskDone', 'remainingSubtasks', 'computeLevels',
  'assertNoBlockerCycles', 'subtaskBranch', 'storyTip', 'storyRoot', 'stackBases', 'escalation',
  'prMatchesSubtask', 'normalizePr', 'matchPr', 'attachPullRequests',
  'dropCommandsNamingMissingPaths', 'resolveBoardIds', 'hasResolvedBoardIds',
  'shortId', 'slugify', 'taskStem', 'taskBranch',
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

// ── doneness (stacked mode: an open PR means DONE) ──────────────────────────
// isSubtaskDone reads only `pr` and `state` — no id involved.

const sub = (pr = null, state = 'OPEN') => ({ state, pr })
const openPr = (n, ref, base = 'main') => ({ number: n, state: 'OPEN', merged: false, ref, base })

test('an OPEN PR counts as done — nothing merges in stacked mode', () => {
  assert.equal(isSubtaskDone(sub(openPr(9, 'task-1'))), true)
})

test('a closed issue with NO PR ever found counts as done', () => {
  assert.equal(isSubtaskDone(sub(null, 'CLOSED')), true)
})

test('an open issue with no PR is NOT done', () => {
  assert.equal(isSubtaskDone(sub(null, 'OPEN')), false)
})

test("a rejected wrong-base PR is NOT done, even on a closed issue", () => {
  // The sentinel is a string, not an object — this is the #1133 guard, and it
  // matters more now that an open PR alone counts as done.
  assert.equal(isSubtaskDone(sub('wrong-base', 'CLOSED')), false)
  assert.equal(isSubtaskDone(sub('wrong-base', 'OPEN')), false)
})

test('remainingSubtasks drops done ones and skips a CLOSED story entirely', () => {
  const s1 = { id: uid('10000001'), title: 'a', state: 'OPEN', pr: openPr(9, 'task-1') }
  const s2 = { id: uid('10000002'), title: 'b', state: 'OPEN', pr: null }
  const story = { id: uid('10000000'), state: 'OPEN', blockedBy: [], subtasks: [s1, s2] }
  assert.deepEqual(remainingSubtasks(story).map(s => s.id), [s2.id])
  assert.deepEqual(remainingSubtasks({ ...story, state: 'CLOSED' }), [])
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
  const s1 = { id: uid('10000003'), title: '1.2 quoting', state: 'OPEN', pr: null }
  const s2 = { id: uid('10000004'), title: '1.1 write rows', state: 'OPEN', pr: null }
  const story = { id: uid('10000000'), state: 'OPEN', blockedBy: [], subtasks: [s1, s2] }
  assert.deepEqual(remainingSubtasks(story).map(s => s.id), [s1.id, s2.id])
})

// ── levels ──────────────────────────────────────────────────────────────────

test('independent stories land in one level; a blocked story in the next', () => {
  const A = { id: uid('20000001'), state: 'OPEN', blockedBy: [], subtasks: [{ id: uid('20000011'), title: 'a', state: 'OPEN' }] }
  const B = { id: uid('20000002'), state: 'OPEN', blockedBy: [A.id], subtasks: [{ id: uid('20000012'), title: 'b', state: 'OPEN' }] }
  const C = { id: uid('20000003'), state: 'OPEN', blockedBy: [], subtasks: [{ id: uid('20000013'), title: 'c', state: 'OPEN' }] }
  const levels = computeLevels([A, B, C])
  assert.deepEqual(levels.map(l => l.map(s => s.id)), [[A.id, C.id], [B.id]])
})

test('computeLevels preserves the census order within a level — it does not re-sort story ids', () => {
  // Passed in an order a naive alphabetical (or any other) re-sort of the ids
  // would disturb: 'cccccccc', 'aaaaaaaa', 'bbbbbbbb' is not ascending, so a
  // reintroduced sort would visibly reorder this level.
  const C = { id: uid('cccccccc'), state: 'OPEN', blockedBy: [], subtasks: [{ id: uid('c0000001'), title: 'c', state: 'OPEN' }] }
  const A = { id: uid('aaaaaaaa'), state: 'OPEN', blockedBy: [], subtasks: [{ id: uid('a0000001'), title: 'a', state: 'OPEN' }] }
  const B = { id: uid('bbbbbbbb'), state: 'OPEN', blockedBy: [], subtasks: [{ id: uid('b0000001'), title: 'b', state: 'OPEN' }] }
  const levels = computeLevels([C, A, B])
  assert.deepEqual(levels.map(l => l.map(s => s.id)), [[C.id, A.id, B.id]])
})

test('a story whose blocker has no remaining work is unblocked immediately', () => {
  const A = { id: uid('20000004'), state: 'OPEN', blockedBy: [], subtasks: [{ id: uid('20000014'), title: 'a', state: 'OPEN', pr: openPr(9, 'task-1') }] }
  const B = { id: uid('20000005'), state: 'OPEN', blockedBy: [A.id], subtasks: [{ id: uid('20000015'), title: 'b', state: 'OPEN' }] }
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
  const s1 = { id: uid('40000031'), title: 'a', pr: openPr(9, 'task-1'), state: 'OPEN' }
  const s2 = { id: uid('40000032'), title: 'b', pr: null, state: 'OPEN' }
  const A = { id: uid('40000030'), blockedBy: [], subtasks: [s1, s2] }
  assert.equal(stackBases(A, mk([A]), PREFIX, BASE).get(s2.id), `${PREFIX}/task-a-40000031`)
})

test('a DONE blocker still supplies its tip — done does not mean landed', () => {
  const s1 = { id: uid('40000041'), title: 'a', pr: openPr(9, 'task-1'), state: 'OPEN' }
  const A = { id: uid('40000040'), blockedBy: [], subtasks: [s1] }
  const s2 = { id: uid('40000051'), title: 'b', state: 'OPEN' }
  const B = { id: uid('40000050'), blockedBy: [A.id], subtasks: [s2] }
  assert.equal(storyRoot(B, mk([A, B]), PREFIX, BASE), `${PREFIX}/task-a-40000041`)
})

test('the geometry is derived from the graph, never from a PR head ref', () => {
  // A PR under a different name does NOT bend the stack toward itself. The
  // geometry has to be reproducible from the graph alone -- when it read head
  // refs instead, the bases depended on the PRs and the PR matching depended on
  // the bases, and that circularity produced two bugs in one afternoon.
  // matchPr() is where a stray branch gets noticed, and it halts rather than
  // quietly re-shaping the stack.
  const s1 = { id: uid('40000061'), title: 'a', pr: openPr(9, 'aq-1'), state: 'OPEN' }
  const s2 = { id: uid('40000062'), title: 'b', pr: null, state: 'OPEN' }
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
  const payload = escalation({ level: 0, story: 1, subtask: 2, pr: null, trigger: 'tests', baseBranch: 'main', attempts: [] })
  assert.equal(payload.escalated, true)
  assert.match(payload.message, /Nothing was merged/)
})

// ── prMatchesSubtask ─────────────────────────────────────────────────────────
// Generic suffix matching — the id it is called with is a short id in
// production, but the algorithm itself is oblivious to what the suffix means.

test('a subtask short id matches any prefix, and a bare short id', () => {
  // The whole point: doneness survives a branch-prefix change.
  for (const ref of ['task-a1b2c3d4', 'aq-a1b2c3d4', 'wip/a1b2c3d4', 'a1b2c3d4', 'feature/x-a1b2c3d4']) {
    assert.equal(prMatchesSubtask(ref, 'a1b2c3d4'), true, ref)
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
  const { pr: found, note } = matchPr('a1b2c3d4', 'task-14', 'task-13', [pr(7, 'task-14', 'task-13')])
  assert.equal(found.number, 7)
  assert.equal(found.state, 'OPEN')   // REST says "open"; downstream compares uppercase
  assert.equal(note, null)
})

test('merged_at is what makes a PR merged, not the issue being closed', () => {
  assert.equal(matchPr('a1b2c3d4', 'task-14', 'main', [pr(7, 'task-14', 'main', { merged_at: '2026-08-19T00:00:00Z' })]).pr.merged, true)
  assert.equal(matchPr('a1b2c3d4', 'task-14', 'main', [pr(8, 'task-14', 'main', { merged_at: null })]).pr.merged, false)
})

test('nothing matching means unstarted work, silently', () => {
  assert.deepEqual(matchPr('a1b2c3d4', 'task-13', 'main', [pr(1, 'task-99', 'main')]), { pr: null, note: null })
  assert.deepEqual(matchPr('a1b2c3d4', 'task-13', 'main', []), { pr: null, note: null })
  assert.deepEqual(matchPr('a1b2c3d4', 'task-13', 'main', null), { pr: null, note: null })
})

test('a PR on the right branch but the wrong base is rejected, and is NOT no-PR', () => {
  // The #1133 bug: head task-1133, base main instead of its stack parent,
  // counted as done across many runs. 'wrong-base' is a distinct sentinel from
  // null precisely so isSubtaskDone cannot read it as finished work.
  const { pr: found, note } = matchPr('a1b2c3d4', 'task-14', 'task-13', [pr(7, 'task-14', 'main')])
  assert.equal(found, 'wrong-base')
  assert.match(note, /base "main" is not its stack parent "task-13"/)
})

test('an unreported base is unverifiable — it halts rather than guesses', () => {
  const { pr: found, note } = matchPr('a1b2c3d4', 'task-14', 'task-13', [pr(7, 'task-14', '')])
  assert.equal(found, 'unknown')
  assert.match(note, /reported no base branch/)
})

test('ranking applies only WITHIN the right branch and base', () => {
  // It can never override either, so a merged PR on the wrong base cannot win.
  const pulls = [pr(9, 'task-14', 'main', { merged_at: '2026-08-01T00:00:00Z' }), pr(4, 'task-14', 'task-13')]
  assert.equal(matchPr('a1b2c3d4', 'task-14', 'task-13', pulls).pr.number, 4)

  const both = [pr(4, 'task-14', 'task-13'), pr(3, 'task-14', 'task-13', { merged_at: '2026-08-01T00:00:00Z' })]
  assert.equal(matchPr('a1b2c3d4', 'task-14', 'task-13', both).pr.number, 3)
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
  // A human branch, or an abandoned attempt.
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
  attachPullRequests(stories, pulls, failed, PREFIX, BASE)

test('every branch and base comes from the graph, with no PR consulted', () => {
  const t1 = { id: uid('50000001'), title: 'first', state: 'OPEN' }
  const t2 = { id: uid('50000002'), title: 'second', state: 'OPEN' }
  const story = { id: uid('50000000'), blockedBy: [], subtasks: [t1, t2] }
  const branch1 = `${PREFIX}/task-first-50000001`
  const branch2 = `${PREFIX}/task-second-50000002`
  const notes = attach([story], [
    { number: 20, ref: branch1, base: 'main', merged_at: null, state: 'open' },
    { number: 21, ref: branch2, base: branch1, merged_at: null, state: 'open' },
  ])
  assert.deepEqual(notes, [])
  assert.equal(story.subtasks[0].pr.number, 20)
  assert.equal(story.subtasks[1].pr.number, 21)
})

test('a title edit does not orphan an open PR — the short id still matches under the OLD slug', () => {
  // The slug half of a derived branch is decoration, not identity: a card's
  // title can be edited after its PR is open. If the primary match were a
  // literal string == against the freshly-derived branch (which now carries
  // the CURRENT slug), an edited title would miss, fall through to the
  // near-miss path, and report real work as unstarted.
  const t1 = { id: uid('50000041'), title: 'first', state: 'OPEN' }   // title edited after the PR opened
  const story = { id: uid('50000040'), blockedBy: [], subtasks: [t1] }
  const staleBranch = `${PREFIX}/task-was-first-50000041`             // same short id, stale slug
  const notes = attach([story], [
    { number: 30, ref: staleBranch, base: 'main', merged_at: null, state: 'open' },
  ])
  assert.deepEqual(notes, [])
  assert.equal(story.subtasks[0].pr.number, 30)
})

test('a whole stack built under an older prefix halts on its first merged PR', () => {
  const t1 = { id: uid('50000011'), title: 'first', state: 'CLOSED' }
  const t2 = { id: uid('50000012'), title: 'second', state: 'OPEN' }
  const story = { id: uid('50000010'), blockedBy: [], subtasks: [t1, t2] }
  // Near miss: some OTHER branch that merely ends with the subtask's short id —
  // the signature of a changed branchPrefix, regardless of slug.
  const notes = attach([story], [
    { number: 20, ref: 'aq-50000011', base: 'main', merged_at: '2026-08-01T00:00:00Z', state: 'closed' },
    { number: 21, ref: 'aq-50000012', base: 'aq-50000011', merged_at: null, state: 'open' },
  ])
  assert.equal(story.subtasks[0].pr, 'unknown')
  assert.match(notes[0], /branchPrefix/)
})

test('the first subtask of a blocked story roots on its blocker tip', () => {
  const ta = { id: uid('50000021'), title: 'a', state: 'OPEN' }
  const a = { id: uid('50000020'), blockedBy: [], subtasks: [ta] }
  const tb = { id: uid('50000031'), title: 'b', state: 'OPEN' }
  const b = { id: uid('50000030'), blockedBy: [a.id], subtasks: [tb] }
  const branchA = `${PREFIX}/task-a-50000021`
  attach([a, b], [
    { number: 20, ref: branchA, base: 'main', merged_at: null, state: 'open' },
    { number: 22, ref: `${PREFIX}/task-b-50000031`, base: branchA, merged_at: null, state: 'open' },
  ])
  assert.equal(b.subtasks[0].pr.number, 22)
})

test('a failed lookup marks every subtask unknown and rejects nothing', () => {
  const t1 = { id: uid('50000041'), title: 'a', state: 'OPEN' }
  const t2 = { id: uid('50000042'), title: 'b', state: 'OPEN' }
  const story = { id: uid('50000040'), blockedBy: [], subtasks: [t1, t2] }
  const notes = attach([story], [], true)
  assert.deepEqual(notes, [])
  assert.deepEqual(story.subtasks.map(s => s.pr), ['unknown', 'unknown'])
})

test('multi-blocker shapes throw even when the PR lookup failed', () => {
  // The shape is a human decision and must surface regardless of API health.
  const a = { id: uid('50000050'), blockedBy: [], subtasks: [{ id: uid('50000051'), title: 'a', state: 'OPEN' }] }
  const b = { id: uid('50000060'), blockedBy: [], subtasks: [{ id: uid('50000061'), title: 'b', state: 'OPEN' }] }
  const c = { id: uid('50000070'), blockedBy: [a.id, b.id], subtasks: [{ id: uid('50000071'), title: 'c', state: 'OPEN' }] }
  assert.throws(() => attach([a, b, c], [], true), /blocked by 2 stories/)
})

// ── milestone-scoped branch prefixes ─────────────────────────────────────────

test('a milestone-scoped prefix groups branches without disturbing the geometry', () => {
  const t1 = { id: uid('60000001'), title: 'first', state: 'OPEN' }
  const t2 = { id: uid('60000002'), title: 'second', state: 'OPEN' }
  const story = { id: uid('60000000'), blockedBy: [], subtasks: [t1, t2] }
  const bases = stackBases(story, mk([story]), 'm12', BASE)
  assert.equal(bases.get(t1.id), 'main')
  assert.equal(bases.get(t2.id), 'm12/task-first-60000001')
})

test('the number rule survives slashes in the branch name', () => {
  assert.equal(prMatchesSubtask('m12/task-13', 13), true)
  assert.equal(prMatchesSubtask('m1/task-213', 13), false)   // 213 is a different subtask
  assert.equal(prMatchesSubtask('m12/task-13', 3), false)    // preceded by a digit
})

test('PRs match against the milestone-scoped branch', () => {
  const { pr: found } = matchPr(14, 'm12/task-14', 'm12/task-13',
    [pr(7, 'm12/task-14', 'm12/task-13')])
  assert.equal(found.number, 7)
})

test('adopting the prefix on a milestone with merged work HALTS, it does not redo it', () => {
  // The migration case, and the reason this is not a free rename: a milestone
  // built under a bare "task-" has its finished PRs at the old addresses. The
  // run finds them as near misses and stops rather than re-implementing them.
  const { pr: found, note } = matchPr(13, 'm12/task-13', 'main',
    [pr(20, 'task-13', 'main', { merged_at: '2026-08-01T00:00:00Z' })])
  assert.equal(found, 'unknown')
  assert.match(note, /MERGED PR #20 on branch "task-13"/)
  assert.match(note, /the default is now "m<milestone>"/)
})

// ── resolveBoardIds: exact names, decided in script ──────────────────────────

const NAMES = { backlog: 'Backlog', inProgress: 'In progress', inReview: 'In review', done: 'Done' }
const statusField = (options, name = 'Status') => ({ id: 'F_1', name, options })
const allFour = [
  { id: 'o1', name: 'Backlog' }, { id: 'o2', name: 'In progress' },
  { id: 'o3', name: 'In review' }, { id: 'o4', name: 'Done' },
]

test('a board with all four options resolves to their ids', () => {
  const got = resolveBoardIds([statusField(allFour)], 'Status', NAMES)
  assert.equal(got.ok, true)
  assert.equal(got.fieldId, 'F_1')
  assert.deepEqual(got.optionIds, { backlog: 'o1', inProgress: 'o2', inReview: 'o3', done: 'o4' })
})

test('a case mismatch FAILS, and says what it found', () => {
  // The whole reason this moved out of the prompt. "In Progress" is not
  // "In progress", and a model asked to match "exactly" may helpfully bridge
  // that -- returning a real id for the wrong column, which no later check
  // could catch because the ids are opaque.
  const wrong = [{ id: 'o1', name: 'Backlog' }, { id: 'o2', name: 'In Progress' },
                 { id: 'o3', name: 'In review' }, { id: 'o4', name: 'Done' }]
  const got = resolveBoardIds([statusField(wrong)], 'Status', NAMES)
  assert.equal(got.ok, false)
  assert.match(got.missing, /"In progress" \(found "In Progress"\)/)
  assert.match(got.missing, /case and spacing/)
})

test('a near-miss FIELD name is named rather than reported as absent', () => {
  const got = resolveBoardIds([statusField(allFour, 'status')], 'Status', NAMES)
  assert.equal(got.ok, false)
  assert.match(got.missing, /closest is "status"/)
})

test('a genuinely absent field lists what IS there', () => {
  const got = resolveBoardIds([statusField(allFour, 'Priority')], 'Status', NAMES)
  assert.equal(got.ok, false)
  assert.match(got.missing, /present: "Priority"/)
})

test('every missing option is reported at once, not one per run', () => {
  const got = resolveBoardIds([statusField([{ id: 'o1', name: 'Backlog' }])], 'Status', NAMES)
  assert.equal(got.ok, false)
  for (const wanted of ['In progress', 'In review', 'Done']) assert.match(got.missing, new RegExp(wanted))
})

test('an option without an id does not count as found', () => {
  const noId = [{ id: 'o1', name: 'Backlog' }, { name: 'In progress' },
                { id: 'o3', name: 'In review' }, { id: 'o4', name: 'Done' }]
  assert.equal(resolveBoardIds([statusField(noId)], 'Status', NAMES).ok, false)
})

test('renamed columns resolve when the caller declares them', () => {
  // The zero-mutation path from the setup skill: keep Todo/Doing, tell the run.
  const custom = { backlog: 'Todo', inProgress: 'Doing', inReview: 'In review', done: 'Shipped' }
  const options = [{ id: 'a', name: 'Todo' }, { id: 'b', name: 'Doing' },
                   { id: 'c', name: 'In review' }, { id: 'd', name: 'Shipped' }]
  const got = resolveBoardIds([statusField(options)], 'Status', custom)
  assert.deepEqual(got.optionIds, { backlog: 'a', inProgress: 'b', inReview: 'c', done: 'd' })
})

test('junk input fails cleanly instead of throwing', () => {
  for (const bad of [null, undefined, [], 'nope', [null], [{}]]) {
    assert.equal(resolveBoardIds(bad, 'Status', NAMES).ok, false)
  }
})

// ── hasResolvedBoardIds ──────────────────────────────────────────────────────

const RESOLVED = { id: 'PVT_1', fieldId: 'F_1',
  optionIds: { backlog: 'o1', inProgress: 'o2', inReview: 'o3', done: 'o4' } }

test('a complete id block skips the lookup dispatch', () => {
  assert.equal(hasResolvedBoardIds(RESOLVED), true)
  assert.equal(hasResolvedBoardIds({ ...RESOLVED, number: 13 }), true)   // number alongside is fine
})

test('a PARTIAL id block does not count', () => {
  // A partial block would disable exactly one column's moves and look like it
  // worked -- the worst possible outcome for bookkeeping nobody watches.
  assert.equal(hasResolvedBoardIds({ ...RESOLVED, optionIds: { ...RESOLVED.optionIds, done: '' } }), false)
  assert.equal(hasResolvedBoardIds({ ...RESOLVED, optionIds: { backlog: 'o1' } }), false)
  assert.equal(hasResolvedBoardIds({ ...RESOLVED, fieldId: '' }), false)
  assert.equal(hasResolvedBoardIds({ ...RESOLVED, id: undefined }), false)
})

test('a bare number is not a resolved block', () => {
  assert.equal(hasResolvedBoardIds({ number: 13 }), false)
  for (const bad of [null, undefined, 'PVT_1', 13]) assert.equal(hasResolvedBoardIds(bad), false)
})
