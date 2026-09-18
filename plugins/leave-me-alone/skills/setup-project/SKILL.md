---
name: setup-project
description: Use when preparing a repo so the global orchestrator/task workflows can drive it — "set up this repo for the orchestrator", "is my project ready for the orchestrator", "brd says ProjectNotFoundError", "register this repo with brd". Covers the brd/gh preconditions, agent-definition install, and a pre-flight verification checklist.
---

# Preparing a repo for the orchestrator/task workflows

`~/.claude/workflows/orchestrator.js` and `~/.claude/workflows/task.js` are repo-agnostic: they take
`repo`, `repoDir`, `milestone`, `baseBranch` and resolve every card and its status **from `brd`, by
walking the repo's directory tree at runtime**. Nothing is hardcoded — but `brd` has to already know
about this repo.

There is no board to create, no Status field to configure, no labels to create, and no sub-issue
relation to attach — `brd`'s hierarchy (milestone → story → subtask) IS the card tree, every card
already carries a `status`, and dependencies are `blocked_by` edges you set with `brd block`. This
skill is only about the three things `brd`/`gh` need before the workflows can run at all.

Creating the cards themselves (story + subtask shape, bodies, `blocked_by` edges) is
`setup-milestone` — cross-reference it, don't duplicate it. Do that one first, this one second (or
in either order — the preconditions here don't depend on cards existing yet).

## Preconditions

Exactly three. Each is a command to run and what to do if it comes back wrong.

**1. `brd` is on `PATH`.**

```bash
which brd
```

If this is empty, install it (see the `brd` repo) before doing anything else — every other check and
every trigger step in the workflows shells out to it directly.

**2. The repo is registered with `brd`.**

```bash
brd projects
```

Look for this repo's absolute path in the output. If it is missing:

```bash
brd init
```

See "`brd init` — the precondition everything depends on" below before assuming this is a formality.

**3. `gh` is authenticated, for pull requests only.**

```bash
gh auth status
```

The workflows still open PRs with `gh`, so it must be authenticated — but **no project-scoped grant
is needed any more**. If an old setup left `gh` authenticated with extra scopes for board access,
that's harmless but no longer required; a plain `gh auth login` covers everything the workflows use.

## `brd init` — the precondition everything depends on

**`brd init`** registers the current directory as a `brd` project. It is the one step this repo's
skills, hooks, scripts and workflows have never told anyone to run, and without it every board read
fails with `ProjectNotFoundError` — not a warning, a hard stop before any card is touched.

What it does: it drops a gitignored `.brd` marker file at the project root, and creates (or reuses) a
board in a central SQLite database under `~/.local/share/brd/` (or `$XDG_DATA_HOME/brd`), keyed by a
hash of the resolved, absolute project root path. `brd` resolves *which* board a command talks to by
walking up from the current working directory looking for that marker — there is no `--project` flag
to name one explicitly.

Two consequences worth knowing before they surprise you:

- **A fresh clone starts with no board.** The `.brd` marker is gitignored on purpose — a board is a
  local, per-machine thing, not something that travels with the repo. Cloning this repo elsewhere (or
  onto another machine) means running `brd init` again there; nothing about the board itself
  transfers automatically. (`brd tree > snapshot.json` / `brd import snapshot.json` moves cards
  between boards deliberately, if you need that.)
- **A git worktree resolves to the main checkout's board.** The marker is untracked, so a worktree
  (which shares the repo's history but not its untracked files) has no `.brd` of its own — the
  upward walk leaves the worktree directory entirely and finds the main checkout's marker instead.
  This is not a bug to work around: it is exactly what lets the orchestrator's parallel subtask
  worktrees all read and write the one shared board.

## Ordering and branch identity

**Ordering — chain every subtask with `brd block <this-subtask-id> --by <previous-subtask-id>`.**
Order decides the stack geometry: branch names are derived (`<branchPrefix>/task-<slug>-<shortid>`,
matched by short id alone) and each subtask's PR targets the previous subtask's branch, so the order
*is* the set of PR targets. That order comes from the `blocked_by` edges between sibling cards, not
from the title — chain a story's subtasks (subtask 2 blocked-by subtask 1, subtask 3 blocked-by
subtask 2, …) so the board states the order rather than encoding it in text. Ordinal-looking title
prefixes (`11.1 `, `1.2 `) are optional decoration now — nothing parses them.

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

**Dependencies between stories** work the same way, one level up: a story's `blocked_by` edges order
the dispatch levels, and they decide what branch each story's stack **roots on** — a blocked story
starts from its blocker's tip branch, not from `baseBranch`. Since nothing is merged during a run,
that rooting is the only way a story ever sees the code it depends on.

No `blocked_by` edges = one flat level = every story dispatched in parallel, each rooted at
`baseBranch` and blind to the others.

## The one-blocker rule

**At most one blocker per story** — a stack can only root on one parent, and a story with two
blockers cannot be given a single unambiguous root. Chain them (A ← B ← C) instead of giving C two
blockers.

`brd block` itself will happily let you add a second blocker; nothing here stops you from creating
that state. The rule is enforced at **dispatch**, not at card-creation time — so if you're building
the cards, `setup-milestone` is where a two-blocker story must actually be caught. This skill just
names the constraint so you know why the orchestrator halts if it's violated.

## Dry run

Before the first real dispatch, run a dry run that writes nothing:

```
Workflow({ name: "orchestrator" }, args: {
  repo: "OWNER/REPO", repoDir: "/abs/path", milestone: "<brd card id or title substring>",
  baseBranch: "main", nonce: "<current timestamp>", dryRun: true,
  taskScript: "/abs/path/to/leave-me-alone/workflows/task.js",
  detectScript: "/abs/path/to/leave-me-alone/scripts/detect.mjs"
})
```

No `project` argument — there is nothing left to resolve or pass.

It returns the discovered test/lint commands, the dependency levels, and the ordered subtask list per
story — each with a `prTargets` field naming the branch that subtask's PR will target. **Read that
column.** Each subtask should target the previous one's branch, and each story's first subtask should
target its blocker's tip (or `baseBranch` if it has none). A story rooted at `baseBranch` when it has
a blocker means the `blocked_by` edge is missing, and the story will be built against a base that has
never seen the code it depends on.

If the levels, the subtask order, or the targets look wrong, fix the board (`brd block`/`brd unblock`)
— not the workflow.

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

## Gotchas

| Trap | Reality |
|---|---|
| Expecting flat branch names | The default prefix is `m<milestone>`, so branches and worktrees nest per milestone. Pass `branchPrefix` explicitly for a flat scheme — it is used verbatim. |
| Adopting the milestone prefix on a milestone that already has merged PRs | Those PRs sit at the old addresses. The run finds them as near misses and HALTS rather than re-implementing them; finish that milestone under its original prefix. |
| Renaming a branch, or changing `branchPrefix`, mid-milestone | Branches are derived, never discovered. A merged PR under the old name halts the run with a message naming `branchPrefix`; re-run with the original prefix. |
| Running a `brd`/workflow command from a worktree and expecting an isolated board | It isn't isolated — the `.brd` marker is untracked, so the walk-up finds the main checkout's marker and every worktree shares that one board. This is intentional (see `brd init` above), not a bug. |
| Cloning this repo to a new machine and expecting the board to be there | It isn't — the board never left the machine it was created on. Run `brd init` in the new clone, and `brd import` a snapshot if you need the old cards. |
| A story with two `blocked_by` edges | The orchestrator can only root a stack on one parent. It stops the run rather than guessing which blocker to build from — chain them instead. |
| Expecting a card per PR | One PR per **subtask**. |
| Expecting `done` to mean merged | It doesn't. The run never merges, so a subtask's card reaching `done` reflects only that Ship opened its PR — that's the furthest state a run that never merges can honestly report. Its parent story's own status update is best-effort in the same way. |
