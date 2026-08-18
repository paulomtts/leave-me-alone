---
name: milestone
description: Use when setting up a GitHub milestone and breaking its work into story issues with granular subtask cards — "create a milestone", "set up a milestone for X", "break this milestone/step into stories and subtasks", "add subtasks to the board" — on repos using a story/subtask Projects-v2 board (e.g. paulomtts/pyjinhx, project 12).
---

# Setting up a milestone with stories and subtasks on GitHub

Milestone = the container for the release/step. Story = parent issue inside it. Subtasks = real GitHub **sub-issues** (own cards on the board), never body checklists. Board views filter by label, so wrong labels = invisible cards.

## Rule zero: discover, don't invent

Existing conventions beat anything you'd make up. Before creating anything:

```bash
gh label list --limit 50                                  # reuse exact label names (e.g. `subtask`, NOT `task`)
gh api repos/{owner}/{repo}/milestones --jq '.[].title'    # check whether the target milestone already exists
gh api graphql -f query='{ user(login:"OWNER") { projectV2(number:N) { views(first:10) { nodes { name filter } } } } }'
```

Also check project memory / repo docs for naming schemes. pyjinhx: titles `L<layer>.<story>.<n> <module>: <thing>`, story bodies = context + reading order (no checklists — the native sub-issue tree tracks progress), subtask bodies = "Subtask of #<parent>." + one line.

## Sequence

1. **Milestone** — if it doesn't already exist (checked in Rule zero), create it:
   ```bash
   gh api repos/{owner}/{repo}/milestones -f title="<title>" -f description="<one-line goal>" ${DUE_ON:+-f due_on=$DUE_ON}
   ```
   If it already exists, reuse it as-is — don't rename or redate it without being asked.
2. **Story issue** — `gh issue create` with `--milestone <title>`, labels `story` + track label (e.g. `v2`) + kind.
3. **Subtask issues** — one per granular unit (one function/behavior + its tests), label `subtask` + track.
4. **Attach as sub-issues** — REST, needs the **database id**, not the number and not the GraphQL node id:
   ```bash
   id=$(gh api repos/{owner}/{repo}/issues/<CHILD_NUM> --jq .id)
   gh api -X POST repos/{owner}/{repo}/issues/<PARENT_NUM>/sub_issues -F sub_issue_id=$id
   ```
   (Do not use the experimental `addSubIssue` GraphQL mutation.)
5. **Story dependencies** — set `blockedBy` edges between stories. **Not optional**, and *not* the same thing as step 4: sub-issues are parent→child, these are story→story. The orchestrator computes its dispatch levels from these and nothing else.
   ```bash
   # needs the BLOCKER's database id, not its number
   bid=$(gh api repos/{owner}/{repo}/issues/<BLOCKER_NUM> --jq .id)
   gh api -X POST repos/{owner}/{repo}/issues/<BLOCKED_NUM>/dependencies/blocked_by -F issue_id=$bid
   ```
   Derive the edges from the spec's own slice/dependency order, then **write down the DAG you intended** — step 8 checks the board against it.
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
   Compare against the DAG you wrote in step 5. **If more than one story has no blockers, stop and say so** — a real milestone has one or two genuine roots, so a flat list of empty arrays means the edges were never written, not that the work is parallel. Do not hand the milestone to the orchestrator until this matches.

## Gotchas

| Trap | Reality |
|---|---|
| Body checklists "for visibility" | Double-tracking; sub-issue tree already renders progress. Omit. |
| Inventing `task`/`story` label variants | Views filter on exact labels (`label:subtask`). Wrong name → card in no view. |
| "Views can't be configured via API" | False: `updateProjectV2View`/`createProjectV2View` mutations work (undocumented but live). |
| Creating a milestone that already exists under a slightly different title | Check Rule zero's title list first — near-duplicate milestones split tracking. Reuse the existing one. |
| Editing Status *options* while items hold values | Option replacement WIPES every item's status. Re-set after any column change. |
| Assuming sub-issue links imply an execution order | They don't. Sub-issues are parent→child; the orchestrator orders *stories* by `blockedBy` only. Trees can render perfectly while the DAG is empty. |
| Treating empty `blockedBy` as harmless | The orchestrator cannot tell "no deps recorded" from "genuinely independent" — both are `[]`. It places every story at level 0 and dispatches them all at once, against a codebase the earlier stories haven't built yet. |
| Fixing the edges, then resuming the orchestrator run | Detect's result is cached on its prompt; a resume replays the stale empty snapshot. Relaunch as a NEW run with a fresh `nonce`. |
