<!-- task-pipeline: validated -->
# Issue #34 — `31.1 feat(gh): add truncate() helper`

Milestone 4 ("Concurrency smoke"), parent story #31 "gh.mjs text helpers" — a throwaway smoke story whose whole point is that two helpers land one at a time in the same file. This spec narrows the already-agreed story design to the first of those two helpers.

## Scope

Add one new named export, `truncate(text, max)`, to `/home/paulomtts/Code/leave-me-alone/scripts/gh.mjs`, and create `/home/paulomtts/Code/leave-me-alone/scripts/gh.test.mjs` to cover it.

`truncate` is pure string logic: no I/O, no `execFile`, no injected runner. It belongs with the other small pure text helpers in that file — `jsonFrom`, `lastLine`, `parseNdjson` — and should be appended alongside them rather than at the top of the module.

Out of scope, explicitly:

- `firstLine()` — that is the entirety of sibling subtask #35 and must not appear here, not even as a stub.
- Any change to the existing exports: `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `withRetries`, `readFlags`. They are left byte-for-byte untouched.
- Any new call site. Nothing in the repo consumes `truncate` yet; this subtask adds the helper and its tests only.

## Observable behavior

`truncate(text, max)` returns a string, always.

- **At or under the limit.** When the coerced text is at most `max` characters long, it is returned unchanged — no ellipsis, no trimming, no normalization of whitespace or newlines.
- **Over the limit.** Otherwise the return value is the first `max` characters of the coerced text followed by a single `…` character (U+2026, one character — not three dots). The result is therefore `max + 1` characters long. The `max` characters are counted the way JavaScript counts them, i.e. `String.prototype.slice`; no attempt is made to respect word or grapheme boundaries.
- **Non-string input.** Coerced with `String(...)` and then measured and sliced as above, so `truncate(12345, 3)` yields `'123…'`.
- **null / undefined input.** Special-cased ahead of the general coercion to the empty string: `truncate(null, n)` and `truncate(undefined, n)` both return `''`, never `'null'` or `'undefined'`. Since `''` is at most any non-negative `max`, this falls out as an unchanged return of `''`.

## Error paths

There are none. `truncate` never throws and has no failure mode to report: every input is either coerced or carved out to `''`, and the function has no dependencies that can fail. Degenerate `max` values (`0`, negative, non-numeric) are not specified behavior for this subtask — the issue body defines behavior only for the at-most/over-limit split — so the implementation should simply let the natural `slice` semantics apply rather than adding validation or throwing.

## Test placement

This repo has no tiered test taxonomy — no `unit/`, `integration/`, `e2e/`, or conformance split exists anywhere in it, and there is no CLAUDE.md or ADR to cite (`docs/` is present but empty). The convention, read directly from the existing suite, is: **one flat test file per source module, colocated in the same directory as the module and named `<module>.test.mjs`, run under `node --test`** — as in `resolve.mjs`/`resolve.test.mjs`, `worktree.mjs`/`worktree.test.mjs`, `ship.mjs`/`ship.test.mjs`, `detect.mjs`/`detect.test.mjs`, `plan-check.mjs`/`plan-check.test.mjs`, `check-workflows.mjs`/`check-workflows.test.mjs`. The issue body restates the rule for this exact case: tests go in a new file `scripts/gh.test.mjs`.

So every test below sits in **the single flat tier — `scripts/gh.test.mjs`** — under a `// ── truncate ──` section comment, matching the section-comment style of `resolve.test.mjs`. That same file will later also hold `firstLine()`'s tests from #35; nothing here is split across files or tiers. Tests import `truncate` as an ESM named import from `./gh.mjs` and use `node:test` + `node:assert/strict`, calling the function directly — no fakes or injection, because there is nothing to inject.

## Test list

All in `scripts/gh.test.mjs` (flat tier — the only tier this repo has):

1. **Text shorter than the limit comes back untouched** — a string well under `max` is returned identical, with no ellipsis appended.
2. **Text exactly at the limit comes back untouched** — the boundary case: length `=== max` is "at most", so still no ellipsis. This is the one that distinguishes `<` from `<=`.
3. **Text one character over the limit is cut and marked** — length `max + 1` yields the first `max` characters plus `…`; asserts both the prefix and that the result ends with the single ellipsis character.
4. **The ellipsis is one character, not three dots** — asserts the exact returned string / its length is `max + 1`, pinning U+2026 rather than `...`.
5. **A non-string is coerced with `String(...)`** — e.g. a number, asserting both the unchanged-when-short path and the truncated path over its string form.
6. **`null` becomes an empty string** — `truncate(null, 5)` is `''`, explicitly not `'null'`.
7. **`undefined` becomes an empty string** — `truncate(undefined, 5)` is `''`, explicitly not `'undefined'`; also covers the no-argument call.
8. **Newlines and whitespace are preserved, not collapsed** — unlike `lastLine`/`ghError`, `truncate` does no trimming or line splitting; a multi-line input under the limit returns verbatim.

## Verification

- Full suite: `node --test workflows/*.test.mjs scripts/*.test.mjs`
- Typecheck: none.
- Lint: `node scripts/check-workflows.mjs` — it only parses and smoke-inits `workflows/*.js` and does not touch `scripts/gh.mjs`, so it should be unaffected by this change, but it is part of the required gate and must still pass.

---

# gh.mjs `truncate()` Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single pure named export `truncate(text, max)` to `scripts/gh.mjs`, covered by a new colocated `scripts/gh.test.mjs`.

**Architecture:** `truncate` is pure string logic with no I/O, so it is appended to `scripts/gh.mjs` immediately after `parseNdjson` — beside the other small pure text helpers (`jsonFrom`, `lastLine`, `parseNdjson`) and before `withRetries`, which starts the async/plumbing half of the module. Tests are direct calls with no fakes or injection, in the single flat colocated test tier this repo uses. The behavior is built in two RED/GREEN cycles: first the "returned unchanged" half (including the `null`/`undefined` carve-out), then the over-the-limit ellipsis half.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test`, `node:assert/strict`. No dependencies added.

**Spec:** `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-34/docs/superpowers/specs/issue-34-design.md` (reproduced verbatim above).

## Global Constraints

- Work happens in the worktree `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-34` on branch `m4/task-34`, cut fresh from `origin/master`. Do not assume any other subtask's code exists on this branch.
- Exactly one new export is added: `truncate`. The eight existing exports — `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `withRetries`, `readFlags` — are left byte-for-byte untouched.
- `firstLine()` is subtask #35's scope. It must not appear in this branch, not even as a stub or a test.
- No new call site: nothing in the repo consumes `truncate` yet.
- The ellipsis is the single character `…` (U+2026), never `...`. An over-limit result is exactly `max + 1` characters long.
- `null` and `undefined` are special-cased to `''` ahead of the general `String(...)` coercion — never `'null'` / `'undefined'`.
- No validation of degenerate `max` (`0`, negative, non-numeric); natural `slice` semantics apply. `truncate` never throws.
- Test file: one flat colocated file per module, `scripts/gh.test.mjs`, run under `node --test`. No tiered directories exist in this repo; do not create any.
- Verification gate (both must pass): `node --test workflows/*.test.mjs scripts/*.test.mjs` and `node scripts/check-workflows.mjs`.

---

### Task 1: `truncate` returns text unchanged at or under the limit

**Files:**
- Create: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-34/scripts/gh.test.mjs`
- Modify: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-34/scripts/gh.mjs` (insert after `parseNdjson`, which ends at line 63, and before `withRetries` at line 65)
- Test: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-34/scripts/gh.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks. This is the first task on the branch.
- Produces: `export function truncate(text, max)` in `scripts/gh.mjs` — takes any value as `text` and a number `max`, always returns a `string`. Task 2 extends the same function; no other task depends on it.

- [ ] **Step 1: Write the failing tests**

Create `scripts/gh.test.mjs` with exactly this content (header comment and `// ── name ──` section-comment style match `scripts/resolve.test.mjs`):

```js
// Tests for the shared `gh` plumbing. These helpers are pure string logic, so
// they are called directly — nothing to inject, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncate } from './gh.mjs'

// ── truncate ─────────────────────────────────────────────────────────────────

test('text shorter than the limit comes back untouched', () => {
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(truncate('', 10), '')
})

test('text exactly at the limit comes back untouched', () => {
  // "at most max" is <=, not <: no ellipsis at the boundary.
  assert.equal(truncate('abcde', 5), 'abcde')
})

test('null becomes an empty string, not "null"', () => {
  assert.equal(truncate(null, 5), '')
})

test('undefined becomes an empty string, not "undefined"', () => {
  assert.equal(truncate(undefined, 5), '')
  assert.equal(truncate(), '')
})

test('newlines and whitespace are preserved, not collapsed', () => {
  // Unlike lastLine/ghError, truncate does no trimming or line splitting.
  const text = '  first\n\nsecond  '
  assert.equal(truncate(text, 100), text)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/gh.test.mjs`
Expected: FAIL — the import throws `SyntaxError: The requested module './gh.mjs' does not provide an export named 'truncate'`.

- [ ] **Step 3: Write the minimal implementation**

In `scripts/gh.mjs`, insert this immediately after the closing `}` of `parseNdjson` (line 63) and before `export async function withRetries` (line 65), separated by a blank line on each side:

```js
// Bounded text for log lines and PR bodies. Pure: no trimming, no word
// boundaries — just the first `max` code units.
export function truncate(text, max) {
  if (text === null || text === undefined) return ''
  return String(text)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/gh.test.mjs`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/gh.mjs scripts/gh.test.mjs
git commit -m "feat(gh): add truncate() helper, unchanged-at-or-under-limit path"
```

---

### Task 2: `truncate` cuts and marks text over the limit

**Files:**
- Modify: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-34/scripts/gh.mjs` (the `truncate` body added in Task 1)
- Test: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-34/scripts/gh.test.mjs` (append to the existing `// ── truncate ──` section)

**Interfaces:**
- Consumes: `export function truncate(text, max)` from Task 1 — currently returns `''` for `null`/`undefined` and `String(text)` for everything else.
- Produces: the same `truncate(text, max)` export, now returning `String(text).slice(0, max) + '…'` when the coerced text is longer than `max`. Nothing later depends on it.

- [ ] **Step 1: Write the failing tests**

Append these three tests to the end of `scripts/gh.test.mjs`, still under the `// ── truncate ──` section:

```js
test('text one character over the limit is cut and marked', () => {
  const got = truncate('abcdef', 5)
  assert.equal(got, 'abcde…')
  assert.ok(got.startsWith('abcde'))
  assert.ok(got.endsWith('…'))
})

test('the ellipsis is one character, not three dots', () => {
  const got = truncate('abcdefghij', 4)
  assert.equal(got, 'abcd…')
  assert.equal(got.length, 5) // max + 1, so U+2026 rather than "..."
  assert.equal(got.slice(-1), '…')
})

test('a non-string is coerced with String(...)', () => {
  assert.equal(truncate(12345, 10), '12345')
  assert.equal(truncate(12345, 3), '123…')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/gh.test.mjs`
Expected: FAIL — 3 failing tests. The first reports `'abcdef' !== 'abcde…'`, because the current body returns the coerced text in full.

- [ ] **Step 3: Extend the implementation**

Replace the `truncate` body in `scripts/gh.mjs` with:

```js
// Bounded text for log lines and PR bodies. Pure: no trimming, no word
// boundaries — just the first `max` code units plus a single U+2026.
export function truncate(text, max) {
  if (text === null || text === undefined) return ''
  const raw = String(text)
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/gh.test.mjs`
Expected: PASS — 8 tests, 0 failures.

- [ ] **Step 5: Run the full verification gate**

Run, from the worktree root:

```bash
node --test workflows/*.test.mjs scripts/*.test.mjs
node scripts/check-workflows.mjs
```

Expected: the full suite passes with 0 failures (`scripts/gh.test.mjs` contributes 8 passing tests, every pre-existing file still passes), and `check-workflows.mjs` exits 0. There is no typecheck step in this repo.

- [ ] **Step 6: Confirm nothing outside scope changed**

Run: `git diff origin/master --stat`
Expected: exactly two paths — `scripts/gh.mjs` (additions only, no lines touched inside `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `withRetries`, `readFlags`) and `scripts/gh.test.mjs` (new file). No occurrence of `firstLine` anywhere in the diff.

- [ ] **Step 7: Commit**

```bash
git add scripts/gh.mjs scripts/gh.test.mjs
git commit -m "feat(gh): truncate() cuts over-limit text with a single ellipsis"
```
