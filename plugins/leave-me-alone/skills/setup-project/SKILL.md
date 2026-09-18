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

Note the **project number** (the small integer in the URL, e.g. `/users/OWNER/projects/12`) — you'll
need it below to resolve the node id and field/option ids yourself. There is no resolver in the
workflow any more: `project` must be passed as a resolved `{id, fieldId, optionIds}` block (see
"Making both agents deterministic"). A bare `project.number` fails at launch.

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

**A — keep your own names** (safest, zero mutation): note which field and option names the board
already uses (they need not match the defaults), confirm a distinct "in review" column exists (add
one if not), then resolve THOSE names into the `{id, fieldId, optionIds}` block below — there is no
resolver in the workflow to hand names to; the ids must already be resolved before you pass `project`.

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

**Ordering — chain every subtask with `--blocked-by <previous subtask id>`.** Order decides the stack
geometry: branch names are derived (`<branchPrefix>/task-<slug>-<shortid>`, matched by short id alone)
and each subtask's PR targets the previous subtask's branch, so the order *is* the set of PR targets.
That order comes from the `blocked_by` edges between sibling cards, not from the title — chain a
story's subtasks (subtask 2 `--blocked-by` subtask 1, subtask 3 `--blocked-by` subtask 2, …) so the
board states the order rather than encoding it in text. Ordinal-looking title prefixes (`11.1 `,
`1.2 `) are optional decoration now — nothing parses them.

Without a chain, independent siblings keep creation order, which detaching and re-attaching a child
can change. That silently re-shapes the stack between runs, and PRs opened against the old shape then
read as `wrong-base`. It works, but only for a milestone nobody ever touches.

**`branchPrefix` is part of the milestone's identity.** It defaults to `m<milestone>`, so a subtask
card builds on `m12/task-<slug>-<shortid>` in worktree `.claude/worktrees/m12/task-<slug>-<shortid>`.
That grouping is for legibility and cleanup — `git branch --list "m12/*"`, `rm -rf
.claude/worktrees/m12` — not for avoiding collisions, since each card's short id is already unique
per board. Branch names are derived from the prefix, so changing it mid-milestone points the run at
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
  taskScript: "/abs/path/to/leave-me-alone/workflows/task.js",
  detectScript: "/abs/path/to/leave-me-alone/scripts/detect.mjs",
  project: { id: "PVT_…", fieldId: "PVTSSF_…",
             optionIds: { backlog: "…", inProgress: "…", inReview: "…", done: "…" } }
})
```

There is no resolver — `project` must already be this resolved `{id, fieldId, optionIds}` block (see
"Making both agents deterministic" below for how to get it); a bare `project: { number: PROJ }` fails
at launch, before anything is dispatched.

It returns the board ids you supplied (unchanged), the discovered test/lint commands, the dependency
levels, and the ordered subtask list per story — each with a `prTargets` field naming the branch that
subtask's PR will target. **Read that column.** Each subtask should target the previous one's branch,
and each story's first subtask should target its blocker's tip (or `baseBranch` if it has none). A
story rooted at `baseBranch` when it has a blocker means the edge is missing, and the story will be
built against a base that has never seen the code it depends on.

If the levels, the subtask order, or the targets look wrong, fix the board — not the workflow.

## Making both agents deterministic

The orchestrator's two agents exist because a Workflow script cannot execute a command — not because
either decides anything. Both are **triggers**: each runs one command and hands back its stdout.

```jsonc
"taskScript":    "~/.claude/workflows/task.js",
"detectScript":  "~/.claude/workflows/scripts/detect.mjs",
"scriptsDir":    "~/.claude/workflows/scripts"
```

(Absolute paths — `~` is shown for brevity. Everything a run needs sits under one root, rather than
being split between `~/.claude` and a version-stamped plugin cache directory that moves on upgrade.)

`detectScript` is **required**, like `taskScript`, and for the same reason: this repo can be checked
out anywhere. A missing or relative path fails at launch, and there is no agent-census fallback — the
census is deterministic or it does not happen.

There is no resolver for GitHub project numbers any more, so `project` must be passed as a resolved
`{id, fieldId, optionIds}` block. A `project` given as a bare `number` fails at launch.

`bun` must be on PATH.

### Install the agent definitions — required

Every stage runs as a purpose-built agent type with only the tools it needs. They are
version-controlled in `agents/` and must be installed before the session starts:

Installing the `leave-me-alone` plugin is enough — the types register as `leave-me-alone:<name>`,
which is what the workflows ask for. Agent types are a native plugin component, so the
six below register themselves; the Workflow scripts are not, so a SessionStart hook copies them (and
their helper scripts) into `~/.claude/workflows/` on the first session after install.

**Restart once after installing** — the agent registry is read at session start, and a missing type
is a hard error rather than a silent fallback to the default subagent.

| type | tools | used by |
|---|---|---|
| `leave-me-alone:command-runner` | Bash | the trigger steps: detect, resolve, plan-check, ship |
| `leave-me-alone:repo-reader` | Bash, Read, Grep, Glob | Explore — never writes |
| `leave-me-alone:spec-author` | Read, Write, Grep, Glob | Spec — no shell |
| `leave-me-alone:plan-author` | Read, Write, Edit, Grep, Glob, Skill | Plan — invokes `superpowers:writing-plans` |
| `leave-me-alone:plan-critic` | Bash, Read, Edit, Grep, Glob | the two Validate passes — never creates files |
| `leave-me-alone:code-worker` | Bash, Read, Write, Edit, Grep, Glob, Skill | Implement, Review |

Only the three with `Skill` pay for the skill catalogue; the rest save the full 16KB. A missing
type is a hard error rather than a silent fallback to the fat default.

### The trigger agent

Both trigger agents run one command and read nothing else, but the DEFAULT subagent hands them
16,424 characters of context anyway: 5.8KB listing every deferred tool name, 10.7KB describing every
skill. (Project `CLAUDE.md` is *not* among it — that was measured separately.) So the orchestrator
uses a lean agent type instead, and it must be installed:

```bash
cp agents/command-runner.md ~/.claude/agents/     # then RESTART the session
```

Measured on the same dry run, before and after:

| | default subagent | `command-runner` |
|---|---|---|
| injected attachments | 16,424 chars | **0** |
| first-call context | ~16,500 tokens | **~5,100** |
| whole run (2 agents) | 35,097 tokens | **11,702** |
| payload fidelity | 993 bytes, exact | 993 bytes, exact |

The agent registry is read when a session **starts**, so installing it mid-session is not enough, and
a missing type is a hard error rather than a silent fallback to the expensive agent. Override with
`triggerAgentType`, or pass `""` to deliberately use the default subagent.

The census is also always taken **fresh**. There is deliberately no way to hand over one you took
earlier: a census is a snapshot of what is merged, and a stale one re-dispatches work that has since
landed.

`verification` is the other half, and the only genuinely model-shaped step in the stage. Supply it
and Detect's prompt drops to the one trigger line:

```jsonc
"verification": { "fullSuite": ["bun test"], "typecheck": "", "lint": [] }
```

To inspect a board by hand — or to debug a run that came back wrong — the same script runs standalone:

```bash
bun ~/.claude/workflows/scripts/detect.mjs --repo OWNER/REPO --milestone "<card id or title substring>"
```

## The board ids are stable — resolve them once

There is no id lookup left to skip: `project` must always be passed as a resolved
`{id, fieldId, optionIds}` block (see the graphql calls in step 1 and step 2 above to get them). The
ids never change once resolved, so paste the same block into every run of this milestone rather than
re-deriving it:

```jsonc
"project": { "id": "PVT_…", "fieldId": "PVTSSF_…",
             "optionIds": { "backlog": "…", "inProgress": "…", "inReview": "…", "done": "…" } }
```

All four option ids must be present — a partial block is rejected rather than half-applied, because
disabling exactly one column's moves looks like it worked. Column names are matched **exactly** by
whatever resolved these ids — so a board renamed since you resolved them will move cards to whatever
those ids now point at: re-resolve after any column change.

## Gotchas

| Trap | Reality |
|---|---|
| Passing `project` as a bare `{number: PROJ}` | There is no resolver. The run STOPS at launch — resolve `{id, fieldId, optionIds}` yourself first. |
| Renaming Status options on a populated board | Option replacement wipes every item's Status. Re-set each card afterwards. |
| `In Progress` vs `In progress` | Matched exactly, wherever you resolve the ids — not by an agent. A mismatch means you resolved the wrong option. |
| Passing `project` without a complete `{id, fieldId, optionIds}` block | The run STOPS at launch. There is no boardless mode and no silent degradation. |
| Body checklists instead of sub-issues | `sub_issues` returns empty → `task` refuses the story as having nothing to sequence. |
| Adding cards to the board later | Cards missing at resolve time are reported, never auto-added. |
| Expecting a card per PR | One PR per **subtask**. Each subtask's card goes "In review" when its own PR opens. |
| Expecting cards to reach "Done" | The run never merges, so nothing closes. Cards stop at "In review" and issues stay open until a human merges the stack. "Done" is still required — the run checks all four option ids are present in `optionIds`. |
| Expecting flat branch names | The default prefix is `m<milestone>`, so branches and worktrees nest per milestone. Pass `branchPrefix` explicitly for a flat scheme — it is used verbatim. |
| Adopting the milestone prefix on a milestone that already has merged PRs | Those PRs sit at the old addresses. The run finds them as near misses and HALTS rather than re-implementing them; finish that milestone under its original prefix. |
| Renaming a branch, or changing `branchPrefix`, mid-milestone | Branches are derived, never discovered. A merged PR under the old name halts the run with a message naming `branchPrefix`; re-run with the original prefix. |
| No `project` arg at all | The run stops at launch. A milestone whose cards silently never move looks exactly like one that never ran — that cost weeks once. |
