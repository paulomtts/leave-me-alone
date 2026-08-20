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
