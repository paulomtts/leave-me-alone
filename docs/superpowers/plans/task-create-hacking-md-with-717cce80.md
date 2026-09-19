<!-- task-pipeline: validated -->
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

---

# Create HACKING.md with the dev-loop pointer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-level `HACKING.md` whose entire body is one sentence pointing a contributor at `npm test` as the repo's dev loop, with no other file changed.

**Architecture:** A docs-only diff of exactly one added file. The sentence names `npm test` verbatim, matching `package.json:7`'s `scripts.test` and `README.md:21-26`'s "Run it as `npm test`" framing, and deliberately stops short of the project-layout sentence that sibling subtask `9685233e` will append on a branch stacked on this one. Because the deliverable is static Markdown with no code path, the repo's two test tiers (`*.test.mjs` unit, `*.integration.test.mjs` integration) gain nothing here; the RED step is an executable shell assertion run against the working tree rather than a committed test file, and the committed verification is the existing suite passing unchanged.

**Tech Stack:** Markdown; git; Node's built-in test runner via `npm test` (`node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/ plugins/leave-me-alone/hooks/ plugins/leave-me-alone/skills/`).

**Spec:** `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/e2e-blocker-sweep/.claude/worktrees/e2esweep/task-create-hacking-md-with-717cce80/docs/superpowers/specs/task-create-hacking-md-with-717cce80-design.md` — the same design is prepended verbatim above this plan, so the two travel together.

## Global Constraints

- Work only in the worktree `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/e2e-blocker-sweep/.claude/worktrees/e2esweep/task-create-hacking-md-with-717cce80`, on branch `e2esweep/task-create-hacking-md-with-717cce80`, cut fresh from `origin/e2e-sweep-base`. Do not assume any other subtask's changes are present on this branch.
- Exactly one file may appear in the branch diff: `HACKING.md` at the repo root, added. Zero modified files. Do not touch `package.json`, `README.md`, `.gitignore`, or anything under `plugins/`, `docs/` (other than this plan/spec pair, which the workflow has already placed as untracked files under `docs/superpowers/`), or any test file.
- The dev-loop command named in the prose is `npm test` verbatim — not `node --test …`, not `bun test`.
- `HACKING.md`'s body is exactly one sentence. A single `#` heading line above it is allowed. Nothing about project layout (scripts/workflows/skills locations) — that is sibling subtask `9685233e-9140-4c7d-99dd-f6602ec1b6a5`'s entire deliverable.
- No hard-wrapped prose in the authored Markdown.
- Full-suite verification command: `npm test`. No typecheck configured. No lint configured.

---

### Task 1: Root `HACKING.md` with the dev-loop sentence

**Files:**
- Create: `HACKING.md` (repo root of the worktree, i.e. `/home/paulomtts/Code/leave-me-alone/.claude/worktrees/e2e-blocker-sweep/.claude/worktrees/e2esweep/task-create-hacking-md-with-717cce80/HACKING.md`)
- Modify: *(none — zero modified files is part of the deliverable)*
- Test: *(none — per the spec's Test plan, this card adds no file in either tier; the repo's two tiers are `*.test.mjs` unit and `*.integration.test.mjs` integration, and a static Markdown file has no code path either tier could assert. The RED step below is an executable acceptance assertion run in the shell against the working tree, and is never committed.)*

**Interfaces:**
- Consumes: `package.json:7` `scripts.test` — the string `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/ plugins/leave-me-alone/hooks/ plugins/leave-me-alone/skills/`, surfaced to contributors as `npm test`. Nothing else from any earlier task; this is the first subtask on the branch.
- Produces: a root-level file `HACKING.md` whose first line is the heading `# Hacking on this repo` and whose third line is the single body sentence. Sibling subtask `9685233e` appends its project-layout sentence to this file and bases its PR on branch `e2esweep/task-create-hacking-md-with-717cce80`.

- [ ] **Step 1: Write the failing acceptance assertion**

Save this as a scratch script **outside the repo** so it never enters the diff — set `SCRATCH` to this session's scratchpad directory (`export SCRATCH=/tmp/claude-1000/-home-paulomtts-Code-leave-me-alone/<session-id>/scratchpad`) and write it to `$SCRATCH/check-hacking.sh`. It encodes the spec's four review-time error paths as one runnable check.

```bash
#!/usr/bin/env bash
# Acceptance check for subtask 717cce80. Run from the worktree root.
set -uo pipefail
fail=0

# 1. The file exists at the repo root.
if [ ! -f HACKING.md ]; then
  echo "FAIL: HACKING.md does not exist at the repo root"
  fail=1
else
  # 2. It names `npm test` verbatim.
  grep -qF '`npm test`' HACKING.md || { echo "FAIL: HACKING.md does not name \`npm test\`"; fail=1; }

  # 3. It does NOT name a raw runner instead.
  grep -qE 'bun test|node --test' HACKING.md && { echo "FAIL: HACKING.md names a raw runner instead of npm test"; fail=1; }

  # 4. Body is exactly one sentence: exactly one period-terminated sentence in non-heading, non-blank lines.
  body_sentences=$(grep -v '^#' HACKING.md | grep -v '^[[:space:]]*$' | grep -o '\.' | wc -l)
  [ "$body_sentences" -eq 1 ] || { echo "FAIL: body has $body_sentences sentences, expected exactly 1"; fail=1; }

  # 5. No project-layout drift into sibling 9685233e's scope.
  grep -qiE 'workflows/|skills/|scripts/|project layout' HACKING.md && { echo "FAIL: project-layout content belongs to subtask 9685233e"; fail=1; }
fi

# 6. Exactly one added file, zero modified files, versus the milestone base.
# `git diff` never lists untracked files (HACKING.md is untracked until `git add`),
# so this unions the tracked-diff view with the untracked-file view.
changed=$( { git diff --name-only origin/e2e-sweep-base -- . ':(exclude)docs/superpowers'; git ls-files --others --exclude-standard -- . ':(exclude)docs/superpowers'; } | sort -u)
[ "$changed" = "HACKING.md" ] || { echo "FAIL: diff touches unexpected files: [$changed]"; fail=1; }

[ "$fail" -eq 0 ] && echo "PASS: acceptance check green"
exit "$fail"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash "$SCRATCH/check-hacking.sh"` from the worktree root (`$SCRATCH` = the session scratchpad directory).
Expected: FAIL — first line `FAIL: HACKING.md does not exist at the repo root`, followed by `FAIL: diff touches unexpected files: []`, exit status 1.

- [ ] **Step 3: Write the minimal implementation**

Create `HACKING.md` at the worktree root with exactly this content:

```markdown
# Hacking on this repo

The dev loop is `npm test`, which runs the repo's whole suite under Node's built-in test runner.
```

That is the entire file: one heading, one blank line, one sentence, trailing newline. Do not add a project-layout sentence, do not restate `README.md:21-26`'s Node-vs-bun prose, and do not create or modify any other file.

- [ ] **Step 4: Run the acceptance assertion to verify it passes**

Run: `bash "$SCRATCH/check-hacking.sh"` from the worktree root.
Expected: PASS — single line `PASS: acceptance check green`, exit status 0.

- [ ] **Step 5: Run the full existing suite, unchanged**

Run: `npm test`
Expected: PASS — the same tests with the same result as on `origin/e2e-sweep-base`; no new test files appear in the run's output, because this card added none.

- [ ] **Step 6: Confirm the diff is one added file and zero modified files**

`git diff --stat` (like `git diff`) never shows untracked files, so stage `HACKING.md` first and diff the staged tree:

Run: `git add HACKING.md`, then `git status --short` and `git diff --cached --stat origin/e2e-sweep-base -- . ':(exclude)docs/superpowers'`
Expected: `git status --short` shows `A  HACKING.md` (plus the workflow's own untracked `docs/superpowers/` spec and plan files, shown as `??`, which are excluded from the card's diff budget) and no `M ` lines for `package.json`, `README.md`, `.gitignore`, or anything under `plugins/`. The `git diff --cached --stat` line reads `HACKING.md | 3 +++` with `1 file changed, 3 insertions(+)`.

- [ ] **Step 7: Commit**

`HACKING.md` is already staged from Step 6.

```bash
git commit -m "docs: add HACKING.md pointing at the npm test dev loop"
```

---

## Verification

| Check | Command | Expectation |
| --- | --- | --- |
| Full suite | `npm test` | passes exactly as on `origin/e2e-sweep-base` |
| Typecheck | *(none configured)* | n/a |
| Lint | *(none configured)* | n/a |
| Manual acceptance | read `HACKING.md`; `git add HACKING.md && git diff --cached --stat origin/e2e-sweep-base -- . ':(exclude)docs/superpowers'` (staging first, since `git diff` never shows untracked files) | root-level file, one sentence, names `npm test`, one added file and zero modified files |

Verification source: `package.json` at `origin/e2e-sweep-base`.

## Done when

`HACKING.md` exists at the repo root with a single dev-loop sentence pointing at `npm test`; the branch diff touches no other file; `npm test` passes unchanged; and sibling subtask `9685233e` is left a one-sentence file and the branch `e2esweep/task-create-hacking-md-with-717cce80` to stack its PR on.
