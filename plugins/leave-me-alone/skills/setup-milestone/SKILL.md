---
name: setup-milestone
description: Use when turning an agreed spec into a GitHub milestone with story issues and granular subtask cards — "create a milestone", "set up a milestone for X", "break this spec/milestone/step into stories and subtasks", "add subtasks to the board" — on repos using a story/subtask Projects-v2 board that the orchestrator/task workflows drive.
---

# Turning a spec into a milestone of stories and subtasks

Milestone = the container for the release/step. Story = parent issue inside it. Subtasks = real GitHub **sub-issues** (own cards on the board), never body checklists. Board views filter by label, so wrong labels = invisible cards.

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
gh label list --limit 50                                  # reuse exact label names (e.g. `subtask`, NOT `task`)
gh api repos/{owner}/{repo}/milestones --jq '.[].title'    # check whether the target milestone already exists
gh api graphql -f query='{ user(login:"OWNER") { projectV2(number:N) { views(first:10) { nodes { name filter } } } } }'
```

Also check project memory / repo docs for naming schemes. pyjinhx: titles `L<layer>.<story>.<n> <module>: <thing>`, story bodies = context + reading order (no checklists — the native sub-issue tree tracks progress), subtask bodies = "Subtask of #<parent>." + one line.

## Sizing: one subtask = one green PR

Each subtask becomes one worktree, one branch, one PR, and one Review pass that must gate the whole diff. Size to that.

**A subtask is right-sized when:**
- its deliverable fits in one sentence with no "and"
- it touches few files, in one layer
- **the full suite is green with it alone.** This is the hard rule: every subtask's PR is verified on its own, so "half a feature that breaks tests until the next card lands" cannot exist. If a split leaves the tree red, do not split there — either move the boundary, or make the two halves one subtask.

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

Every branch name and every PR target is **derived**, not discovered:

```
milestone 12, subtask #14  ->  branch m12/task-14   (branchPrefix + issue number)
                               base   m12/task-13   (the branch of the subtask before it)
```

The `m12/` prefix keeps one milestone's branches and worktrees together, so several can be in flight
in one checkout without becoming an unreadable pile. It is not what makes them unique — the issue
number already does that.

So the ordering you give subtasks *is* the stack geometry. The workflow re-derives it from scratch on every run and looks for each PR at exactly that address — nothing is remembered between runs.

Two consequences, both load-bearing:

**Give every subtask an ordinal prefix in its title** (`11.1 `, `L2.3.1 `, `1.2 `). Without one, order falls back to the order the sub-issues endpoint returns, which is creation order — and creation order is not stable: detaching and re-attaching a sub-issue moves it. A milestone ordered only by creation order can silently re-shape its own stack between runs. With ordinals, the order is written down in the titles and survives anything.

**Do not reorder subtasks once their PRs exist.** Reordering re-points the bases, so PRs opened against the old geometry no longer sit on their stack parent. The run does not guess: it reports them as `wrong-base` and treats that work as not done. If you must reorder, expect to re-target the open PRs by hand.

Put the thing others rest on first.

**Keep stories in the same level file-disjoint.** Stories with no dependency between them run in parallel, as separate stacks off the same base. If two of them edit the same files, nothing fails during the run — the conflict lands on whoever merges the stacks. Either give them disjoint footprints, or make one `blockedBy` the other so they stack instead.

Estimating footprint before implementing is guesswork; you do not need precision, only overlap. Name the two or three files each story clearly owns. If two stories name the same file, treat them as overlapping and chain them.

### Worked example

Spec slice: *"the workflow checker should be consumable by other tooling, and its flags documented."*

A tempting single card — "add `--json` and `--quiet` and document them" — fails three ways: the title needs "and" twice, it spans code and docs, and it produces one fat diff for one Review pass to gate. Cut it:

```
story #11  Machine-readable output for check-workflows        root: main
  #13  11.1 feat: --json output          → main        one flag, tests nameable up front, green alone
  #14  11.2 feat: --quiet flag           → task-13     second flag; stacks because both edit arg parsing

story #12  Document the checker's flags                        root: task-14   (blockedBy #11)
  #15  12.1 docs: document the flags     → task-14     no tests of its own — correct for docs
```

Why it cuts this way:

- **#13 before #14** — both touch the same argument parsing. Stacking means #14 builds on #13's parser instead of racing it. Two parallel stories here would conflict at merge time.
- **#13 and #14 are separate**, not one "add both flags" card, because each is independently green and independently reviewable. The split costs one extra PR and buys two tight diffs.
- **#15 is its own story, not a third subtask of #11**, because it is a different kind of work with a different footprint (`README`, not `scripts/`). As a story blocked by #11 it roots on `task-14`, so its worktree contains both finished flags — it can document what was actually built.
- **#15 has no tests, and that is right.** Judged by the behavior-subtask rule it would look "too small" and get folded in; judged as docs, it is correctly sized.

What would make this breakdown wrong: putting #15 in level 0 (it would root at `main` and document flags its worktree cannot see), or giving #12 a second blocker (the run refuses to root a stack on two parents).

## Sequence

1. **Milestone** — if it doesn't already exist (checked in Rule zero), create it:
   ```bash
   gh api repos/{owner}/{repo}/milestones -f title="<title>" -f description="<one-line goal>" ${DUE_ON:+-f due_on=$DUE_ON}
   ```
   If it already exists, reuse it as-is — don't rename or redate it without being asked.
2. **Story issue** — `gh issue create` with `--milestone <title>`, labels `story` + track label (e.g. `v2`) + kind.
3. **Subtask issues** — one per granular unit, sized per the section above, label `subtask` + track. Body carries the spec's constraints and its out-of-scope line, so no downstream stage has to guess.
4. **Attach as sub-issues** — REST, needs the **database id**, not the number and not the GraphQL node id:
   ```bash
   id=$(gh api repos/{owner}/{repo}/issues/<CHILD_NUM> --jq .id)
   gh api -X POST repos/{owner}/{repo}/issues/<PARENT_NUM>/sub_issues -F sub_issue_id=$id
   ```
   (Do not use the experimental `addSubIssue` GraphQL mutation.)
5. **Story dependencies** — set `blockedBy` edges between stories. **Not optional**, and *not* the same thing as step 4: sub-issues are parent→child, these are story→story.

   **At most ONE blocker per story.** The orchestrator roots a story's stack on its blocker's tip branch, and it can only root on one parent — a story with two blockers stops the run with an error rather than guessing. If the spec really needs two, either merge the blockers first, or chain them (A ← B ← C) so each has a single parent.
   ```bash
   # needs the BLOCKER's database id, not its number
   bid=$(gh api repos/{owner}/{repo}/issues/<BLOCKER_NUM> --jq .id)
   gh api -X POST repos/{owner}/{repo}/issues/<BLOCKED_NUM>/dependencies/blocked_by -F issue_id=$bid
   ```
   Derive the edges from the spec's own slice order, then **write down the DAG you intended** — step 8 checks the board against it.
6. **Board** — `gh project item-add N --owner OWNER --url <issue-url>` for every card, parents included.
7. **Status** — set the field (usually `Backlog`) via `updateProjectV2ItemFieldValue`; fetch project/field/option ids first. `gh project item-edit --single-select-option-id` also works.
8. **Verify** — milestone shows the right issue count, item count on the board matches, spot-check one parent shows its sub-issue tree. Then **verify the DAG, and fail loudly**:
   ```bash
   for n in <EVERY_STORY_NUMBER>; do
     deps=$(gh api graphql -f query="{repository(owner:\"OWNER\",name:\"REPO\"){issue(number:$n){blockedBy(first:20){nodes{number}}}}}" \
            --jq '[.data.repository.issue.blockedBy.nodes[].number]|join(",")')
     echo "#$n blockedBy [$deps]"
   done
   ```
   Compare against the DAG you wrote in step 5. **If more than one story has no blockers, stop and say so** — a real milestone has one or two genuine roots, so a flat list of empty arrays means the edges were never written, not that the work is parallel. **If any story lists two or more blockers, fix it now** — the orchestrator will refuse it.
9. **Dry run** — the real pre-flight, writes nothing:
   ```
   Workflow({ name: "orchestrator" }, args: { repo, repoDir, milestone: N, baseBranch, nonce: "<now>", dryRun: true, project: { number: P } })
   ```
   Check the `prTargets` column: each subtask should target the previous subtask's branch, and each story's first subtask should target its blocker's tip (or the base, if unblocked). If that column is wrong, the breakdown is wrong — fix the board, not the workflow.

## Gotchas

| Trap | Reality |
|---|---|
| Writing scope while breaking down | Breakdown reads a spec; it does not author one. Run `superpowers:brainstorming` first. |
| Body checklists "for visibility" | Double-tracking; sub-issue tree already renders progress. Omit. |
| Inventing `task`/`story` label variants | Views filter on exact labels (`label:subtask`). Wrong name → card in no view. |
| "Views can't be configured via API" | False: `updateProjectV2View`/`createProjectV2View` mutations work (undocumented but live). |
| Creating a milestone that already exists under a slightly different title | Check Rule zero's title list first — near-duplicate milestones split tracking. Reuse the existing one. |
| Editing Status *options* while items hold values | Option replacement WIPES every item's status. Re-set after any column change. |
| Assuming sub-issue links imply an execution order | They don't. Sub-issues are parent→child; the orchestrator orders *stories* by `blockedBy` only. Trees can render perfectly while the DAG is empty. |
| Treating empty `blockedBy` as harmless | The orchestrator cannot tell "no deps recorded" from "genuinely independent" — both are `[]`. It places every story at level 0 and dispatches them all at once, against a base none of them has built on. |
| Giving a story two blockers | Stops the run: a stack can only root on one parent branch. Chain them instead. |
| A subtask that leaves the suite red until the next one lands | Every subtask's PR is verified alone. That split is invalid — move the boundary or merge the two halves. |
| Folding in a docs/config/refactor card because "it has no tests" | That rule is for behavior-changing subtasks only. Judge these on their own terms — see "Subtasks that ship no behavior". |
| A docs card written from the spec | It must read the actual implementation, which means it has to sit *after* that work in the stack. Name the files to read in its body. |
| Expecting the run to merge anything | It does not. Each story becomes a stack of open PRs; a human merges bottom-up. Subtask issues stay open and cards sit at "In review" until then. |
| Subtasks with no ordinal prefix in the title | Order falls back to the sub-issues endpoint's creation order, which re-attaching a child can change. The stack geometry is derived from that order, so it can shift between runs. Always prefix. |
| Reordering subtasks after their PRs are open | The bases are derived from order, so reordering re-points them and the existing PRs read as `wrong-base` — i.e. not done. Re-target by hand or don't reorder. |
| Changing `branchPrefix` between runs of the same milestone | Branch names are derived from it, so the run looks for PRs at a new address. It detects a merged PR under the old name and HALTS rather than re-implementing it, but only a re-run with the original prefix actually fixes it. |
| Fixing the edges, then resuming the orchestrator run | Detect's result is cached on its prompt; a resume replays the stale empty snapshot. Relaunch as a NEW run with a fresh `nonce`. |
