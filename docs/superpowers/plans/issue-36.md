<!-- task-pipeline: validated -->
# Spec (verbatim)

# Issue #36 — `--quiet` flag for `check-workflows`

Subtask of story #32 ("check-workflows --quiet"), which is a throwaway smoke story. #36 is #32's only sub-issue; there are no siblings and no other work touching these files.

## Scope

One file of production code and one test file:

- `scripts/check-workflows.mjs` — the CLI entrypoint block guarded by `invokedDirectly` (lines 100–111).
- `scripts/check-workflows.test.mjs` — the existing colocated test file.

Explicitly out of scope: any flag other than `--quiet`; any change to `scripts/gh.mjs`; any change to the exported functions `wrapSource`, `checkFile`, `smokeInit`, `listWorkflowScripts`, or `checkWorkflows` and their signatures.

## Observable behavior

The CLI currently does `const args = process.argv.slice(2)` and treats every argument as a target file or directory path, falling back to `listWorkflowScripts(workflows/)` when `args` is empty. After this change:

1. `--quiet` is recognized anywhere in `process.argv.slice(2)` and is removed from the argument list before the remainder is used as `targets`. It is a flag, not a target: it must never be passed to `checkFile`/`smokeInit` as a path.
2. When `--quiet` is the only argument, the remaining target list is empty, so the existing no-argument fallback still applies — `node scripts/check-workflows.mjs --quiet` checks `workflows/*.js`, exactly like the bare invocation.
3. Without `--quiet`, output is byte-for-byte what it is today: the trailing summary `checked N workflow script(s); M failed` on stdout via `console.log`, plus one `FAIL <file>: <error>` line per failure on stderr.
4. With `--quiet` **and zero failures**, the trailing summary line is suppressed; stdout is empty.
5. With `--quiet` **and one or more failures**, the summary line still prints. `--quiet` only suppresses the success summary — a failing run stays fully diagnosable.
6. `FAIL <file>: <error>` lines from the `report()` callback (line 95, default `console.error`) are never suppressed, in either mode. `checkWorkflows` keeps its current default `report` and is called the same way from the CLI.
7. Exit code is unaffected by the flag in every case: `process.exit(failed.length > 0 ? 1 : 0)` stays ungated. `--quiet` with failures still exits 1; `--quiet` with no failures still exits 0.

## Error paths

- An unknown flag-looking argument (e.g. `--verbose`) is **not** given new handling: it continues to fall through as a target path and fails the way it does today (read error surfaced by `checkFile`). This subtask adds no argument validation.
- `--quiet` repeated more than once behaves as a single `--quiet`.
- A target file that happens to be literally named `--quiet` is not supported; the flag wins. This is acceptable and not worth guarding.

## Test placement

This repo has no tiered testing-standards doc (no `CLAUDE.md` at the repo root, `docs/` empty, no unit/integration/e2e taxonomy anywhere). The observed convention, read off the pair `scripts/check-workflows.mjs` + `scripts/check-workflows.test.mjs` and matching `workflows/README.md`'s helper-scripts table, is: **one flat test file per script, colocated as `scripts/<name>.test.mjs`, with no tier split** — the same file mixes CLI-level tests that spawn the script through the `runChecker(args)` `execFile` helper (line 30) with direct-import tests of exported functions (`smokeInit`, `SMOKE_ARGS`, imported at line 95).

So every test below goes in the single existing tier — the flat colocated file `scripts/check-workflows.test.mjs` — using the existing `runChecker([...])` CLI pattern. No new test file, no new tier, no new helper beyond the existing `fixture()` / `runChecker()`.

## Test list

All tests: flat colocated tier, `scripts/check-workflows.test.mjs`, CLI-invocation style via `runChecker`.

1. **`--quiet` alone suppresses the summary on a clean run** — `runChecker(['--quiet'])`; assert `code === 0` and `stdout` does not match `/checked \d+ workflow script\(s\)/`. Also covers point 2: the flag is stripped, so the `workflows/` fallback still runs and still passes.
2. **`--quiet` with an explicit passing target suppresses the summary** — write a valid fixture via `fixture('valid.js', VALID_WORKFLOW)`, `runChecker(['--quiet', file])`; assert `code === 0` and empty/summary-free `stdout`. Proves `--quiet` is not consumed as a target.
3. **Flag position does not matter** — same as (2) but `runChecker([file, '--quiet'])`; same assertions.
4. **Without `--quiet` the summary is unchanged** — the existing test at line 52 already asserts `/checked 2 workflow script\(s\); 0 failed/`; keep it as the regression anchor for point 3. No new test needed if it stays green.
5. **`--quiet` still prints failures** — `fixture('broken.js', BROKEN_WORKFLOW)`, `runChecker(['--quiet', file])`; assert `code !== 0`, and that `stdout + stderr` includes the file path and matches `/Unexpected token/`.
6. **`--quiet` does not change the exit code on failure** — covered by the `code !== 0` assertion in (5); assert explicitly `code === 1`.
7. **`--quiet` still prints the summary when something failed** — in the same failing run as (5), assert `stdout` matches `/checked 1 workflow script\(s\); 1 failed/`. This pins point 5 so a later "suppress everything" refactor breaks loudly.

## Verification

- fullSuite: `node --test workflows/*.test.mjs scripts/*.test.mjs` (baseline before the change: 155 passing, 0 failing — the new tests are additive).
- lint: `node scripts/check-workflows.mjs`
- typecheck: none.

---

# `check-workflows --quiet` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--quiet` flag to `scripts/check-workflows.mjs` that suppresses the trailing summary line on a clean run, while leaving failure output and exit codes untouched.

**Architecture:** The change is confined to the `invokedDirectly` CLI block at the bottom of `scripts/check-workflows.mjs` (lines 103–111). `--quiet` is detected in and filtered out of `process.argv.slice(2)` before the remainder becomes `targets`, so the empty-target fallback to `listWorkflowScripts(workflows/)` still fires when `--quiet` is the only argument. The `console.log` summary is then gated on `!quiet || failed.length > 0`. No exported function changes; `checkWorkflows(targets)` is still called with its default `report` callback, so `FAIL <file>: <error>` lines keep going to stderr in both modes, and `process.exit(failed.length > 0 ? 1 : 0)` is never gated.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, `node:child_process.execFile` for CLI-level tests. No dependencies added.

**Spec:** `docs/superpowers/plans/issue-36.md` (prepended above, verbatim) — original at `docs/superpowers/specs/issue-36-design.md`.

**Worktree:** `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/m4/task-36`, branch `m4/task-36`, cut fresh from `origin/master`. All paths below are relative to that worktree root; run all commands from it.

## Global Constraints

- Only two files may change: `scripts/check-workflows.mjs` and `scripts/check-workflows.test.mjs`. Do not touch `scripts/gh.mjs` or any other file.
- No flag other than `--quiet`. No argument validation is added: an unknown flag-looking argument (e.g. `--verbose`) still falls through as a target path and fails via `checkFile`'s read error.
- Do not change the signatures or behavior of the exported `wrapSource`, `checkFile`, `smokeInit`, `listWorkflowScripts`, or `checkWorkflows`.
- The summary string stays exactly `checked ${results.length} workflow script(s); ${failed.length} failed` on `console.log`.
- `process.exit(failed.length > 0 ? 1 : 0)` stays ungated by the flag.
- `--quiet` repeated more than once behaves as a single `--quiet`.
- Test placement: all new tests go in the single flat colocated tier, `scripts/check-workflows.test.mjs`, using the existing `runChecker([...])` and `fixture()` helpers. No new test file, no new helper.
- Verification commands: full suite `node --test workflows/*.test.mjs scripts/*.test.mjs` (baseline 155 passing, 0 failing); lint `node scripts/check-workflows.mjs`; typecheck: none.

## File Structure

- `scripts/check-workflows.mjs` — modify lines 105–109 inside the `invokedDirectly` block: parse `--quiet` out of the args, gate the summary `console.log`. Nothing above line 100 changes.
- `scripts/check-workflows.test.mjs` — append four tests after the existing `'a broken file does not stop later files from being checked'` test (ends line 88) and before the `// ── smokeInit ──` divider at line 90, so the CLI-level tests stay grouped together. Reuses `runChecker`, `fixture`, `VALID_WORKFLOW` (line 16) and `BROKEN_WORKFLOW` (line 66).

---

### Task 1: `--quiet` is parsed out of the targets and suppresses the clean-run summary

**Files:**
- Modify: `scripts/check-workflows.mjs:103-111` (the `invokedDirectly` block)
- Test: `scripts/check-workflows.test.mjs` (insert after line 88, before the `// ── smokeInit ──` divider on line 90)

**Interfaces:**
- Consumes: existing module-level helpers in the test file — `runChecker(args) => Promise<{ code, stdout, stderr }>` (line 30), `fixture(name, source) => Promise<string>` (line 39), the `VALID_WORKFLOW` source string (line 16); and in the script — `listWorkflowScripts(dir)` and `checkWorkflows(targets)`.
- Produces: a local `const quiet` boolean inside the `invokedDirectly` block, consumed by Task 2. No new exports.

- [ ] **Step 1: Write the failing tests**

Insert these three tests into `scripts/check-workflows.test.mjs` immediately after the closing `})` of the `'a broken file does not stop later files from being checked'` test (line 88) and before the `// ── smokeInit ──` comment block:

```js
const SUMMARY_RE = /checked \d+ workflow script\(s\)/

test('--quiet alone suppresses the summary and still checks workflows/', async () => {
  const result = await runChecker(['--quiet'])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, SUMMARY_RE)
})

test('--quiet before an explicit passing target suppresses the summary', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker(['--quiet', file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, SUMMARY_RE)
})

test('--quiet after an explicit passing target suppresses the summary', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker([file, '--quiet'])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, SUMMARY_RE)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/check-workflows.test.mjs`
Expected: the three new tests FAIL. `--quiet` is currently treated as a target path, so `checkFile` gets `ENOENT`, the process exits 1, and the `assert.equal(result.code, 0)` assertion fails first (with the `FAIL --quiet: ENOENT ...` line in `stderr`). The 11 pre-existing tests in this file still pass.

- [ ] **Step 3: Write the minimal implementation**

In `scripts/check-workflows.mjs`, replace lines 105–109:

```js
  const args = process.argv.slice(2)
  const targets = args.length ? args : await listWorkflowScripts(path.join(repoRoot, 'workflows'))
  const results = await checkWorkflows(targets)
  const failed = results.filter((r) => !r.ok)
  console.log(`checked ${results.length} workflow script(s); ${failed.length} failed`)
```

with:

```js
  const args = process.argv.slice(2)
  const quiet = args.includes('--quiet')
  const named = args.filter((arg) => arg !== '--quiet')
  const targets = named.length ? named : await listWorkflowScripts(path.join(repoRoot, 'workflows'))
  const results = await checkWorkflows(targets)
  const failed = results.filter((r) => !r.ok)
  if (!quiet) console.log(`checked ${results.length} workflow script(s); ${failed.length} failed`)
```

Leave line 110 (`process.exit(failed.length > 0 ? 1 : 0)`) exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/check-workflows.test.mjs`
Expected: PASS — all 14 tests, including the untouched regression anchor `'real workflows/*.js scripts pass with no arguments'` which still asserts `/checked 2 workflow script\(s\); 0 failed/` for the non-quiet path.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-workflows.mjs scripts/check-workflows.test.mjs
git commit -m "feat: add --quiet flag to check-workflows"
```

---

### Task 2: A failing run stays loud under `--quiet`

**Files:**
- Modify: `scripts/check-workflows.mjs:111` (the summary `console.log` line as rewritten in Task 1)
- Test: `scripts/check-workflows.test.mjs` (append after the three tests added in Task 1, still before the `// ── smokeInit ──` divider)

**Interfaces:**
- Consumes: `const quiet` from Task 1's `invokedDirectly` block; the test helpers `runChecker(args)` and `fixture(name, source)`; the `BROKEN_WORKFLOW` source string defined at line 66 of the test file.
- Produces: nothing new — final state of the CLI block.

- [ ] **Step 1: Write the failing test**

Append to `scripts/check-workflows.test.mjs`, directly after the `'--quiet after an explicit passing target suppresses the summary'` test:

```js
test('--quiet still reports failures, the summary, and exit 1', async () => {
  const file = await fixture('broken.js', BROKEN_WORKFLOW)
  const result = await runChecker(['--quiet', file])
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}`)
  const output = result.stdout + result.stderr
  assert.ok(output.includes(file), `expected output to name ${file}\n${output}`)
  assert.match(output, /Unexpected token/)
  assert.match(result.stdout, /checked 1 workflow script\(s\); 1 failed/)
})
```

Note: `BROKEN_WORKFLOW` is declared with `const` at line 66, above this insertion point, so it is in scope.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/check-workflows.test.mjs`
Expected: FAIL on the last assertion — after Task 1, `--quiet` suppresses the summary unconditionally, so `result.stdout` is empty and `assert.match(result.stdout, /checked 1 workflow script\(s\); 1 failed/)` throws. The exit-code, filename, and `Unexpected token` assertions before it already pass (the `FAIL <file>: <error>` line is on stderr and was never gated).

- [ ] **Step 3: Write the minimal implementation**

In `scripts/check-workflows.mjs`, change the gated summary line from:

```js
  if (!quiet) console.log(`checked ${results.length} workflow script(s); ${failed.length} failed`)
```

to:

```js
  // --quiet hides only the success summary; a failing run stays fully diagnosable.
  if (!quiet || failed.length > 0) console.log(`checked ${results.length} workflow script(s); ${failed.length} failed`)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/check-workflows.test.mjs`
Expected: PASS — all 15 tests in the file, including Task 1's three suppression tests (all clean runs, so `failed.length === 0` and the summary is still suppressed).

- [ ] **Step 5: Run the full verification suite**

Run: `node --test workflows/*.test.mjs scripts/*.test.mjs`
Expected: 159 passing, 0 failing (155 baseline + 4 new).

Run: `node scripts/check-workflows.mjs`
Expected: exit 0, prints `checked 2 workflow script(s); 0 failed`.

Run: `node scripts/check-workflows.mjs --quiet`
Expected: exit 0, prints nothing.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-workflows.mjs scripts/check-workflows.test.mjs
git commit -m "fix: keep the check-workflows summary on a failing --quiet run"
```
