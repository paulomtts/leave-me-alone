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
