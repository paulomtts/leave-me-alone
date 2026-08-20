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
- its behavior change fits in one sentence with no "and"
- you can list its tests *before* any code exists — if you cannot, it is too big or too vague
- it touches few files, in one layer
- **the full suite is green with it alone.** This is the hard rule in stacked mode: every subtask's PR is verified on its own, so "half a feature that breaks tests until the next card lands" cannot exist. If a split leaves the tree red, it is the wrong split.

**Too big** — the title needs "and"; it spans layers (schema + route + UI); its plan would run past ~10 steps; you cannot name its tests without designing first.

**Too small** — it has no test of its own; it is a rename or a move; its PR would be pure noise. Fold it into the subtask whose behavior it serves.

**Order is stack order.** Subtask N+1 branches off N, so the sequence you create them in (or tag with ordinals) is the order they build in. Put the thing others rest on first. Reordering after the fact is expensive.

**Keep stories in the same level file-disjoint.** Stories with no dependency between them run in parallel, as separate stacks off the same base. If two of them edit the same files, nothing fails during the run — the conflict lands on whoever merges the stacks. Either give them disjoint footprints, or make one `blockedBy` the other so they stack instead.

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
| A subtask that leaves the suite red until the next one lands | Every subtask's PR is verified alone. That split is invalid — recut it. |
| Expecting the run to merge anything | It does not. Each story becomes a stack of open PRs; a human merges bottom-up. Subtask issues stay open and cards sit at "In review" until then. |
| Fixing the edges, then resuming the orchestrator run | Detect's result is cached on its prompt; a resume replays the stale empty snapshot. Relaunch as a NEW run with a fresh `nonce`. |
