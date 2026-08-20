<!-- task-pipeline: validated -->
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

---

# `scripts/gh.mjs` Helper Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `scripts/README.md` documenting all ten exports of `scripts/gh.mjs` — inputs, return value, and reason for existing — matching the current source exactly.

**Architecture:** One new Markdown file, no code change. The document opens with the repo convention that explains the shape of the helpers ("Everything mechanical lives in `scripts/`, runs under `bun`, and is unit-tested without a network" — `workflows/README.md:28`), then lists one `###` entry per export in source order. Because there is no module to key a sibling test off, the gate that replaces a unit test is a mechanical fidelity check: a one-off `node` snippet that extracts every `export function` / `export async function` name from `scripts/gh.mjs` and fails if any name lacks a matching `### \`name(` heading in the README. That check is run RED (before the file exists) and GREEN (after).

**Tech Stack:** Markdown; Node's built-in test runner (`node --test`) and `scripts/check-workflows.mjs` for the unchanged regression gates. No new dependencies.

**Spec:** `docs/superpowers/specs/issue-37-design.md` (prepended verbatim above the plan header)

## Global Constraints

- Worktree: `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-37`, branch `m4/task-37`, cut fresh from `origin/m4/task-35`. Do not assume any other subtask's code is present; read files from this worktree only.
- Exactly one file may change: `scripts/README.md` (added). `scripts/gh.mjs`, `scripts/gh.test.mjs`, `README.md` and `workflows/README.md` are read-only context.
- The ten exports, in source order: `ghRunner`, `ghError`, `gitRunner`, `jsonFrom`, `lastLine`, `parseNdjson`, `truncate`, `firstLine`, `withRetries`, `readFlags`.
- Signatures are copied verbatim from source: `ghRunner(args)`, `ghError(err)`, `gitRunner(args)`, `jsonFrom(text)`, `lastLine(text)`, `parseNdjson(text)`, `truncate(text, max)`, `firstLine(text)`, `withRetries(label, attempt, tries = 3)`, `readFlags(argv, spec)`.
- Pinned details that must appear exactly: `maxBuffer` of 64 MB on both runners; `ghError`'s `'unknown error'` fallback; `jsonFrom`'s thrown `expected JSON, got: <first 200 chars>` with `(empty)` for no text; `truncate`'s single trailing `…` (U+2026) and pure length cut; `withRetries`' `tries = 3` default, **no delay between attempts**, rejection message `${label} failed after ${tries} attempts: ${last && last.message}` and `cause` carrying the last error; `readFlags`' thrown `unknown argument "<arg>"`.
- Prose is **not** hard-wrapped — one line per paragraph/bullet.
- No new tests (per spec Test list). The repo's placement rule is same-directory sibling keyed by filename; there is no new module, so there is no test file to add. Were one ever needed it would be `scripts/gh.test.mjs`, which already exists and is not touched here.

---

### Task 1: `scripts/README.md`

**Files:**
- Create: `scripts/README.md`
- Read-only context: `scripts/gh.mjs:1-104`, `workflows/README.md:26-38`
- Test: none (spec: "No new tests"; docs-only change, no module for a sibling test to key off). The RED/GREEN cycle below runs against the mechanical fidelity check instead.

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the only task).
- Produces: nothing importable. The deliverable is the file `scripts/README.md` containing one `### \`<name>(<params>)\`` heading per export of `scripts/gh.mjs`.

- [ ] **Step 1: Write the failing check (RED)**

There is no new module here, so the gate is a source-fidelity check rather than a unit test. Save nothing — this is a one-off command run from the worktree root.

```bash
cd /home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-37
node --input-type=module -e '
import { readFile } from "node:fs/promises"
const src = await readFile("scripts/gh.mjs", "utf8")
const doc = await readFile("scripts/README.md", "utf8")
const names = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1])
const missing = names.filter(n => !doc.includes("### `" + n + "("))
console.log(names.length + " exports found; undocumented: " + (missing.join(", ") || "none"))
process.exit(missing.length === 0 && names.length === 10 ? 0 : 1)
'
```

- [ ] **Step 2: Run the check to verify it fails**

Run the command from Step 1.
Expected: FAIL — `ENOENT: no such file or directory, open 'scripts/README.md'`, non-zero exit. `scripts/README.md` does not exist yet on this branch.

- [ ] **Step 3: Create `scripts/README.md`**

Write this file exactly. It documents the ten exports in source order; every signature, default and thrown message below was copied from `scripts/gh.mjs` in this worktree.

````markdown
# scripts

Everything mechanical lives here: it runs under `bun`, and is unit-tested without a network (`workflows/README.md`). Each script is also usable standalone for inspecting or debugging a run — that table is in `workflows/README.md`.

This page documents `gh.mjs`, the shared plumbing every one of those scripts imports. It exists because a Workflow script cannot execute a command, so anything that has to touch GitHub either runs out here or gets carried out by a model — and out here there is no latitude, no transcription, and it is testable.

Each entry below is one export of `scripts/gh.mjs`, in the order it appears in the source: what it takes, what it returns, and why it exists.

### `ghRunner(args)`

**Takes** `args`, an array of argument strings for the `gh` CLI. **Returns** a promise resolving to the command's `stdout` as a string; rejects with the `execFile` error when `gh` exits non-zero. Runs through `execFile` with a 64 MB `maxBuffer`, because a paginated `gh api` response is far larger than Node's default cap.

**Why:** it is the injectable seam. Every helper script takes its runner as a parameter defaulting to this one, so the logic above it can be unit-tested without a network.

### `ghError(err)`

**Takes** `err`, a rejected `execFile` error. **Returns** the first non-blank line of its `stderr`; when there is no usable `stderr`, the first line of `err.message`; when there is neither, `'unknown error'`.

**Why:** `execFile`'s own message is `Command failed: <the entire command>\n<stderr>`, which for a GraphQL query buries the actual error under a couple hundred characters of query text. The useful part is almost always the first line of stderr.

### `gitRunner(args)`

**Takes** `args`, an array of argument strings for `git`. **Returns** a promise resolving to `stdout`, under the same 64 MB `maxBuffer`.

**Why:** the same shape as `ghRunner`, for `git`, so the scripts that touch a checkout are injectable too.

### `jsonFrom(text)`

**Takes** `text`, captured stdout. **Returns** the parsed value, `JSON.parse`d from the first `[` or `{` onwards. **Throws** `expected JSON, got: <first 200 characters, trimmed>` when the text contains no structural character at all — or `expected JSON, got: (empty)` when there is nothing to quote.

**Why:** tool managers print activation banners into stdout the first time they resolve a binary — `mise ~/.config/mise/config.toml tools: gh@2.97.0` broke the very first real run of `detect.mjs`. That text is not our output, and it is not specific to mise (direnv and nvm do the same), so parsing starts at the first structural character rather than assuming byte zero.

### `lastLine(text)`

**Takes** `text`, captured stdout. **Returns** the last non-blank line, trimmed, or `''` when there are none.

**Why:** the same banner problem as `jsonFrom`, for plain-text output — the value we asked for is the LAST line, with any banner above it.

### `parseNdjson(text)`

**Takes** `text`, newline-delimited JSON. **Returns** an array of parsed values: the text is split on newlines, each line trimmed, lines not starting with `{` or `[` dropped, and each surviving line `JSON.parse`d. A `JSON.parse` failure on a kept line propagates.

**Why:** `gh api --paginate --jq '.[] | …'` emits one JSON object per line rather than a single array, because concatenated pages would not be valid JSON.

### `truncate(text, max)`

**Takes** `text` (anything; `null` and `undefined` become `''`, everything else goes through `String()`) and `max`, a length in code units — there is no default, so callers pass one. **Returns** the text unchanged when its length is `<= max`, otherwise its first `max` code units followed by a single `…` (U+2026). No trimming, no ANSI handling, no word-boundary logic — a pure length cut.

**Why:** bounded text for log lines and PR bodies.

### `firstLine(text)`

**Takes** `text`, captured output. **Returns** the first non-blank line, trimmed, or `''` when there are none. Blank and whitespace-only lines are not lines for this purpose — they are skipped, not counted.

**Why:** the mirror of `lastLine`, for output whose useful value is the FIRST line — an error summary or a one-line `gh` answer, with noise below it.

### `withRetries(label, attempt, tries = 3)`

**Takes** `label`, a string naming the operation for the failure message; `attempt`, an async function to call; and `tries`, defaulting to `3`. **Returns** the first successful result of `attempt()`. Attempts run back to back with **no delay between them** — there is no backoff. When every attempt throws, it rejects with an `Error` whose message is `<label> failed after <tries> attempts: <last error's message>` and whose `cause` is the last error itself, so the original is never lost.

**Why:** a single transient failure from a `gh` call should not end a run, and every caller wanting that behaviour should express it the same way instead of hand-rolling a loop.

### `readFlags(argv, spec)`

**Takes** `argv`, an array of raw CLI arguments (typically `process.argv.slice(2)`), and `spec`, a map of flag name — including the leading `--` — to kind. **Returns** an object keyed by those same flag names. A flag whose kind is `'boolean'` is set to `true` and consumes no following argument; a flag of any other kind takes its inline value from `--flag=value`, or else the next argument in `argv`. **Throws** `unknown argument "<arg>"` for anything not present in `spec`.

**Why:** shared by every script here — a bare `--flag` or a `--flag value` / `--flag=value` pair — rejecting anything unrecognised rather than ignoring it, so a typo'd flag fails loudly instead of silently changing what a run does.
````

- [ ] **Step 4: Run the check to verify it passes (GREEN)**

Run the same command as Step 1.
Expected: PASS — `10 exports found; undocumented: none`, exit 0.

- [ ] **Step 5: Verify the pinned details by eye against the source**

Open `scripts/gh.mjs` beside the new README and confirm each of these, which are the entries most prone to drift:

- `ghRunner` / `gitRunner`: `maxBuffer: 64 * 1024 * 1024` (`scripts/gh.mjs:14`, `:32`) — README says 64 MB for both.
- `ghError`: `'unknown error'` final fallback (`scripts/gh.mjs:27`).
- `jsonFrom`: message `expected JSON, got: ${raw.slice(0, 200).trim() || '(empty)'}` (`scripts/gh.mjs:44`).
- `truncate`: signature `truncate(text, max)` with **no default** for `max`, and a single `…` appended (`scripts/gh.mjs:67-70`).
- `withRetries`: signature `withRetries(label, attempt, tries = 3)`, no `await` on any delay inside the loop, message `${label} failed after ${tries} attempts: ${last && last.message}`, `error.cause = last` (`scripts/gh.mjs:81-89`).
- `readFlags`: message `unknown argument "${argv[i]}"` (`scripts/gh.mjs:98`).

Expected: every one matches the README text written in Step 3. If any does not, fix the README — the source is authoritative and must not be edited.

- [ ] **Step 6: Run the full suite**

```bash
cd /home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-37
node --test workflows/*.test.mjs scripts/*.test.mjs
```

Expected: PASS, `fail 0`. This is a regression check that no module was accidentally touched — the change is Markdown only, so the counts must match the pre-change run.

- [ ] **Step 7: Run lint**

```bash
cd /home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-37
node scripts/check-workflows.mjs
```

Expected: PASS — `checked 2 workflow script(s); 0 failed`, exit 0.

- [ ] **Step 8: Confirm exactly one added file**

```bash
cd /home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-37
git status --porcelain
git diff --stat
```

Expected: `git diff --stat` shows no output at all — nothing already tracked was modified. `git status --porcelain` shows `?? scripts/README.md` as the only source change; the only other permitted entries are this workflow's own `docs/superpowers/specs/issue-37-design.md` and `docs/superpowers/plans/issue-37.md` (untracked if not already committed by an earlier step of the run). Anything else — any modified tracked file, any other new file — is out of scope and must be reverted before committing.

- [ ] **Step 9: Commit**

```bash
cd /home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-37
git add scripts/README.md docs/superpowers/specs/issue-37-design.md docs/superpowers/plans/issue-37.md
git commit -m "docs: document the gh.mjs helpers in scripts/README.md"
```

Expected: the commit contains `scripts/README.md` plus the spec and plan documents this workflow writes into the worktree, and nothing else.
