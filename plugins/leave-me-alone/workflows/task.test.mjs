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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadPure } from './load-pure.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const { verificationGate, reviewGate, isPlanHash, planHashMismatch, explorationOutputGate, shortId, stemOf, shellQuote, statusWriteOutcome } = await loadPure(join(HERE, 'task.js'), [
  'verificationGate', 'reviewGate', 'isPlanHash', 'planHashMismatch', 'explorationOutputGate', 'shortId', 'stemOf', 'shellQuote', 'statusWriteOutcome',
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
  assert.match(verificationGate([], undefined, false).detail, /Exploration found none/)
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

// ── explorationOutputGate ────────────────────────────────────────────────────
// Added after a live run (#1296) where the explore agent did real work, then
// its StructuredOutput call omitted the required `verification` field three
// times in a row (schema-valid summary text apparently crowding it out), and
// on the fourth attempt it gave up and submitted a placeholder that trivially
// satisfies the schema: summary="test", verification.fullSuite=["a"]. Spec
// then correctly refused to invent a design from "test" and self-blocked —
// which read as a Spec-stage bug when the real defect was here: nothing
// checked that Explore's output was real before trusting it.

const realSummary = 'graph_canvas.js renderEdges (lines 228-253) needs a transparent hit-path emitted before the visible path, per issue #1296; graph_shell.css needs the matching cursor rule.'
const realVerification = { fullSuite: ['uv run pytest tests/unit -q', 'uv run ruff check .'] }

test('a real summary and plausible verification pass the gate', () => {
  assert.equal(explorationOutputGate({ summary: realSummary, verification: realVerification }, null), null)
})

test('the #1296 placeholder output is caught: short summary', () => {
  const gate = explorationOutputGate({ summary: 'test', verification: { fullSuite: ['a'] } }, null)
  assert.match(gate.detail, /implausibly short/)
})

test('a summary that is exactly a known placeholder word is caught, even case-insensitively', () => {
  for (const word of ['todo', 'TBD', 'n/a', 'None', 'placeholder']) {
    const gate = explorationOutputGate({ summary: word, verification: realVerification }, null)
    assert.ok(gate, `${JSON.stringify(word)} should be caught`)
  }
})

test('a fullSuite command that is not plausible (single letter, like "a") is caught', () => {
  const gate = explorationOutputGate({ summary: realSummary, verification: { fullSuite: ['a'] } }, null)
  assert.match(gate.detail, /implausible command/)
})

test('when the caller provided verification, explore must return it EXACTLY unchanged', () => {
  const provided = { fullSuite: ['make test', 'make lint'] }
  assert.equal(
    explorationOutputGate({ summary: realSummary, verification: { fullSuite: ['make test', 'make lint'] } }, provided),
    null)
  const gate = explorationOutputGate({ summary: realSummary, verification: { fullSuite: ['a'] } }, provided)
  assert.match(gate.detail, /did not return the caller-provided verification/)
})

test('a missing or non-array fullSuite is caught, not thrown on', () => {
  assert.ok(explorationOutputGate({ summary: realSummary, verification: {} }, null))
  assert.ok(explorationOutputGate({ summary: realSummary }, null))
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

// ── statusWriteOutcome ───────────────────────────────────────────────────────
// A brd status write is best-effort (missing PATH entry, a denied permission
// prompt, …) so it must never sink a subtask whose PR is already open and
// green — but that failure must not vanish into a run that reads as fully
// clean either. This is the fold that turns collected rollup errors into what
// the caller reports.

test('no status-write errors means the write is reported clean', () => {
  assert.deepEqual(statusWriteOutcome([]), { statusWritten: true })
  assert.deepEqual(statusWriteOutcome(undefined), { statusWritten: true })
})

test('a single status-write failure is surfaced, not swallowed', () => {
  assert.deepEqual(statusWriteOutcome(['rollup (done) failed: brd: command not found']),
    { statusWritten: false, statusWriteError: 'rollup (done) failed: brd: command not found' })
})

test('both dispatch sites failing are both reported, not just the last one', () => {
  const out = statusWriteOutcome(['rollup (in_progress) failed: denied', 'rollup (done) failed: denied'])
  assert.equal(out.statusWritten, false)
  assert.match(out.statusWriteError, /in_progress.*denied.*done.*denied/s)
})

// ── card identity: shortId / stemOf ──────────────────────────────────────────
// task.js inlines shortId rather than importing scripts/naming.mjs (a Workflow
// script has no module resolution), so this pins the inlined copy to the real
// one byte-for-byte in BEHAVIOR — no second copy to drift silently.

test('the inlined shortId matches the real naming.mjs', async () => {
  const { shortId: real } = await import('../scripts/naming.mjs')
  const id = 'a32af745-15ef-45cd-b52c-64c19ae82c17'
  assert.equal(shortId(id), real(id))
  assert.throws(() => shortId('nope'))
  assert.throws(() => real('nope'))
})

test('the inlined shortId lowercases an uppercase UUID, matching naming.mjs', async () => {
  // The parity test above uses an already-lowercase UUID, which cannot catch
  // a dropped `.toLowerCase()` — plan-check.mjs validates `[0-9a-f]{8}` and
  // would reject an uppercase id outright, so lowercasing is load-bearing.
  const { shortId: real } = await import('../scripts/naming.mjs')
  const upper = 'A32AF745-15EF-45CD-B52C-64C19AE82C17'
  assert.equal(shortId(upper), 'a32af745')
  assert.equal(shortId(upper), real(upper))
})

test('the artifact stem comes from the branch, so it cannot disagree with it', async () => {
  assert.equal(stemOf('m12/task-write-rows-a32af745'), 'task-write-rows-a32af745')
  assert.equal(stemOf('task-a32af745'), 'task-a32af745')
})

// ── shellQuote ────────────────────────────────────────────────────────────────
// The one place a model-supplied string (a card's title) reaches a command
// line an agent runs verbatim — exactly what the PURE region exists to pin.

test('shellQuote wraps a plain string in single quotes', () => {
  assert.equal(shellQuote('feat: write rows'), "'feat: write rows'")
})

test('shellQuote escapes an embedded single quote', () => {
  // The standard shell trick: close the quote, emit an escaped quote, reopen.
  assert.equal(shellQuote("it's a title"), "'it'\\''s a title'")
})

test('shellQuote coerces a non-string value', () => {
  assert.equal(shellQuote(42), "'42'")
})

// ── no GraphQL survives ──────────────────────────────────────────────────────
// task.js used to build GitHub GraphQL mutation strings and hand them to an
// agent as a natural-language prompt to run verbatim. That is a string built
// for an agent to execute, so the pure-region tests above cannot see it — it
// has to be caught by reading the file as text.

test('no GraphQL survives anywhere in task.js', () => {
  const source = readFileSync(new URL('./task.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /updateProjectV2ItemFieldValue|projectItems|fieldValueByName/,
    'a board mutation is still being built here')
  assert.doesNotMatch(source, /api graphql/, 'a graphql call is still being built here')
})

test('the board argument and its option names are gone', () => {
  const source = readFileSync(new URL('./task.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /DEFAULT_OPTION_NAMES|resolveProject|statusField/)
})

test('the status rollup goes through rollup.mjs, not a board mutation prompt', () => {
  const source = readFileSync(new URL('./task.js', import.meta.url), 'utf8')
  assert.match(source, /rollup\.mjs --card \$\{card\} --status in_progress --repo-dir \$\{repoDir\} --compact/)
  assert.match(source, /rollup\.mjs --card \$\{card\} --status done --repo-dir \$\{repoDir\} --compact/)
})

test('both rollup dispatch sites feed statusWriteErrors — a failure does not vanish into log() alone', () => {
  const source = readFileSync(new URL('./task.js', import.meta.url), 'utf8')
  assert.match(source, /statusWriteErrors\.push/, 'no dispatch site records a status-write failure')
  const pushCount = (source.match(/statusWriteErrors\.push/g) || []).length
  assert.equal(pushCount, 4, // 2 per site (agent-died branch + rollupOut.error branch) x 2 sites
    `expected both the Explore and Ship rollup tails to feed statusWriteErrors, got ${pushCount} push site(s)`)
  assert.match(source, /statusWriteOutcome\(statusWriteErrors\)/,
    'the final return does not fold the collected status-write errors into what the caller sees')
})

test('ship.mjs is given the full card id, not the short id — a short id cannot be pasted into brd show', () => {
  const source = readFileSync(new URL('./task.js', import.meta.url), 'utf8')
  assert.match(source, /ship\.mjs --repo \$\{repo\} --card \$\{card\}/)
  assert.doesNotMatch(source, /ship\.mjs --repo \$\{repo\} --card \$\{id\}/)
})
