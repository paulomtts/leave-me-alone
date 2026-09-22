---
name: setup-milestone
description: Use when turning an agreed spec into a milestone with story cards and granular subtask cards — "create a milestone", "set up a milestone for X", "break this spec/milestone/step into stories and subtasks", "add subtasks to the board" — on repos tracked with `brd` that the orchestrator/task workflows drive.
---

# Turning a spec into a milestone of stories and subtasks

Milestone = a top-level `brd` card (no parent). Story = a card parented to the milestone
(`--parent <milestone id>`). Subtask = a card parented to a story (`--parent <story id>`) — a real
card the workflows can dispatch, verify, and commit to its local branch, never a body checklist. `brd`'s hierarchy
IS the board: there is no label or view to get wrong, but a card created with the wrong `--parent` is
just as invisible to the story it should belong to.

The breakdown IS the product here. The workflows are only as good as the cards you hand them: a well-cut subtask gets a tight plan, a small diff, and a review that can actually gate it. An over-cut one gets a vague plan and a review that rubber-stamps a sprawling diff.

## Start from a spec, not from the milestone

This skill assumes a spec already exists — scope, the shape of the solution, the decisions already argued out. If it does not, stop and run `superpowers:brainstorming` first. Do not invent scope here.

Breaking down is a *reading* exercise against that spec: every subtask must trace to something the spec asked for. If you find yourself deciding what the product should do while writing issue bodies, that is brainstorming leaking into breakdown — go back.

What the spec gives you that the cards need:
- the slices and their order (becomes stories, and their `blockedBy` edges)
- the decisions already made (goes in bodies, so no stage re-litigates them)
- what is explicitly out of scope (goes in bodies, so no stage drifts into it)

## Rule zero: discover, don't invent

Existing conventions beat anything you'd make up. Before creating anything:

```bash
brd tree                    # the whole board: existing milestones, stories, subtasks, and any naming
                             # convention already in use — reuse it rather than inventing a new one
brd list --status todo      # spot-check titles/descriptions of open work for the same reason
```

Also check project memory / repo docs for naming schemes. pyjinhx: titles `L<layer>.<story>.<n> <module>: <thing>`, story bodies = context + reading order (no checklists — `brd tree` already renders progress), subtask bodies = "Subtask of <parent id>." + one line.

## Sizing: one subtask = one green local branch

Each subtask becomes one worktree, one branch, and one Review pass that must gate the whole diff. Size to that.

**A subtask is right-sized when:**
- its deliverable fits in one sentence with no "and"
- it touches few files, in one layer
- **the full suite is green with it alone.** This is the hard rule: every subtask is verified on its own, so "half a feature that breaks tests until the next card lands" cannot exist. If a split leaves the tree red, do not split there — either move the boundary, or make the two halves one subtask.

For a **behavior-changing** subtask, add: you can list its tests *before* any code exists. If you cannot, it is too big or too vague.

**Too big** — the title needs "and"; it spans layers (schema + route + UI); its plan would run past ~10 steps; you cannot name its tests without designing first.

**Too small** — it is a rename or a move, or its diff would be pure noise. Fold it into the subtask whose deliverable it serves.

### Subtasks that ship no behavior

Docs, config, scaffolding and pure-refactor cards are legitimate and must NOT be judged by "has its own tests" — they often have none, and that is correct. Judge them on their own terms:

- **Docs** — earns its own card when it describes something that must already exist (so it belongs *after* that work in the stack, or in a story blocked by it). Its "test" is that the thing it documents is real: it must read the actual implementation, not the spec's promise of it. Say so in the body.
- **Config / scaffolding** — earns a card when later subtasks depend on it and it can land green on its own (a CI file, a fixture, a new module skeleton with one real export). If nothing depends on it yet, fold it into the first thing that does.
- **Pure refactor** — earns a card when the existing suite covers it, so "green alone" means the refactor is behavior-preserving. If nothing covers it, the honest first card is the missing tests.

The common failure is a docs card written from the spec instead of the code, describing an interface that got built differently. Its body should name the files to read.

### Order is stack order, and it must be reproducible

Every branch name and every base is **derived**, not discovered:

```
milestone 12, card "Add retry" (a1b2c3d4…)  ->  branch m12/task-add-retry-a1b2c3d4
                                                 base   m12/task-<slug>-<shortid>   (the branch of the subtask before it)
```

The `m12/` prefix keeps one milestone's branches and worktrees together, so several can be in flight
in one checkout without becoming an unreadable pile. It is not what makes them unique — the short id
(the first 8 hex characters of the card's UUID) already does that, and matching keys on that short id
alone, so editing a card's title after its branch is created never orphans the branch.

So the ordering you give subtasks *is* the stack geometry. The workflow re-derives it from scratch on every run and looks for each branch at exactly that address — nothing is remembered between runs.

Two consequences, both load-bearing:

**Chain every subtask with `--blocked-by <previous subtask id>`.** Order comes from the `blocked_by`
edges between sibling cards, not from the title — chain a story's subtasks in sequence (subtask 2
`--blocked-by` subtask 1, subtask 3 `--blocked-by` subtask 2, …) so the board states the order.
Without a chain, independent siblings fall back to creation order — and creation order is not stable:
detaching and re-attaching a card moves it. A milestone ordered only by creation order can silently
re-shape its own stack between runs. Ordinal-looking title prefixes (`11.1 `, `L2.3.1 `, `1.2 `) are
optional decoration now — nothing parses them.

**Do not reorder subtasks once their branches exist.** Reordering re-points the bases, so branches created against the old geometry no longer sit on their stack parent — they build from the wrong parent. The run does not guess: it stops and halts the work as not done. If you must reorder, expect to re-stack the branches by hand.

Put the thing others rest on first.

**Keep stories in the same level file-disjoint.** Stories with no dependency between them run in parallel, as separate stacks off the same base. If two of them edit the same files, nothing fails during the run — the conflict lands on whoever merges the stacks. Either give them disjoint footprints, or make one `blockedBy` the other so they stack instead.

Estimating footprint before implementing is guesswork; you do not need precision, only overlap. Name the two or three files each story clearly owns. If two stories name the same file, treat them as overlapping and chain them.

### Worked example

Spec slice: *"the workflow checker should be consumable by other tooling, and its flags documented."*

A tempting single card — "add `--json` and `--quiet` and document them" — fails three ways: the title needs "and" twice, it spans code and docs, and it produces one fat diff for one Review pass to gate. Cut it:

```
story a1b2c3d4  Machine-readable output for check-workflows        root: main
  e5f6a7b8  11.1 feat: --json output          → main        one flag, tests nameable up front, green alone
  c9d0e1f2  11.2 feat: --quiet flag           → task-e5f6a7b8   second flag; stacks because both edit arg parsing

story 3a4b5c6d  Document the checker's flags                        root: task-c9d0e1f2   (blockedBy a1b2c3d4)
  7d8e9f0a  12.1 docs: document the flags     → task-c9d0e1f2   no tests of its own — correct for docs
```

Why it cuts this way:

- **e5f6a7b8 before c9d0e1f2** — both touch the same argument parsing. Stacking means c9d0e1f2 builds on e5f6a7b8's parser instead of racing it. Two parallel stories here would conflict at merge time.
- **e5f6a7b8 and c9d0e1f2 are separate**, not one "add both flags" card, because each is independently green and independently reviewable. The split costs one extra branch and buys two tight diffs.
- **7d8e9f0a is its own story, not a third subtask of a1b2c3d4**, because it is a different kind of work with a different footprint (`README`, not `scripts/`). As a story blocked by a1b2c3d4 it roots on `task-c9d0e1f2`, so its worktree contains both finished flags — it can document what was actually built.
- **7d8e9f0a has no tests, and that is right.** Judged by the behavior-subtask rule it would look "too small" and get folded in; judged as docs, it is correctly sized.

What would make this breakdown wrong: putting 7d8e9f0a in level 0 (it would root at `main` and document flags its worktree cannot see), or giving 3a4b5c6d a second blocker (the run refuses to root a stack on two parents).

## Sequence

1. **Milestone** — if it doesn't already exist (checked in Rule zero), create it:
   ```bash
   brd add --title "<title>" --description "<one-line goal>"
   ```
   If it already exists, reuse it as-is — don't rename or redescribe it without being asked.
2. **Story card** — one per slice, parented to the milestone:
   ```bash
   brd add --title "<title>" --parent <milestone id> --description "<context for the whole story>"
   ```
3. **Subtask cards** — one per granular unit, sized per the section above, parented to their story:
   ```bash
   brd add --title "<title>" --parent <story id> --description "<spec's constraints + out-of-scope line>"
   ```
   `--parent` attaches the card as it's created — there is no separate "attach to board" step.

   **Short ids must stay unique within a milestone.** Each card's branch and PR both key on the first
   8 hex characters of its UUID. `brd` mints `uuid4`s, so a collision inside one milestone is
   astronomically unlikely — but nothing checks it at creation time, and a collision would silently
   give two subtasks the same branch. If a milestone runs unusually large, or two ids look alike at a
   glance, `brd tree <milestone id>` lists every id in the milestone — diff the first 8 characters
   before trusting the stack.
4. **Chain each story's subtasks in sequence** — see "Order is stack order" above:
   ```bash
   brd block <subtask 2 id> --by <subtask 1 id>
   brd block <subtask 3 id> --by <subtask 2 id>
   ```
5. **Story dependencies** — set `blockedBy` edges between stories with `brd block`. **Not optional**, and *not* the same thing as parenting: parenting is milestone→story→subtask, this is story→story.

   **At most ONE blocker per story.** The orchestrator roots a story's stack on its blocker's tip branch, and it can only root on one parent — a story with two blockers stops the run with an error rather than guessing. If the spec really needs two, either merge the blockers first, or chain them (A ← B ← C) so each has a single parent.
   ```bash
   brd block <BLOCKED_STORY_ID> --by <BLOCKER_STORY_ID>
   ```
   Derive the edges from the spec's own slice order, then **write down the DAG you intended** — the next step checks the board against it.
6. **Verify** — read the tree back and compare it to what you intended:
   ```bash
   brd tree <milestone id>
   ```
   Check: the milestone shows every story and subtask you meant to create, each story's subtasks are chained in the right order, and each story's `blocked_by` matches the DAG you wrote down in step 5. **If more than one story has no blockers, stop and say so** — a real milestone has one or two genuine roots, so a flat list of unblocked stories usually means an edge was never written, not that the work is parallel. **If any story shows two or more blockers, fix it now** — the orchestrator will refuse it.
7. **Dry run** — the real pre-flight, writes nothing:
   ```
   Workflow({ name: "orchestrator" }, args: {
     repo, repoDir, milestone: "<brd card id or title substring>", baseBranch, nonce: "<now>", dryRun: true,
     taskScript: "/abs/path/to/leave-me-alone/workflows/task.js",
     detectScript: "/abs/path/to/leave-me-alone/scripts/detect.mjs",
     branchPrefix: "m12"
   })
   ```
   `taskScript` and `detectScript` are always required — absolute paths, no default, since this repo
   can be checked out anywhere. `branchPrefix` is required here too because `milestone` is a card
   id/title substring rather than a positive integer, so there is no safe default to derive one
   from (a title could produce an invalid git ref). Addressing the milestone by a plain positive
   integer instead (`milestone: 12`) is the one case where `branchPrefix` can be omitted — it then
   defaults to `m12`.

   No `project` argument — `brd` resolves everything by walking the repo directory, per `setup-project`. Check the `base` column: each subtask should build on the previous subtask's branch, and each story's first subtask should build on its blocker's tip (or the base, if unblocked). If that column is wrong, the breakdown is wrong — fix the board, not the workflow.

## Gotchas

| Trap | Reality |
|---|---|
| Writing scope while breaking down | Breakdown reads a spec; it does not author one. Run `superpowers:brainstorming` first. |
| Body checklists "for visibility" | Double-tracking; `brd tree` already renders progress from the real card hierarchy. Omit. |
| Creating a milestone that already exists under a slightly different title | Check Rule zero's `brd tree` first — near-duplicate milestones split tracking. Reuse the existing one. |
| Assuming `--parent` implies execution order | It doesn't. Parenting is milestone→story→subtask containment; the orchestrator orders *stories*, and a story's *subtasks*, by `blocked_by` only. A tree can render perfectly while every `blocked_by` list is empty. |
| Treating empty `blockedBy` as harmless | The orchestrator cannot tell "no deps recorded" from "genuinely independent" — both are `[]`. It places every story at level 0 and dispatches them all at once, against a base none of them has built on. |
| Giving a story two blockers | Stops the run: a stack can only root on one parent branch. Chain them instead. |
| A subtask that leaves the suite red until the next one lands | Every subtask is verified alone. That split is invalid — move the boundary or merge the two halves. |
| Folding in a docs/config/refactor card because "it has no tests" | That rule is for behavior-changing subtasks only. Judge these on their own terms — see "Subtasks that ship no behavior". |
| A docs card written from the spec | It must read the actual implementation, which means it has to sit *after* that work in the stack. Name the files to read in its body. |
| Expecting the run to merge anything | It does not. Each story becomes a stack of committed local branches. A subtask's card reaches `done` when it is verified and committed to its local branch — nothing is pushed. The orchestrator's Integrate phase merges all stories into one local branch; a human then runs `git merge <that branch>` into `main`/`master` themselves. |
| Subtasks not chained with `--blocked-by` | Order falls back to creation order, which re-attaching a child can change. The stack geometry is derived from that order, so it can shift between runs. Always chain a story's subtasks. |
| Reordering subtasks after their branches exist | The bases are derived from order, so reordering re-points them and the existing branches sit on the wrong parent. Fix by re-stacking by hand or don't reorder. |
| Changing `branchPrefix` between runs of the same milestone | Branch names are derived from it, so the run looks for branches at a new address. It detects a merged branch under the old name and HALTS rather than re-implementing it, but only a re-run with the original prefix actually fixes it. |
| Fixing the edges, then resuming the orchestrator run | Detect's result is cached on its prompt; a resume replays the stale empty snapshot. Relaunch as a NEW run with a fresh `nonce`. |
