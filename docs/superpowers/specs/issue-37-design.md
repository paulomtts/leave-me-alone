# Issue #37 — docs: document the `gh.mjs` helpers

Subtask of story #33 ("Document the gh.mjs helpers"), milestone 4 "Concurrency smoke". #37 is the only sub-issue of #33, so it carries the whole story.

## Scope

Add one new file, `scripts/README.md`, documenting every export of `/home/paulomtts/Code/leave-me-alone/scripts/gh.mjs` — one short entry per export covering what it takes, what it returns, and why it exists.

This is a pure documentation subtask. No code changes, no changes to `scripts/gh.mjs` itself, no new tests, no edits to `README.md` or `workflows/README.md`. Documenting anything outside `scripts/gh.mjs` is explicitly out of scope, including the sibling scripts (`detect.mjs`, `resolve.mjs`, `worktree.mjs`, `plan-check.mjs`, `ship.mjs`, `check-workflows.mjs`) which are already summarised in the `workflows/README.md` helper-scripts table.

The issue body carries a standing instruction that governs this work: **read the actual implementation.** This subtask lands after the helpers exist, so the document must describe what `gh.mjs` really does today, not what an earlier plan or spec said it would do. Every entry below was written from a full read of the file at its current state.

## Observable behavior

After this subtask, `scripts/README.md` exists and contains an entry for each of the ten exports below, in source order, with the "why" being the reason the helper exists rather than a restatement of its body. The framing throughout is the repo-wide convention stated in `workflows/README.md:28` — "Everything mechanical lives in `scripts/`, runs under `bun`, and is unit-tested without a network" — which is precisely why `ghRunner` and `gitRunner` are injectable seams.

The required entries, with the substance each must convey (all line numbers are in `scripts/gh.mjs`):

- **`ghRunner(args)`** (line 13) — async; runs `gh` with `args` via `execFile` under a 64 MB `maxBuffer` and resolves to `stdout`. Exists as an injectable seam so callers can be unit-tested without a network.
- **`ghError(err)`** (line 21) — takes a rejected `execFile` error, returns the first non-blank line of its `stderr`, falling back to the first line of `err.message` (or `'unknown error'` when neither is present). Exists because `execFile`'s own message is `Command failed: <entire command>\n<stderr>`, which for a GraphQL query buries the real error under a couple hundred characters of query text.
- **`gitRunner(args)`** (line 31) — the same shape as `ghRunner`, for `git`, so scripts that touch a checkout are injectable too.
- **`jsonFrom(text)`** (line 41) — parses JSON starting at the first `[` or `{` in `text`; throws `expected JSON, got: <first 200 chars>` (or `(empty)`) when there is no structural character. Exists because tool managers print activation banners onto stdout the first time they resolve a binary — `mise ~/.config/mise/config.toml tools: gh@2.97.0` broke the first real run of `detect.mjs`, and direnv and nvm do the same — so parsing starts from the first structural character rather than byte zero.
- **`lastLine(text)`** (line 50) — returns the last non-blank trimmed line, or `''`. The plain-text counterpart to `jsonFrom`: for plain output the wanted value is the last line, with any banner above it.
- **`parseNdjson(text)`** (line 57) — splits on newlines, trims each, keeps lines starting with `{` or `[`, and `JSON.parse`s each into an array. Exists because `gh api --paginate --jq '.[] | …'` emits one JSON document per line: concatenated pages would not be valid single-document JSON.
- **`truncate(text, max)`** (line 67) — coerces `null`/`undefined` to `''`, otherwise `String(text)`; returns the text unchanged when its length is `<= max`, otherwise the first `max` characters plus a single trailing `…` (U+2026). No trimming, no ANSI handling, no word-boundary logic — pure length cut. Exists to bound log lines and PR bodies.
- **`firstLine(text)`** (line 76) — the mirror of `lastLine`: returns the first non-blank trimmed line, or `''`. Blank and whitespace-only lines are skipped, not counted. Exists for output whose useful value is the first line — an error summary or a one-line `gh` answer — with noise below it.
- **`withRetries(label, attempt, tries = 3)`** (line 81) — awaits `attempt()` in a loop up to `tries` times (no delay between attempts), keeping the last error; on exhaustion rejects with `` `${label} failed after ${tries} attempts: ${last && last.message}` `` carrying the last error as `cause`.
- **`readFlags(argv, spec)`** (line 93) — parses `--flag`, `--flag value` and `--flag=value` against a `spec` map of flag name to kind; `'boolean'` kinds set `true` and consume no following argument, any other kind takes the inline or next argument. Throws `unknown argument "<arg>"` for anything not in `spec`, rejecting rather than silently ignoring.

Prose is not hard-wrapped. Nothing in the document may contradict the source; where the source comment states a rationale, the entry carries that rationale rather than inventing a new one.

## Error paths

None at runtime — no executable code is added or changed. The failure modes for this subtask are documentation drift: an entry that describes a signature, default, return value or thrown message that `scripts/gh.mjs` does not actually have, or an export left undocumented. `truncate`'s single-character `…` ellipsis, `withRetries`' `tries = 3` default and unretried (no backoff, no delay) loop, and the two thrown message formats (`expected JSON, got: …` and `unknown argument "…"`) are the details most likely to be misremembered rather than read; they are pinned above.

## Test list

The repo has **no test-tier taxonomy** — no `CLAUDE.md` anywhere, no populated `docs/`, and no unit/integration/e2e/conformance language in `agents/*.md` or `workflows/README.md` beyond the single generic line at `workflows/README.md:28`. The observed convention is flat: one `<name>.test.mjs` sits beside each `<name>.mjs` in the same directory (`detect.mjs`/`detect.test.mjs`, `resolve.mjs`/`resolve.test.mjs`, `ship.mjs`/`ship.test.mjs`, `worktree.mjs`/`worktree.test.mjs`, `plan-check.mjs`/`plan-check.test.mjs`, `check-workflows.mjs`/`check-workflows.test.mjs`), plus `workflows/*.test.mjs`, all run together by one command. Tier, for this repo, means "same-directory sibling keyed by filename."

**No new tests.** This subtask adds a Markdown file and touches no module, so under that placement rule there is no module for a sibling test to key off. `scripts/gh.mjs` already has `scripts/gh.test.mjs` beside it, covering `truncate` and `firstLine`; that file is read-only context for #37 and is not touched.

The existing suite is still run unchanged as a regression check that nothing was accidentally touched.

## Verification

```json
{"fullSuite":["node --test workflows/*.test.mjs scripts/*.test.mjs"],"typecheck":"","lint":["node scripts/check-workflows.mjs"]}
```

## Done when

- `scripts/README.md` exists and documents all ten exports of `scripts/gh.mjs` — `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `truncate`, `firstLine`, `withRetries`, `readFlags` — each with inputs, output, and reason for existing.
- Every documented signature and default matches the current source.
- `git diff --stat` shows exactly one added file and no other change.
- Both verification commands are green.
