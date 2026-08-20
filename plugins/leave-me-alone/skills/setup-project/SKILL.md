---
name: setup-project
description: Use when preparing a repo's GitHub Projects v2 board so the global orchestrator/task workflows can drive it — "set up the board for this repo", "is my project ready for the orchestrator", "the workflow says my Status field is missing", "create the story/subtask labels and Status column". Covers the board, field, labels, milestone and sub-issue preconditions, plus a pre-flight verification checklist.
---

# Preparing a GitHub project board for the orchestrator/task workflows

`~/.claude/workflows/orchestrator.js` and `~/.claude/workflows/task.js` are repo-agnostic: they take
`repo`, `repoDir`, `milestone`, `baseBranch` and an optional `project` block, and resolve every
board id **by name at runtime**. Nothing is hardcoded — but the names have to exist.

This skill is about the **board**. Creating the issues themselves (story + subtask shape, bodies,
sub-issue attachment) is `setup-milestone` — cross-reference it, don't duplicate it. Do that one
first, this one second.

Replace `OWNER`/`REPO` throughout. `gh auth status` must show the `project` scope
(`gh auth refresh -s project,read:project` if not).

## Rule zero: discover, don't invent

The workflows accept your names; they cannot invent them. Before changing anything, look:

```bash
gh project list --owner OWNER --format json --jq '.projects[] | {number, title, url}'
gh label list --repo OWNER/REPO --limit 100
gh api repos/OWNER/REPO/milestones --jq '.[] | {number, title, open_issues}'
```

If a board already exists with different column names (`Todo`/`Doing`/`Review`/`Shipped`), **keep
them** and tell the workflow instead of renaming — renaming Status *options* while items hold values
wipes every card's status.

## 1. The board

```bash
# does one exist?
gh project list --owner OWNER --format json --jq '.projects[] | "\(.number)\t\(.title)"'

# create one if not (user-owned; use the org login for an org board)
gh project create --owner OWNER --title "REPO delivery"
```

Note the **project number** (the small integer in the URL, e.g. `/users/OWNER/projects/12`), not the
`PVT_…` node id. The number is what you pass as `project.number`; the workflow resolves the node id.

## 2. The Status single-select field

The workflows need one single-select field with four options. Defaults:
`Status` / `Backlog`, `In progress`, `In review`, `Done`.

Inspect what's there:

```bash
gh api graphql -f query='
query($o:String!,$n:Int!){ user(login:$o){ projectV2(number:$n){ id title
  fields(first:50){ nodes{ ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }' \
  -f o=OWNER -F n=NUMBER
```

(For an org board swap `user(login:)` → `organization(login:)`. The workflow tries both.)

New boards ship a `Status` field with `Todo` / `In Progress` / `Done`. Two ways forward:

**A — tell the workflow your names** (safest, zero mutation):

```jsonc
"project": { "number": 12, "statusField": "Status",
             "options": { "backlog": "Todo", "inProgress": "In Progress",
                          "inReview": "In review", "done": "Done" } }
```

Every option you name must still *exist* — the workflow needs a distinct "in review" column,
so add one if there is none.

**B — set the options explicitly** (do this while the board is still empty):

```bash
FIELD_ID=$(gh api graphql -f query='query($o:String!,$n:Int!){user(login:$o){projectV2(number:$n){fields(first:50){nodes{... on ProjectV2SingleSelectField{id name}}}}}}' \
  -f o=OWNER -F n=NUMBER --jq '.data.user.projectV2.fields.nodes[] | select(.name=="Status") | .id')

gh api graphql -f query='
mutation($f:ID!){ updateProjectV2Field(input:{fieldId:$f, singleSelectOptions:[
  {name:"Backlog",     color:GRAY,   description:""},
  {name:"In progress", color:YELLOW, description:""},
  {name:"In review",   color:BLUE,   description:""},
  {name:"Done",        color:GREEN,  description:""}]}){ projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }' \
  -f f="$FIELD_ID"
```

**Option replacement wipes the Status of every item already on the board.** Do it before adding
cards, or plan to re-set each card afterwards.

If the field itself is missing, create it:

```bash
PROJECT_ID=$(gh api graphql -f query='query($o:String!,$n:Int!){user(login:$o){projectV2(number:$n){id}}}' -f o=OWNER -F n=NUMBER --jq '.data.user.projectV2.id')
gh api graphql -f query='
mutation($p:ID!){ createProjectV2Field(input:{projectId:$p, dataType:SINGLE_SELECT, name:"Status",
  singleSelectOptions:[{name:"Backlog",color:GRAY,description:""},{name:"In progress",color:YELLOW,description:""},{name:"In review",color:BLUE,description:""},{name:"Done",color:GREEN,description:""}]}){ projectV2Field { ... on ProjectV2SingleSelectField { id } } } }' \
  -f p="$PROJECT_ID"
```

Names are matched **exactly** (case and spacing included). `In Progress` ≠ `In progress`.

## 3. Labels

`orchestrator` finds stories with `--label story`; `task` refuses an issue that is not labelled
`subtask`. Both are overridable via `labels: { story: "...", subtask: "..." }`.

```bash
gh label list --repo OWNER/REPO --limit 100 | grep -Ei 'story|subtask|task'
gh label create story   --repo OWNER/REPO --color 1D76DB --description "Parent issue: one PR's worth of work" 2>/dev/null || true
gh label create subtask --repo OWNER/REPO --color BFD4F2 --description "Sub-issue of a story: one commit series" 2>/dev/null || true
```

Reuse an existing name (`task`, `chore`) by passing it in `labels` rather than creating a synonym —
board views filter on exact labels, so a synonym puts cards in no view.

## 4. Milestones and the sub-issue relation

The orchestrator takes a milestone **number** and resolves its title itself:

```bash
gh api repos/OWNER/REPO/milestones/4 --jq '{number,title,open_issues,closed_issues}'
gh issue list --repo OWNER/REPO --milestone "<that title>" --label story --state all --json number,title
```

A missing milestone means the wrong number or the wrong repo — stop and check, don't create one here.

Subtasks must be **native GitHub sub-issues**, never body checklists — the workflows read
`GET /repos/OWNER/REPO/issues/<story>/sub_issues`, and a checklist is invisible to it:

```bash
gh api repos/OWNER/REPO/issues/<STORY>/sub_issues --jq '.[] | {number,title,state}'
# attach a missing child — needs the DATABASE id, not the number, not the node id:
id=$(gh api repos/OWNER/REPO/issues/<CHILD> --jq .id)
gh api -X POST repos/OWNER/REPO/issues/<STORY>/sub_issues -F sub_issue_id=$id
```

**Ordering — give every subtask an ordinal prefix.** Order decides the stack geometry: branch names
are derived (`branchPrefix` + issue number) and each subtask's PR targets the previous subtask's
branch, so the order *is* the set of PR targets. The workflows detect an ordinal prefix like
`L2.3.1 …` / `1.2 …` automatically; a repo with a different convention passes `ordinalPattern` (a JS
regex string whose **first capture group** is the ordinal).

Without any ordinal, order falls back to the order the `sub_issues` endpoint returns — creation
order — which detaching and re-attaching a child will change. That silently re-shapes the stack
between runs, and PRs opened against the old shape then read as `wrong-base`. It works, but only for
a milestone nobody ever touches.

**`branchPrefix` is part of the milestone's identity.** It defaults to `m<milestone>/task-`, so
subtask #13 of milestone 12 builds on `m12/task-13` in worktree `.claude/worktrees/m12/task-13`.
That grouping is for legibility and cleanup — `git branch --list "m12/*"`, `rm -rf
.claude/worktrees/m12` — not for avoiding collisions, since issue numbers are already unique per
repo. Branch names are derived from the prefix, so changing it mid-milestone points the run at
addresses where nothing exists. It will not quietly re-implement
finished work — a merged PR found under the old name halts the run and names the prefix as the
cause — but the only real fix is re-running with the prefix the milestone was built under. Never
randomise or timestamp it.

**Dependencies between stories** must be GitHub's native `blockedBy` relation (Development →
"blocked by"), which the orchestrator reads via GraphQL. They do two jobs: they order the dispatch
levels, and they decide what branch each story's stack **roots on** — a blocked story starts from its
blocker's tip branch, not from `baseBranch`. Since nothing is merged during a run, that rooting is
the only way a story ever sees the code it depends on.

No `blockedBy` edges = one flat level = every story dispatched in parallel, each rooted at
`baseBranch` and blind to the others. **At most one blocker per story** — a stack can only root on
one parent, and a story with two blockers stops the run rather than guessing which. Chain them
(A ← B ← C) instead.

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){blockedBy(first:50){nodes{number}}}}}' \
  -f o=OWNER -f r=REPO -F n=<STORY>
```

## 5. Get every card onto the board

Cards that aren't on the board can't be moved; the workflow reports it and moves on, rather than
adding them for you.

```bash
for n in $(gh issue list --repo OWNER/REPO --milestone "TITLE" --state all --json number --jq '.[].number'); do
  gh project item-add NUMBER --owner OWNER --url https://github.com/OWNER/REPO/issues/$n
done
```

Parents included — the story card is what the "in review"/"Done" mirroring writes to.

## Ready-check

Run this before the first real dispatch. Every line must come back non-empty / true.

```bash
OWNER=…; REPO=…; PROJ=…; MS=…

# 1. board + Status field + all four option names resolve
gh api graphql -f query='query($o:String!,$n:Int!){user(login:$o){projectV2(number:$n){id title fields(first:50){nodes{... on ProjectV2SingleSelectField{name options{name}}}}}}}' \
  -f o=$OWNER -F n=$PROJ --jq '.data.user.projectV2 | {id, title, status: (.fields.nodes[] | select(.name=="Status") | [.options[].name])}'
# 2. labels exist
gh label list --repo $OWNER/$REPO --json name --jq '[.[].name] | map(select(.=="story" or .=="subtask"))'
# 3. milestone resolves and has stories
gh api repos/$OWNER/$REPO/milestones/$MS --jq .title
gh issue list --repo $OWNER/$REPO --milestone "$(gh api repos/$OWNER/$REPO/milestones/$MS --jq .title)" --label story --state all --json number,title
# 4. every story has native sub-issues
for s in $(gh issue list --repo $OWNER/$REPO --milestone "$(gh api repos/$OWNER/$REPO/milestones/$MS --jq .title)" --label story --state all --json number --jq '.[].number'); do
  echo -n "#$s subtasks: "; gh api repos/$OWNER/$REPO/issues/$s/sub_issues --jq 'length'
done
# 5. every issue is on the board (count should match the milestone's issue count)
gh project item-list $PROJ --owner $OWNER --format json --jq '.items | length'
# 6. the base branch exists
gh api repos/$OWNER/$REPO/branches/main --jq .name
```

Then the real pre-flight — a dry run that writes nothing:

```
Workflow({ name: "orchestrator" }, args: {
  repo: "OWNER/REPO", repoDir: "/abs/path", milestone: MS, baseBranch: "main",
  nonce: "<current timestamp>", dryRun: true,
  project: { number: PROJ }
})
```

It returns the resolved board ids, the discovered test/lint commands, the dependency levels, and the
ordered subtask list per story — each with a `prTargets` field naming the branch that subtask's PR
will target. **Read that column.** Each subtask should target the previous one's branch, and each
story's first subtask should target its blocker's tip (or `baseBranch` if it has none). A story
rooted at `baseBranch` when it has a blocker means the edge is missing, and the story will be built
against a base that has never seen the code it depends on.

If the levels, the subtask order, or the targets look wrong, fix the board — not the workflow.

## Skipping the agents entirely

The orchestrator's two agents exist because a Workflow script cannot execute a command — not because
either decides anything. Both can be handed their answers instead:

**Either** point the run at the census script, so its agent is reduced to a trigger:

```jsonc
"detectScript": "/abs/path/to/leave-me-alone/scripts/detect.mjs"
```

The Detect prompt becomes one command (~890 characters instead of ~4,300), run via `bun`, whose
stdout the orchestrator parses itself. Same wiring as `taskScript`: an absolute path, no default.

**Or** run it yourself and hand over the result:

```bash
# steps 1-4 of Detect, deterministically. No model involved.
bun scripts/detect.mjs --repo OWNER/REPO --milestone 12 --compact > state.json
```

```jsonc
"state":        { /* the contents of state.json */ },
"verification": { "fullSuite": ["npm test"], "typecheck": "", "lint": [] },
"project":      { "id": "PVT_…", "fieldId": "PVTSSF_…", "optionIds": { … } }
```

Supply all three and the orchestrator dispatches **no agents at all** before it starts work. With
`detectScript` instead of `state`, it dispatches one agent that runs one command. Supply
some and it asks only for what is missing — `verification` alone removes about 40% of Detect's
prompt, and it is the only part of that stage that involves real judgement.

`state` must be freshly generated: it is a snapshot of what is merged and what is open, and a stale
one will re-dispatch finished work. Regenerate it per run, or omit it and let the agent look.

## Skipping the id lookup

Resolving `{number: 12}` into node ids costs one agent dispatch per run. The ids never change, so you
can hand them over instead and skip it. Every successful run logs them ready to paste:

```
board ids for reuse — pass these back to skip this lookup next run: {"id":"PVT_…","fieldId":"PVTSSF_…","optionIds":{…}}
```

```jsonc
"project": { "id": "PVT_…", "fieldId": "PVTSSF_…",
             "optionIds": { "backlog": "…", "inProgress": "…", "inReview": "…", "done": "…" } }
```

All four option ids must be present — a partial block is rejected rather than half-applied, because
disabling exactly one column's moves looks like it worked. Column names are matched **in the script,
exactly**, so a board renamed since you copied the ids will move cards to whatever those ids now
point at: re-resolve from `number` after any column change.

## Gotchas

| Trap | Reality |
|---|---|
| Passing `PVT_…` as `project.number` | `number` is the small integer from the URL. The node id is resolved for you. |
| Renaming Status options on a populated board | Option replacement wipes every item's Status. Re-set each card afterwards. |
| `In Progress` vs `In progress` | Matched exactly, in the script — not by an agent. A mismatch disables the board and logs both strings, rather than resolving to a real id for the wrong column. |
| Passing `project` with neither a `number` nor a complete id block | The board is disabled and the run says so. It no longer reports this as `boardless: true`, which it never was. |
| Body checklists instead of sub-issues | `sub_issues` returns empty → `task` refuses the story as having nothing to sequence. |
| Adding cards to the board later | Cards missing at resolve time are reported, never auto-added. |
| Expecting a card per PR | One PR per **subtask**. Each subtask's card goes "In review" when its own PR opens. |
| Expecting cards to reach "Done" | The run never merges, so nothing closes. Cards stop at "In review" and issues stay open until a human merges the stack. "Done" is still required to exist — the board resolver checks all four option names. |
| Expecting flat branch names | The default prefix is `m<milestone>/task-`, so branches and worktrees nest per milestone. Pass `branchPrefix` explicitly for a flat scheme — it is used verbatim. |
| Adopting the milestone prefix on a milestone that already has merged PRs | Those PRs sit at the old addresses. The run finds them as near misses and HALTS rather than re-implementing them; finish that milestone under its original prefix. |
| Renaming a branch, or changing `branchPrefix`, mid-milestone | Branches are derived, never discovered. A merged PR under the old name halts the run with a message naming `branchPrefix`; re-run with the original prefix. |
| No `project` arg at all | Legal: the run is boardless and only touches issues and PRs. |
