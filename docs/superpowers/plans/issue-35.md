<!-- task-pipeline: validated -->
# Issue #35 — `31.2 feat(gh): add firstLine() helper`

Milestone 4 ("Concurrency smoke"), parent story #31 "gh.mjs text helpers" — a throwaway smoke story whose whole point is that two helpers land one at a time in the same file. This spec narrows that already-agreed story design to the second of those two helpers. Sibling #34 (`truncate()`) has already landed on this branch, so `scripts/gh.mjs` and `scripts/gh.test.mjs` both already exist and already contain `truncate` and its suite.

## Scope

Add one new named export, `firstLine(text)`, to `/home/paulomtts/Code/leave-me-alone/scripts/gh.mjs`, and append its tests to the existing `/home/paulomtts/Code/leave-me-alone/scripts/gh.test.mjs`.

`firstLine` is pure string logic: no I/O, no `execFile`, no injected runner. It belongs with the other small pure text helpers in that file — `jsonFrom`, `lastLine`, `parseNdjson`, `truncate` — appended after `truncate` (which currently ends at `scripts/gh.mjs:71`) rather than at the top of the module. Note that `lastLine` (`scripts/gh.mjs:50-53`) already does the mirror-image job: split on `'\n'`, trim each line, drop empties, take the last. `firstLine` is that same logic taking the first, and should follow the same style, including a short `//` comment above it explaining why it exists, as every other helper in the file has.

Out of scope, explicitly:

- `truncate()` — frozen by the issue body ("Do not modify `truncate()`"). Its behavior, its implementation, and its existing tests are #34's and stay byte-for-byte as they are.
- Any change to the other existing exports: `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `withRetries`, `readFlags`. Untouched. In particular `lastLine` is not to be refactored into a shared internal even though the two overlap — "any other helper" is out of scope.
- Any new call site. Nothing in the repo consumes `firstLine` yet; this subtask adds the helper and its tests only.

## Observable behavior

`firstLine(text)` returns a string, always.

- **Normal input.** Returns the first non-empty line of the text, trimmed. Lines are delimited by `'\n'`; each line is trimmed of surrounding whitespace, empty results are skipped, and the first survivor is returned. So `'  hello  \nworld'` yields `'hello'`.
- **Leading blank or whitespace-only lines are skipped.** `'\n\n   \nreal'` yields `'real'` — a line that trims to `''` is not "the first line".
- **No non-empty line.** `''`, `'   '`, `'\n\n'` and similar all yield `''`.
- **Non-string input.** Coerced with `String(...)` before processing, matching the convention already in the file, so a number yields its decimal string.
- **null / undefined input.** Yield `''`, never `'null'` or `'undefined'`. The `String(text ?? '')` form used by `lastLine` and `jsonFrom` satisfies both this and the coercion rule in one expression.
- **Relationship to `lastLine`.** For single-non-empty-line input the two agree; for multi-line input they pick opposite ends. Nothing about `lastLine` changes.

## Error paths

There are none. `firstLine` never throws and has no failure mode to report: every input is coerced, and the function has no dependencies that can fail. No validation, no thrown errors — the empty-string return is the only "nothing found" signal.

## Test placement

This repo has no tiered test taxonomy — no `unit/`, `integration/`, `e2e/`, or conformance split exists anywhere in it, and there is no CLAUDE.md or ADR to cite (`docs/` is present but empty). The convention, read directly from the existing suite, is: **one flat test file per source module, colocated in the same directory as the module and named `<module>.test.mjs`, run under `node --test`** — as in `resolve.mjs`/`resolve.test.mjs`, `worktree.mjs`/`worktree.test.mjs`, `ship.mjs`/`ship.test.mjs`, `detect.mjs`/`detect.test.mjs`, `plan-check.mjs`/`plan-check.test.mjs`, `check-workflows.mjs`/`check-workflows.test.mjs`. The issue body restates the rule for this exact case: tests go into the existing `scripts/gh.test.mjs`.

So every test below sits in **the single flat tier — `scripts/gh.test.mjs`** — appended below the existing `// ── truncate ──` section under a new `// ── firstLine ──` section comment in the same style. No new test file and no new tier is created. Tests import `firstLine` as an ESM named import from `./gh.mjs` (extending the existing import line) and use `node:test` + `node:assert/strict`, calling the function directly — no fakes or injection, because there is nothing to inject. The existing `truncate` tests are left exactly as they are.

## Test list

All in `scripts/gh.test.mjs` (flat tier — the only tier this repo has), under `// ── firstLine ──`:

1. **The first line of multi-line text is returned** — `'first\nsecond\nthird'` yields `'first'`, pinning first-not-last against `lastLine`.
2. **The returned line is trimmed** — leading/trailing spaces and tabs on the chosen line are stripped.
3. **Leading blank lines are skipped** — text beginning with `'\n\n'` returns the first line that has content.
4. **Whitespace-only leading lines are skipped** — a line of only spaces/tabs is treated as empty, not returned as `''` or as whitespace.
5. **Text with no non-empty line returns `''`** — covers `''`, `'   '`, and `'\n\n'`.
6. **Single-line text is returned whole, trimmed** — no trailing-newline artifact for `'only\n'`.
7. **A non-string is coerced with `String(...)`** — e.g. a number returns its decimal string, not `''` and not a thrown error.
8. **`null` and `undefined` become an empty string** — explicitly not `'null'`/`'undefined'`; also covers the no-argument call.

## Verification

- Full suite: `node --test workflows/*.test.mjs scripts/*.test.mjs` — must include the pre-existing `truncate` tests still passing untouched.
- Typecheck: none.
- Lint: `node scripts/check-workflows.mjs` — it only parses and smoke-inits `workflows/*.js` and does not touch `scripts/gh.mjs`, so it should be unaffected by this change, but it is part of the required gate and must still pass.

---

# gh.mjs `firstLine()` Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single pure named export `firstLine(text)` to `scripts/gh.mjs`, covered by tests appended to the existing colocated `scripts/gh.test.mjs`.

**Architecture:** `firstLine` is pure string logic with no I/O, so it is appended to `scripts/gh.mjs` immediately after `truncate` (which ends at line 71) and before `withRetries` (line 73), beside the other small pure text helpers. It is the mirror of the existing `lastLine` at `scripts/gh.mjs:50-53` and follows its style, including the `String(text ?? '')` coercion form and a short `//` why-comment above it. Tests are direct calls with no fakes or injection, appended to the one flat colocated test file under a new `// ── firstLine ──` section. The behavior is built in two RED/GREEN cycles: first the naive "first line, trimmed, coerced" half, then the blank/whitespace-only-line skipping that forces the filter.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test`, `node:assert/strict`. No dependencies added.

**Spec:** `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-35/docs/superpowers/specs/issue-35-design.md` (reproduced verbatim above).

## Global Constraints

- Work happens in the worktree `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-35` on branch `m4/task-35`, cut fresh from `origin/m4/task-34`. `truncate` and its suite already exist there; do not assume any code from any other subtask.
- Exactly one new export is added: `firstLine`. The nine existing exports — `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `truncate`, `withRetries`, `readFlags` — are left byte-for-byte untouched.
- `truncate()` is explicitly frozen by the issue body: neither its implementation nor its existing tests in `scripts/gh.test.mjs` may change.
- `lastLine` is not refactored into a shared internal even though it overlaps; the duplication is intentional and in scope.
- No new call site: nothing in the repo consumes `firstLine` yet.
- `firstLine(text)` always returns a `string` and never throws. No validation, no thrown errors — `''` is the only "nothing found" signal.
- Coercion form is `String(text ?? '')`, matching `lastLine` and `jsonFrom`, so `null`/`undefined` yield `''` and never `'null'`/`'undefined'`.
- Lines are delimited by `'\n'` only. Each line is trimmed; lines that trim to `''` are skipped, not returned.
- Test file: one flat colocated file per module, `scripts/gh.test.mjs`, run under `node --test`. No tiered directories exist in this repo; do not create any.
- Verification gate (both must pass): `node --test workflows/*.test.mjs scripts/*.test.mjs` and `node scripts/check-workflows.mjs`. There is no typecheck.

---

### Task 1: `firstLine` returns the first line, trimmed and coerced

**Files:**
- Modify: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-35/scripts/gh.mjs` (insert after `truncate`, which ends at line 71, and before `export async function withRetries` at line 73)
- Test: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-35/scripts/gh.test.mjs` (extend the import on line 6; append a new section below the `truncate` suite, which ends at line 52)

**Interfaces:**
- Consumes: nothing from earlier tasks. The pre-existing `truncate(text, max)` export in `scripts/gh.mjs` is read-only context and must not change.
- Produces: `export function firstLine(text)` in `scripts/gh.mjs` — takes any value, always returns a `string`. Task 2 extends the same function; no other task depends on it.

- [ ] **Step 1: Extend the test file's import**

In `scripts/gh.test.mjs`, replace line 6:

```js
import { truncate } from './gh.mjs'
```

with:

```js
import { firstLine, truncate } from './gh.mjs'
```

Leave lines 1-5 and the whole `// ── truncate ──` suite (lines 8-52) untouched.

- [ ] **Step 2: Write the failing tests**

Append this to the end of `scripts/gh.test.mjs`, below the last `truncate` test. The section-comment style matches the existing `// ── truncate ──` line 8. Test names are prefixed with `firstLine` where the `truncate` suite already uses a similar sentence, so failures stay unambiguous in `node --test` output:

```js
// ── firstLine ────────────────────────────────────────────────────────────────

test('the first line of multi-line text is returned', () => {
  // The mirror of lastLine: same splitting, opposite end.
  assert.equal(firstLine('first\nsecond\nthird'), 'first')
})

test('the returned first line is trimmed', () => {
  assert.equal(firstLine('  hello  \nworld'), 'hello')
  assert.equal(firstLine('\thello\t\nworld'), 'hello')
})

test('single-line text is returned whole, trimmed', () => {
  // No trailing-newline artifact, and no empty-string from the trailing split.
  assert.equal(firstLine('only\n'), 'only')
  assert.equal(firstLine('only'), 'only')
})

test('firstLine coerces a non-string with String(...)', () => {
  assert.equal(firstLine(12345), '12345')
  assert.equal(firstLine(0), '0')
})

test('firstLine turns null and undefined into an empty string', () => {
  assert.equal(firstLine(null), '')
  assert.equal(firstLine(undefined), '')
  assert.equal(firstLine(), '')
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test scripts/gh.test.mjs`
Expected: FAIL — the import throws `SyntaxError: The requested module './gh.mjs' does not provide an export named 'firstLine'`, so the whole file errors out and no test runs.

- [ ] **Step 4: Write the minimal implementation**

In `scripts/gh.mjs`, insert this immediately after the closing `}` of `truncate` (line 71) and before `export async function withRetries` (line 73), separated by a blank line on each side:

```js
// The mirror of lastLine, for output whose useful value is the FIRST line —
// an error summary or a one-line `gh` answer, with noise below it.
export function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/gh.test.mjs`
Expected: PASS — 13 tests, 0 failures (the 8 pre-existing `truncate` tests plus the 5 new ones).

- [ ] **Step 6: Commit**

```bash
git add scripts/gh.mjs scripts/gh.test.mjs
git commit -m "feat(gh): add firstLine() helper, first-line-trimmed path"
```

---

### Task 2: `firstLine` skips blank and whitespace-only leading lines

**Files:**
- Modify: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-35/scripts/gh.mjs` (the `firstLine` body added in Task 1)
- Test: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-35/scripts/gh.test.mjs` (append to the existing `// ── firstLine ──` section)

**Interfaces:**
- Consumes: `export function firstLine(text)` from Task 1 — currently `String(text ?? '').split('\n')[0].trim()`, i.e. it returns `''` whenever the literal first line is blank.
- Produces: the same `firstLine(text)` export, now skipping every line that trims to `''` and returning the first survivor, or `''` when there is none. Nothing later depends on it.

- [ ] **Step 1: Write the failing tests**

Append these three tests to the end of `scripts/gh.test.mjs`, still under the `// ── firstLine ──` section:

```js
test('leading blank lines are skipped', () => {
  assert.equal(firstLine('\n\nreal'), 'real')
  assert.equal(firstLine('\nfirst\nsecond'), 'first')
})

test('whitespace-only leading lines are skipped', () => {
  // A line that trims to '' is not "the first line".
  assert.equal(firstLine('\n\n   \nreal'), 'real')
  assert.equal(firstLine('\t \nreal\nlast'), 'real')
})

test('text with no non-empty line is an empty string', () => {
  assert.equal(firstLine(''), '')
  assert.equal(firstLine('   '), '')
  assert.equal(firstLine('\n\n'), '')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/gh.test.mjs`
Expected: FAIL — 2 failing tests. `leading blank lines are skipped` reports `'' !== 'real'` and `whitespace-only leading lines are skipped` reports `'' !== 'real'`, because the current body returns the literal first line. `text with no non-empty line is an empty string` already passes.

- [ ] **Step 3: Extend the implementation**

Replace the `firstLine` body in `scripts/gh.mjs` with (same shape as `lastLine` at lines 50-53, taking the first survivor instead of the last):

```js
// The mirror of lastLine, for output whose useful value is the FIRST line —
// an error summary or a one-line `gh` answer, with noise below it. Blank and
// whitespace-only lines are not lines for this purpose.
export function firstLine(text) {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  return lines.length > 0 ? lines[0] : ''
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/gh.test.mjs`
Expected: PASS — 16 tests, 0 failures (8 `truncate`, 8 `firstLine`).

- [ ] **Step 5: Run the full verification gate**

Run, from the worktree root `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-35`:

```bash
node --test workflows/*.test.mjs scripts/*.test.mjs
node scripts/check-workflows.mjs
```

Expected: the full suite passes with 0 failures — `scripts/gh.test.mjs` contributes 16 passing tests, including the 8 pre-existing `truncate` tests still passing untouched — and `check-workflows.mjs` exits 0. There is no typecheck step in this repo.

- [ ] **Step 6: Confirm nothing outside scope changed**

Run: `git diff origin/m4/task-34 --stat` and `git diff origin/m4/task-34`
Expected: exactly two paths — `scripts/gh.mjs` (one added block plus nothing else; no line inside `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `truncate`, `withRetries`, or `readFlags` is touched) and `scripts/gh.test.mjs` (the one-line import change plus the appended `// ── firstLine ──` section; the `truncate` tests are unchanged). No file outside `scripts/` appears, and no call site of `firstLine` exists anywhere.

- [ ] **Step 7: Commit**

```bash
git add scripts/gh.mjs scripts/gh.test.mjs
git commit -m "feat(gh): firstLine() skips blank and whitespace-only lines"
```
