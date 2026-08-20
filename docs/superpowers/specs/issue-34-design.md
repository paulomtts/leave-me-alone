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
