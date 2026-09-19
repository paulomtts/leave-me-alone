# Create HACKING.md with the dev-loop pointer — design

Subtask `717cce80-2331-4413-9ed0-93a3a8014f60`, under story `5573a501-a59c-4408-adf0-46dc1083e88f` ("Add a HACKING.md with a one-line dev-loop pointer"), under milestone `6278914f-5552-4539-9106-4ebe28d499e0` ("E2E sweep: trivial docs milestone").

## Scope

Create a new file `HACKING.md` at the repository root. It does not exist today. Its entire content is one sentence telling a contributor that the dev loop is `npm test` — the command `package.json` already carries (`node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/ plugins/leave-me-alone/hooks/ plugins/leave-me-alone/skills/`). A Markdown `#` heading on the file is acceptable framing; the body is that one sentence and nothing else.

This is a docs-only diff. No other file in the repo changes: not `package.json`, not `README.md`, not `.gitignore`, not anything under `plugins/`, `scripts/`, `workflows/`, `hooks/`, or `skills/`. The milestone's design was already argued out at breakdown time; this card narrows it to "the file exists and says the one thing."

### Explicitly out of scope

- The project-layout sentence (where the plugin's scripts, workflows, and skills live). That belongs entirely to sibling subtask `9685233e-9140-4c7d-99dd-f6602ec1b6a5` ("Add a project-layout sentence to HACKING.md"), which is `blocked` on this card and whose PR targets this card's branch rather than the milestone base. This card must leave `HACKING.md` holding exactly the one dev-loop sentence and stop, so the sibling has a clean single-sentence file to append to and a clean parent branch to stack on.
- Reproducing `README.md`'s existing prose about the suite. README already covers the Node-vs-bun constraint, the Requirements table, and why `package.json` exists at all (`README.md:21-26`). `HACKING.md` is a terse pointer into that, not a second copy of it.
- Any change to the test suite, any new test file, any CI or hook wiring.

## Observable behavior

After this change:

- `HACKING.md` is present at the repo root and is tracked by git.
- Reading it yields a single sentence naming `npm test` as the way to run the repo's checks, consistent with the command recorded in `package.json`'s `scripts.test`.
- `git status` on the subtask branch shows exactly one added file and zero modified files.
- `npm test` behaves exactly as it did before the change — same tests, same result, no new output.

## Error paths

There is no runtime surface here, so the failure modes are review-time rather than execution-time:

- **Drift into the sibling's scope** — a second sentence about project layout lands in this card's diff. Detected by reading the finished file: more than one sentence of body means the card overshot and must be trimmed before the PR opens, or subtask `9685233e` has nothing left to do and its stacked PR becomes empty.
- **Command text disagrees with the manifest** — the sentence names a command that is not `npm test` (e.g. a raw `node --test …` invocation or `bun test`). This contradicts `package.json` and `README.md`'s explicit "it must be `node --test`, not `bun test`" guidance; the fix is to name `npm test` verbatim.
- **Collateral edits** — any file other than `HACKING.md` appears in the diff. The card's description forbids this; such a hunk is reverted rather than justified.
- **Wrong location** — the file lands somewhere other than the repo root (e.g. under `docs/` or inside `plugins/leave-me-alone/`). The story asks for a root-level `HACKING.md`.

## Test plan

Test-placement rule for this repo (from the exploration findings, grounded in `docs/superpowers/specs/2026-09-17-brd-migration-design.md:352-386` and the observed file naming under `plugins/leave-me-alone/scripts/` and `plugins/leave-me-alone/hooks/`): there are exactly two tiers. Unit tests — suffix `.test.mjs`, e.g. `detect.test.mjs`, `brd.test.mjs` — own pure logic and injectable/mocked-runner behavior. Integration tests — suffix `.integration.test.mjs`, e.g. `census.integration.test.mjs`, `rollup.integration.test.mjs` — own real-dependency wiring such as the real `brd` CLI or the real filesystem. There is no e2e or conformance tier to default into.

Applied here: **this subtask adds no test of its own, in either tier.** The deliverable is a static one-sentence Markdown file with no code path, no branching, and no dependency to wire up — there is nothing a unit test could assert beyond the file's literal bytes, and nothing an integration test could exercise. Adding a test would also violate the card's "no other files change" constraint. The parent story states the intent directly: "a real change, verified by the existing suite; nothing else should need to change."

Verification is therefore the existing suite, unchanged:

| Check | Command | Tier | Expectation |
| --- | --- | --- | --- |
| Full suite | `npm test` | existing unit + integration tests, unmodified | passes exactly as on the base branch |
| Typecheck | *(none configured)* | — | n/a |
| Lint | *(none configured)* | — | n/a |

Verification source: `package.json` at `origin/e2e-sweep-base`.

Manual acceptance, done at review rather than encoded as a test: confirm `HACKING.md` exists at the repo root, holds one sentence, names `npm test`, and that the branch diff contains no other file.

## Done when

`HACKING.md` exists at the repo root with a single dev-loop sentence pointing at `npm test`; the branch diff touches no other file; `npm test` passes unchanged; and sibling subtask `9685233e` is left a one-sentence file and a branch to stack its PR on.
