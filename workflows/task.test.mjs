// Tests for task.js's two hard stops — the empty-verification gate and the
// Review -> Ship gate. loadPure() slices the PURE:BEGIN/PURE:END region out of
// task.js and evaluates it, so these run against the same bytes the workflow
// runs; there is no second copy to drift.
//
// Both gates exist because a live run got past them. The empty-suite one was
// added after a run whose every downstream check was vacuous and which only
// looked green because the Ship agents disobeyed their prompt and went looking
// for tests. A gate that has never fired is a guess, so it gets fired here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadPure } from './load-pure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const { verificationGate, reviewGate, isPlanHash, planHashMismatch } = await loadPure(join(HERE, 'task.js'), [
  'verificationGate', 'reviewGate', 'isPlanHash', 'planHashMismatch',
])

const BRANCH = 'task-42'
const BASE = 'main'

// A Review return with every fact present and healthy.
const clean = (over = {}) => ({ porcelain: '', commitCount: 3, taggedCount: 3, ...over })

// ── verificationGate ─────────────────────────────────────────────────────────

test('a discovered suite proceeds', () => {
  assert.equal(verificationGate(['npm test'], undefined, false), null)
})

test('an empty suite is a hard stop, not a warning', () => {
  const gate = verificationGate([], undefined, false)
  assert.equal(gate.blocked, 'verification')
  assert.match(gate.detail, /still report success/)
})

test('the empty-suite stop names the CALLER when the caller supplied the empty list', () => {
  // Which half of the pipeline to go fix differs entirely: an empty list the
  // orchestrator passed down means the BASE BRANCH documents no commands, which
  // is where the second live bug actually lived.
  assert.match(verificationGate([], undefined, true).detail, /orchestrator discovers these from origin/)
  assert.match(verificationGate([], undefined, false).detail, /Intake found none/)
})

test('allowNoVerification: true is the only way past an empty suite', () => {
  assert.equal(verificationGate([], true, false), null)
  // Truthy is not enough — the opt-out is deliberate, so it is strict.
  for (const sloppy of ['true', 1, {}, 'yes']) {
    assert.equal(verificationGate([], sloppy, false).blocked, 'verification',
      `${JSON.stringify(sloppy)} must not open the gate`)
  }
})

// ── reviewGate: the dirty-tree half ──────────────────────────────────────────

test('a clean tree with tagged commits proceeds to Ship', () => {
  assert.equal(reviewGate(clean(), BRANCH, BASE), null)
})

test('a dirty worktree stops the run before anything is pushed', () => {
  const gate = reviewGate(clean({ porcelain: ' M src/a.js' }), BRANCH, BASE)
  assert.equal(gate.blocked, 'tests')
  assert.match(gate.detail, /nothing was pushed/)
  assert.match(gate.detail, /M src\/a\.js/)   // the evidence travels with the verdict
})

test('whitespace-only porcelain is a clean tree', () => {
  // git prints a trailing newline even when it has nothing to say; treating
  // that as dirt would block every single run.
  assert.equal(reviewGate(clean({ porcelain: '\n' }), BRANCH, BASE), null)
  assert.equal(reviewGate(clean({ porcelain: '   ' }), BRANCH, BASE), null)
})

test('the dirty-tree check runs BEFORE the commit counts', () => {
  // A dirty tree means the counts describe a branch that is missing work, so
  // reporting the count problem first would send someone after the wrong bug.
  const gate = reviewGate({ porcelain: '?? new.js', commitCount: 0, taggedCount: 0 }, BRANCH, BASE)
  assert.equal(gate.blocked, 'tests')
})

// ── reviewGate: the Plan-Hash half ───────────────────────────────────────────

test('zero commits stops the run as an implement failure', () => {
  const gate = reviewGate(clean({ commitCount: 0, taggedCount: 0 }), BRANCH, BASE)
  assert.equal(gate.blocked, 'implement')
  assert.match(gate.detail, /task-42 has no commits on top of main/)
})

test('an untagged commit stops the run — a later run would hard-reset it', () => {
  const gate = reviewGate(clean({ commitCount: 3, taggedCount: 2 }), BRANCH, BASE)
  assert.equal(gate.blocked, 'implement')
  assert.match(gate.detail, /only 2 of 3 commits/)
  assert.match(gate.detail, /Do NOT re-run this subtask/)  // re-running is the destructive move
})

test('more trailers than commits is not a failure', () => {
  // A commit can legitimately carry the trailer twice, or a merge can inflate
  // the count. The gate only cares that nothing is MISSING one.
  assert.equal(reviewGate(clean({ commitCount: 3, taggedCount: 4 }), BRANCH, BASE), null)
})

// ── reviewGate: unusable input ───────────────────────────────────────────────

test('unusable counts warn and skip, rather than blocking or silently passing', () => {
  // null and '' are the sharp ones: Number() turns both into 0, which would be
  // read as "zero commits" and stop the run blaming Implement for a fact
  // nobody ever measured.
  for (const bad of [{ commitCount: null }, { commitCount: '' }, { commitCount: 'three' },
                     { taggedCount: undefined }, { commitCount: 1.5 }, { taggedCount: NaN },
                     { taggedCount: true }]) {
    const gate = reviewGate(clean(bad), BRANCH, BASE)
    assert.ok(gate.warn, `${JSON.stringify(bad)} should warn`)
    assert.equal(gate.blocked, undefined)
    assert.match(gate.warn, /Plan-Hash gate skipped/)
  }
})

test('a missing review object warns instead of throwing', () => {
  // task.js now stops on a null review before it gets here, but the gate is
  // kept independently safe: reachability is a property of the caller, and the
  // caller is exactly the thing that changes.
  for (const missing of [null, undefined, {}]) {
    const gate = reviewGate(missing, BRANCH, BASE)
    assert.ok(gate.warn)
    assert.equal(gate.blocked, undefined)
  }
})

test('a numeric string count is still usable', () => {
  // The schema asks for integers, but models do hand back "3". Rejecting that
  // would skip the gate on a branch that could have been checked.
  assert.equal(reviewGate(clean({ commitCount: '3', taggedCount: '3' }), BRANCH, BASE), null)
  assert.equal(reviewGate(clean({ commitCount: '3', taggedCount: '2' }), BRANCH, BASE).blocked, 'implement')
})

// ── isPlanHash / planHashMismatch ────────────────────────────────────────────

test('a Plan-Hash is exactly 8 lowercase hex characters', () => {
  assert.equal(isPlanHash('a1b2c3d4'), true)
  assert.equal(isPlanHash('00000000'), true)
  for (const bad of ['A1B2C3D4', 'a1b2c3d', 'a1b2c3d4e', 'a1b2c3g4', '', '  a1b2c3d4', null, undefined, 12345678]) {
    assert.equal(isPlanHash(bad), false, `${JSON.stringify(bad)} is not a plan hash`)
  }
})

test('matching hashes report no drift', () => {
  assert.equal(planHashMismatch('a1b2c3d4', 'a1b2c3d4'), null)
})

test('a hash that changed mid-run is named as a MODIFIED PLAN, not a bad commit', () => {
  // The gate downstream will say "0 of 3 commits carry their trailer", which
  // reads as an implementation failure. It is not: the plan moved underneath
  // commits that were correct when written. Only this comparison can say so.
  const drift = planHashMismatch('a1b2c3d4', 'ffffffff')
  assert.match(drift, /a1b2c3d4/)
  assert.match(drift, /ffffffff/)
  assert.match(drift, /modified after implementation/)
})

test('drift is not claimed when either hash is unusable', () => {
  // A stage that failed to report its hash tells us nothing about the other
  // one; inventing a mismatch there would send someone after a phantom.
  assert.equal(planHashMismatch(undefined, 'a1b2c3d4'), null)
  assert.equal(planHashMismatch('a1b2c3d4', ''), null)
  assert.equal(planHashMismatch('not-a-hash', 'a1b2c3d4'), null)
  assert.equal(planHashMismatch(null, null), null)
})
