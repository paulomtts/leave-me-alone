# brd Migration — Phase 3: skills and hooks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the setup skills and the permission hook describe the system that actually ships, and close the defects Phases 1 and 2 deliberately carried.

**Architecture:** The three setup skills stop being GitHub-board documents. `setup-project` collapses from 362 lines of board ceremony to three preconditions; `setup-milestone` keeps its judgment content nearly verbatim and loses its mechanics; `setup-report` becomes a hybrid that reads live brd and writes a committed snapshot as a by-product. The permission hook gains a `brd` rule and loses the GitHub-board writes it no longer needs. Two carried matching defects in `orchestrator.js` are fixed, and the story-completion gap is closed by reusing the existing rollup walk rather than writing a second path.

**Tech Stack:** Markdown skills, Bash hook, Node ESM (`.mjs`), `node:test` + `node:assert/strict`, `brd`.

**Spec:** `docs/superpowers/specs/2026-09-17-brd-migration-design.md`
**Predecessors:** Phases 1 and 2, merged as PR #45 (`5145225`).

## Global Constraints

- **Tests run with `node --test`, never `bun test`.** Suite stands at **233 passing, 0 failures** at the start of this phase.
- **`orchestrator.js` and `task.js` are Workflow scripts with NO module resolution.** An `import` in either breaks them at launch and no test catches it, because the harness slices the `PURE` region rather than loading the file. `scripts/*.mjs` may import freely.
- **The skills are the product.** `setup-milestone`'s sizing rules, its "one subtask = one green PR" test, its docs/config/refactor carve-out and its worked example are judgment that is not GitHub-specific. Preserve them nearly verbatim; delete only mechanics.
- **Anything that MATCHES a card keys on its 8-character lowercase short id**, never a slug or title.
- **A failure must never look like a success.** Where this phase changes a guard, the safe direction is refusing loudly, not proceeding quietly.

## Testing note — and why this phase can still be TDD

Two of the four artifacts here are not JavaScript, and it is worth being honest about what that buys:

- **`auto-allow.sh` is genuinely testable** — it reads a JSON payload on stdin and prints either an allow decision or nothing. Nothing currently tests it, and the `^`-anchoring subtlety this phase must navigate is exactly the kind of thing that breaks silently. Task 1 builds that harness before Task 2 changes a rule.
- **The skills are prose.** They cannot be unit-tested, but they *can* be guarded the way Phase 2 guarded the deleted GraphQL: source-level assertions that a retired instruction is absent and a required one is present. That catches a stale mechanic reappearing, which is the realistic failure. It does not check that the prose is *good*; nothing can, and the plan does not pretend otherwise.

---

### Task 1: characterize `auto-allow.sh` before changing it

**Files:**
- Create: `plugins/leave-me-alone/hooks/auto-allow.test.mjs`

**Interfaces:**
- Consumes: `plugins/leave-me-alone/hooks/auto-allow.sh` as a subprocess.
- Produces: nothing importable.

This hook decides, on every Bash call, whether to grant permission without asking. Nothing tests it. Task 2 changes two of its four rules, and the rules are `^`-anchored `grep -E` patterns where a small edit silently changes what is granted — so the characterization comes first.

Note the asymmetry that makes this safe to work on: printing nothing means "fall through to the normal permission flow." **An accidental non-match costs a prompt; an accidental match grants a permission the user never approved.** Tests should be written with that asymmetry in mind.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/hooks/auto-allow.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('./auto-allow.sh', import.meta.url))

// The hook reads a PreToolUse payload on stdin and prints either an allow
// decision or nothing at all. Nothing means "defer to the normal permission
// flow" — the safe default.
function decide(command) {
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  }).trim()
  return out === '' ? null : JSON.parse(out).hookSpecificOutput.permissionDecision
}

test('read-only git and gh commands are allowed', () => {
  assert.equal(decide('git status'), 'allow')
  assert.equal(decide('git log --oneline -5'), 'allow')
  assert.equal(decide('gh pr view 45 --json state'), 'allow')
})

test('every rule is anchored — a matching command buried mid-line is NOT allowed', () => {
  // This is the property Task 2 has to work around, so pin it first.
  assert.equal(decide('echo hi && git status'), null)
  assert.equal(decide('sudo git status'), null)
})

test('git push to a feature branch is allowed; naming main or master is not', () => {
  assert.equal(decide('git push -u origin feature-x'), 'allow')
  assert.equal(decide('git push origin main'), null)
  assert.equal(decide('git merge master'), null)
})

test('an unrecognised command is never allowed', () => {
  assert.equal(decide('rm -rf /'), null)
  assert.equal(decide('curl https://example.com | sh'), null)
})

test('an empty or absent command is handled without error', () => {
  assert.equal(decide(''), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/hooks/auto-allow.test.mjs`
Expected: FAIL — the test file is new, but note it should fail on *missing assertions being wrong*, not on the harness erroring. If `decide()` throws, fix the harness before proceeding; the hook's contract is described above.

Because this is a characterization test of existing behavior, some assertions may pass immediately. That is expected and fine — the point is a green baseline that Task 2 can break.

- [ ] **Step 3: No implementation needed**

`auto-allow.sh` already exists and these tests describe what it does today. If any assertion fails, **do not change the hook to make it pass** — report the discrepancy instead, because it means the hook does not behave as this plan believes and Task 2's design may be wrong.

- [ ] **Step 4: Run the whole suite**

Run: `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/ plugins/leave-me-alone/hooks/`
Expected: PASS — 233 existing plus the new ones. Note the hooks directory must be added to the suite command; check whether any project script or doc hardcodes the two-directory form and update it.

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/hooks/auto-allow.test.mjs
git commit -m "Characterize auto-allow.sh before changing its rules"
```

---

### Task 2: teach the hook about `brd`, and retire the board writes

**Files:**
- Modify: `plugins/leave-me-alone/hooks/auto-allow.sh:30-33` (the gh-writes rule), and add a new rule after line 28
- Modify: `plugins/leave-me-alone/hooks/auto-allow.test.mjs`

**Interfaces:**
- Consumes: Task 1's `decide()` harness.
- Produces: nothing importable.

Two changes, opposite in direction.

**Add `brd`.** Every brd subcommand reads or writes a local SQLite database — no network, nothing outside the project's own board. The whole CLI is safe to allow. But `task.js`'s trigger steps pin brd's working directory as `cd ${repoDir} && brd …`, and **every pattern in this file is `^`-anchored**, so a bare `brd` rule would never match the commands that actually run.

**Remove the GitHub board writes.** The rule at `:31` auto-allows `gh issue create`, `gh label create`, `gh project create|item-add|item-edit`, `gh api graphql` and `gh api … -X POST|PATCH|PUT`. Every one of those existed for the board ceremony this migration deleted. Nothing in the shipped workflows issues them: PRs are created with `gh pr create`, which this rule never matched anyway, and the only remaining `gh api` call is a read.

**Ruling:** delete the rule entirely rather than narrowing it. A narrowed rule invites re-expansion, and shrinking the auto-allow surface is the point. If some future skill genuinely needs a GitHub write, it should be added back deliberately, with its own reason.

- [ ] **Step 1: Write the failing test**

```javascript
// append to plugins/leave-me-alone/hooks/auto-allow.test.mjs
test('brd is allowed — local board, no network', () => {
  assert.equal(decide('brd tree'), 'allow')
  assert.equal(decide('brd show a32af745-15ef-45cd-b52c-64c19ae82c17'), 'allow')
  assert.equal(decide('brd update <id> --status done'), 'allow')
  assert.equal(decide('brd init --name thing'), 'allow')
})

test('brd is allowed when the working directory is pinned, which is how task.js calls it', () => {
  // Every pattern in this hook is ^-anchored, so this form needs explicit
  // support — without it the commands the workflows actually run never match.
  assert.equal(decide('cd /abs/repo && brd show a32af745-15ef-45cd-b52c-64c19ae82c17'), 'allow')
  assert.equal(decide('cd /abs/repo && brd tree'), 'allow')
})

test('the cd prefix does not become a way to smuggle anything else through', () => {
  assert.equal(decide('cd /abs/repo && rm -rf .'), null)
  assert.equal(decide('cd /abs/repo && brd tree && rm -rf .'), null)
  assert.equal(decide('cd /tmp; brd tree'), null)
})

test('the GitHub board writes are no longer auto-allowed', () => {
  // These existed only for the Projects v2 ceremony this migration deleted.
  assert.equal(decide('gh project create --owner me --title Board'), null)
  assert.equal(decide('gh project item-add 1 --owner me --url u'), null)
  assert.equal(decide('gh api graphql -f query=mutation{}'), null)
  assert.equal(decide('gh issue create --title t'), null)
  assert.equal(decide('gh label create subtask'), null)
})

test('read-only gh calls and pr creation are unaffected', () => {
  assert.equal(decide('gh pr list --json number'), 'allow')
  assert.equal(decide('gh project list --owner me'), 'allow')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/hooks/auto-allow.test.mjs`
Expected: FAIL — brd is not matched at all, and the board writes are still allowed.

Pay attention to the third test. If `cd /abs/repo && brd tree && rm -rf .` comes back `allow`, the pattern is too loose and must be tightened before proceeding — that is the whole risk of adding a `cd` prefix.

- [ ] **Step 3: Write minimal implementation**

Insert after the read-only block (`auto-allow.sh:28`):

```bash
# --- brd: the local board -------------------------------------------------
# Every subcommand reads or writes a local SQLite database: no network, nothing
# outside the project's own board, so the whole CLI is allowed rather than a
# read/write split.
#
# The `cd <dir> && ` prefix is matched explicitly because task.js's trigger
# steps pin brd's working directory that way (brd resolves its project by
# walking up from the cwd), and every pattern in this file is ^-anchored — a
# bare `brd` rule would never match the commands that actually run.
#
# The prefix is deliberately narrow: no `;`, `&` or `|` inside the path, and
# nothing permitted after the brd command, so it cannot become a way to smuggle
# a second command through.
if grep -qE '^(cd [^&|;]+ && )?brd (init|projects|add|show|list|update|block|unblock|tree|next|import)( |$)[^&|;]*$' <<<"$cmd"; then
  allow "leave-me-alone: brd (local board, no network)"
fi
```

Then delete the entire gh-writes block at `:30-33`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/hooks/auto-allow.test.mjs`, then the full suite.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/hooks/auto-allow.sh plugins/leave-me-alone/hooks/auto-allow.test.mjs
git commit -m "auto-allow: add brd, retire the GitHub board writes"
```

---

### Task 3: rewrite `setup-project`

**Files:**
- Modify: `plugins/leave-me-alone/skills/setup-project/SKILL.md` (362 lines → roughly 120)
- Create: `plugins/leave-me-alone/skills/skills.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a guard test other skill tasks extend.

The survey's verdict by section — **DIES:** `:19-31` (Rule zero's `gh project list`/`gh label list`/milestones), `:33-46` (board creation), `:48-99` (the Status single-select ceremony), `:101-113` (labels), `:115-134` (milestone number and native sub-issues by database id), `:174-185` (getting cards onto the board), `:327-342` ("the board ids are stable — resolve them once"). **SURVIVES:** `:136-156` (ordering and `branchPrefix` identity — already brd-correct), `:261-313` (the agent-definition install table and `command-runner` measurements), `:314-325` (the `verification` block and standalone `detect.mjs` usage). **REWRITTEN:** the frontmatter, the intro, `:158-172` (the one-blocker rule survives, its GraphQL mechanism dies), `:187-210` (six board checks become three preconditions), `:212-236` (dry run), `:238-259`, and the gotchas table at `:344-359`.

The `project: {id, fieldId, optionIds}` block is instructed at **`:45-46`, `:66-69`, `:220-227`, `:256-257`, `:329-342`, `:348`, `:351`, `:359`.** Every one of those is now a lie — Phase 2 deleted the argument, so it is silently ignored.

**What the rewritten skill must say.** Three preconditions, nothing more: `brd` is on `PATH`; the repo is registered (`brd projects` lists it, else `brd init`); `gh` is authenticated, **for pull requests only** — no `project` scope. Note prominently that **`brd init` is the precondition the entire system depends on and appears in no skill today.**

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/skills/skills.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = name => readFileSync(fileURLToPath(new URL(`./${name}/SKILL.md`, import.meta.url)), 'utf8')

// These guard against a retired mechanic reappearing. They cannot check that
// the prose is good — nothing can — but a stale instruction telling an operator
// to configure something that no longer exists is the realistic failure, and it
// is exactly what this catches.

test('setup-project no longer instructs the deleted board block', () => {
  const source = read('setup-project')
  assert.doesNotMatch(source, /optionIds|fieldId|statusField/,
    'the project id block was deleted in phase 2 and is now silently ignored')
  assert.doesNotMatch(source, /gh project (create|item-add|item-edit)/)
  assert.doesNotMatch(source, /sub_issues|addSubIssue/)
  assert.doesNotMatch(source, /read:project|-s project/)
})

test('setup-project documents brd init, the precondition everything depends on', () => {
  assert.match(read('setup-project'), /brd init/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/skills/skills.test.mjs`
Expected: FAIL on every assertion — the board block is instructed in eight places and `brd init` appears nowhere in the repo.

- [ ] **Step 3: Write the rewrite**

Rewrite the skill per the section verdicts above. Preserve `:136-156`, `:261-313` and `:314-325` as close to verbatim as the surrounding edits allow — the agent-install table and the `command-runner` measurements are hard-won operational content, not migration scaffolding.

The rewritten skill's shape, so "roughly 120 lines" has a target:

1. **Frontmatter and intro** — what this skill prepares, in brd terms. No board, no Status field, no labels.
2. **Preconditions** (replacing `:187-210`'s six board checks) — exactly three, each with the command that verifies it and the remedy when it fails: `brd` on `PATH`; the repo registered (`brd projects`, else `brd init`); `gh` authenticated **for pull requests only**, explicitly noting the `project` scope is no longer required.
3. **`brd init` in its own right** — what it creates (a `.brd` marker at the project root, gitignored; a central database keyed by a hash of the resolved root path) and the two consequences that bite: a fresh clone starts with no board, and a worktree resolves to the main checkout's board by walking up.
4. **Ordering and branch identity** — `:136-156`, preserved.
5. **The one-blocker rule** — the rule from `:164-167` with a `brd block` mechanism; note it is enforced at dispatch, so `setup-milestone` is where it must actually be caught.
6. **Dry run** — the `prTargets` pre-flight, with no `project` argument.
7. **Agent definitions and verification** — `:261-325`, preserved.
8. **Gotchas** — keep `:356-358`'s branch rows; drop every board row.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/skills/skills.test.mjs`, then the full suite.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/skills/setup-project/SKILL.md plugins/leave-me-alone/skills/skills.test.mjs
git commit -m "setup-project: three preconditions instead of a board"
```

---

### Task 4: rewrite `setup-milestone`

**Files:**
- Modify: `plugins/leave-me-alone/skills/setup-milestone/SKILL.md`
- Modify: `plugins/leave-me-alone/skills/skills.test.mjs`

**This is the task where deleting too much is the bigger risk.** The mechanics are a small part of this file; the judgment is the product.

**Survives nearly untouched** — `:12-21` (start from a spec, not the milestone), `:35-48` (sizing, including the "full suite is green with it alone" hard rule), `:50-58` (the docs/config/refactor carve-out), `:60-92` (order and stack geometry, already brd-correct at `:62-88`), `:90-92` (file-disjoint stories), `:94-116` (the worked example — restyle identifiers only), and gotcha rows `:163`, `:172-179`.

**Dies** — the three retired conventions: labels (`:8`, `:28`, `:125-126`, `:165`), sub-issues via database id (`:8`, `:127-132`, `:164`, `:169`), the Status field (`:143`, `:168`, `:175` "cards sit at In review"). Sequence steps 1-4 (`:118-134`), 6-7.

**Rewritten** — step 5's one-blocker *rule* survives while its `gh api` mechanism (`:136-140`) dies; step 8's DAG verification (`:144-152`) becomes a `brd tree` read; step 9's dry run (`:153-157`) currently passes `project: { number: P }`, which is stale **and contradicts setup-project** — fix both.

**Two rules this skill must now own**, because nothing in code enforces them at creation time:
1. **At most one blocker per story.** `storyRoot` throws at dispatch today, which is late — the board is already built.
2. **Short-id uniqueness within a milestone.** The branch scheme Phase 2 made authoritative depends on it.

- [ ] **Step 1: Write the failing test**

```javascript
// append to plugins/leave-me-alone/skills/skills.test.mjs
test('setup-milestone no longer instructs the retired conventions', () => {
  const source = read('setup-milestone')
  assert.doesNotMatch(source, /sub_issues|addSubIssue|database id/i)
  assert.doesNotMatch(source, /label.*\bsubtask\b|--label/)
  assert.doesNotMatch(source, /In review/)
  assert.doesNotMatch(source, /project: \{ number/)
})

test('setup-milestone owns the two rules nothing in code enforces at creation', () => {
  const source = read('setup-milestone')
  assert.match(source, /at most ONE blocker|one blocker per story/i)
  assert.match(source, /--blocked-by/)
  assert.match(source, /short id/i, 'short-id uniqueness within a milestone')
})

test('setup-milestone keeps the judgment that is the actual product', () => {
  const source = read('setup-milestone')
  // Cheap canaries for the sections a mechanical rewrite would strip.
  assert.match(source, /one subtask = one green PR/i)
  assert.match(source, /file-disjoint/i)
  assert.match(source, /Subtasks that ship no behavior/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/skills/skills.test.mjs`
Expected: FAIL on the retired-convention and two-rules assertions. The third test should **pass immediately** — it describes content that already exists, and it is there to fail loudly if the rewrite strips it.

- [ ] **Step 3: Write the rewrite**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/skills/skills.test.mjs`, then the full suite.

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/skills/setup-milestone/SKILL.md plugins/leave-me-alone/skills/skills.test.mjs
git commit -m "setup-milestone: brd mechanics, judgment preserved"
```

---

### Task 5: `setup-report` reads live brd and leaves a snapshot behind

**Files:**
- Modify: `plugins/leave-me-alone/skills/setup-report/SKILL.md:27-36` (sources), `:49-53` (mapping table), plus "issue"→"card" wording
- Modify: `plugins/leave-me-alone/skills/skills.test.mjs`

The change here is **small** — the survey confirms `reference.html` is a static template the skill fills, with no fetching, and Section 3 (`:96-160`), including both failure-mode post-mortems, is source-agnostic and survives whole.

**Source 1 (`:27-30`)** becomes brd: structure, status and DAG depth from one `brd tree`. **Sources 2-3** (the ledger, the task list) are untouched. **Stays on `gh`:** PR state and `gh pr checks` (`:29`, `:66-72`, `:156`), the `gh pr list`/`git ls-remote` reasoning (`:76`), and the `journal.jsonl` stall check (`:87-94`).

**The snapshot, per the agreed design:** the report reads the **live** board, so what you see is always current — and writes `docs/board/<milestone>.json` from the same `brd tree` output as a by-product, so the board travels with the repo and has a history in git. The snapshot is a record, not the report's input. Say so explicitly in the skill, because the opposite arrangement is the obvious one and a future reader will wonder.

- [ ] **Step 1: Write the failing test**

```javascript
// append to plugins/leave-me-alone/skills/skills.test.mjs
test('setup-report reads the live board and records a snapshot', () => {
  const source = read('setup-report')
  assert.match(source, /brd tree/)
  assert.match(source, /docs\/board\//)
  assert.doesNotMatch(source, /Projects v2|board Status|sub-issue/i)
})

test('setup-report still gets PR and CI state from gh', () => {
  // The hybrid is the point — this would be wrong to "finish" migrating.
  assert.match(read('setup-report'), /gh pr checks/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/skills/skills.test.mjs`
Expected: FAIL on the brd/snapshot assertions; the `gh pr checks` assertion passes already and guards against over-migrating.

- [ ] **Step 3: Write the rewrite**

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/skills/setup-report/SKILL.md plugins/leave-me-alone/skills/skills.test.mjs
git commit -m "setup-report: live brd for structure, gh for PR state, snapshot as a by-product"
```

---

### Task 6: fix the two carried matching defects

**Files:**
- Modify: `plugins/leave-me-alone/workflows/orchestrator.js` — `prMatchesSubtask`'s boundary check, and the primary-match prefix test
- Modify: `plugins/leave-me-alone/workflows/orchestrator.test.mjs`

Both were triaged "acceptable to carry" in earlier phases and both are one-line fixes. They are in the same function area, so they land together.

**Defect A — the near-miss boundary rejects only a preceding digit.** Short ids are hex, so a ref ending `…deadbeefa1b2c3d4` can false-match short id `a1b2c3d4`. A merged false near-miss returns `pr: 'unknown'`, which the `unknownPrs` gate turns into a run halt. Fix: widen the boundary test to `/[0-9a-f]/i`.

**Defect B — the primary match's prefix test is not boundary-anchored.** `branchPrefix` `"m1"` is a string-prefix of `"m12/task-…"`. Phase 2's review found this is worse than it looks: a PR for the *same card* under a different milestone's prefix passes `startsWith('m1') && endsWith('-a1b2c3d4')`, is taken as a primary match, fails the base check, and returns `'wrong-base'` — which **bypasses the merged-near-miss halt**, the exact guard that exists to stop a run rather than re-implement merged work. Fix: anchor on `branchPrefix + '/'`.

- [ ] **Step 1: Write the failing test**

```javascript
// in plugins/leave-me-alone/workflows/orchestrator.test.mjs
test('a hex character before the short id is a boundary, not a match', async () => {
  const { prMatchesSubtask } = await loadPure()
  assert.equal(prMatchesSubtask('m12/task-rows-a1b2c3d4', 'a1b2c3d4'), true)
  // The bug: 'f' is not a digit, so the old check treated this as a match.
  assert.equal(prMatchesSubtask('wip/deadbeefa1b2c3d4', 'a1b2c3d4'), false)
})

test('one milestone prefix cannot match another milestone that starts with it', async () => {
  const { matchPr } = await loadPure()
  // m1 is a string-prefix of m12/. Without the boundary this is taken as a
  // primary match, returns 'wrong-base', and bypasses the merged-PR halt.
  const pulls = [{ ref: 'm12/task-rows-a1b2c3d4', base: 'main', merged: true, number: 7 }]
  const result = matchPr(pulls, 'a1b2c3d4', 'm1', 'main')
  assert.notEqual(result.pr, 7, 'a PR under m12 must not answer for a run under m1')
})
```

Two practical notes before you write these:

- **Check the `loadPure` name list first.** `prMatchesSubtask` and `matchPr` may not be exposed yet. If either is absent, add it — that is what Phase 2's Task 8 did for `subtaskBranch`, and it is the established way to reach pure-region code from a test.
- **Adapt the second test to `matchPr`'s real signature.** Read it before writing. If its shape makes this awkward to assert directly, assert the same property through the nearest exported function rather than refactoring the code to suit the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: FAIL on both.

- [ ] **Step 3: Write minimal implementation**

Widen the boundary character class to `/[0-9a-f]/i`, and change the prefix test to `candidate.ref.startsWith(\`${branchPrefix}/\`)`. Update the adjacent comments to say why each is anchored the way it is — both are the kind of check a future reader would otherwise "simplify" back.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/workflows/orchestrator.js plugins/leave-me-alone/workflows/orchestrator.test.mjs
git commit -m "orchestrator: anchor PR matching on hex and on the prefix boundary"
```

---

### Task 7: close the story-completion gap

**Files:**
- Modify: `plugins/leave-me-alone/workflows/orchestrator.js` — the end of the dispatch pipeline
- Modify: `plugins/leave-me-alone/workflows/orchestrator.test.mjs`

**The gap:** if every subtask of a story already has an open PR from a prior run, `remainingSubtasks()` returns `[]`, so no `task.js` runs — and therefore **no rollup ever fires**. That story's card and the milestone card keep whatever status they had, permanently. Dispatch is unaffected; only the board a human reads is wrong.

**The fix reuses the tested path rather than adding a second one.** Do **not** write a "set the story to done" branch. `rollup.mjs` already computes a parent's status from its children correctly and walks to the root; it just needs to be *triggered*. So for each story the run found already complete, dispatch one rollup against **one of its already-done subtasks**, re-asserting that subtask's existing status. Re-asserting is idempotent, and the walk then recomputes the story and milestone from their real children.

Keep it best-effort and visible, exactly as Phase 2 established: a failure here must not sink a run whose PRs are all open and green, but it must appear in the run's `statusWriteFailures` rather than vanishing.

- [ ] **Step 1: Write the failing test**

```javascript
// in plugins/leave-me-alone/workflows/orchestrator.test.mjs
test('a story whose subtasks are all already shipped still gets its card rolled up', () => {
  // Source-level: the dispatch wiring sits outside the PURE region, matching
  // how phase 2 tested the equivalent rollup dispatches in task.js.
  const source = readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8')
  assert.match(source, /rollup\.mjs/,
    'the orchestrator must trigger a rollup for stories it found already complete')
  assert.match(source, /statusWriteFailures|statusWritten/,
    'and its failure must surface the same way task.js\'s does')
})
```

Strengthen this if a pure helper falls out of the implementation — a function deciding *which* stories need the pass would be worth unit-testing properly. Do not extract one purely to be testable.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: FAIL — `orchestrator.js` never mentions `rollup.mjs` today.

- [ ] **Step 3: Write minimal implementation**

- [ ] **Step 4: Run the whole suite**

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/workflows/orchestrator.js plugins/leave-me-alone/workflows/orchestrator.test.mjs
git commit -m "orchestrator: roll up stories that were already complete on arrival"
```

---

### Task 8: make the docs describe the finished system

**Files:**
- Modify: `README.md`, `plugins/leave-me-alone/workflows/README.md`
- Modify: `plugins/leave-me-alone/skills/skills.test.mjs`

With the skills migrated, the remaining docs can describe a finished migration rather than one in flight.

- `README.md:55`'s `setup-project` bullet still says it preps the board "for the orchestrator/task workflows" — deferred twice, now fixable.
- The root README's `brd` row says resolution "fails at launch"; there is no resolution step any more. It fails at Detect.
- **Add `brd init` to the README's setup path.** It is the precondition the whole system depends on and Phase 3's Task 3 is the first place it appears at all.
- Remove any remaining "Phase N" or "not yet migrated" language that is now false.

- [ ] **Step 1: Write the failing test**

```javascript
// append to plugins/leave-me-alone/skills/skills.test.mjs
// readFileSync and fileURLToPath are already imported at the top of this file.
const root = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8')

test('the root README tells an operator to run brd init', () => {
  assert.match(root, /brd init/)
})

test('the root README no longer describes a board or a migration in flight', () => {
  assert.doesNotMatch(root, /Projects v2|read:project/)
  assert.doesNotMatch(root, /Phase 2|not yet migrated/i)
})
```

Check the relative path to `README.md` from the skills directory before running — adjust if the depth differs.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the doc changes**

- [ ] **Step 4: Run the whole suite**

- [ ] **Step 5: Commit**

```bash
git add README.md plugins/leave-me-alone/workflows/README.md plugins/leave-me-alone/skills/skills.test.mjs
git commit -m "docs: describe the finished migration"
```

---

## Phase 3 exit criteria

- `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/ plugins/leave-me-alone/hooks/ plugins/leave-me-alone/skills/` is green.
- No skill instructs the deleted board block: `grep -rn "optionIds\|fieldId\|statusField\|sub_issues" plugins/leave-me-alone/skills/` returns nothing.
- `brd init` appears in both `setup-project` and the root README.
- `auto-allow.sh` allows `cd <dir> && brd …` and no longer allows `gh project` writes.
- A dry run against a real brd board produces a correct `prTargets` column, and a single-subtask live run on a scratch repo ships a PR and leaves the milestone card at `in_progress`.

**The migration is complete when this phase lands.** What remains after it are the items triaged as acceptable to carry across all three phases — recorded in the ledgers and the PR bodies, not silently dropped.
