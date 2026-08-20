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
