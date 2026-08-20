# Global workflows

Workflow-tool scripts, distributed from this repo. To use them the way the Workflow tool resolves
scripts **by name** — `Workflow({ name: "<workflow>" }, args: <…>)`, available from **any** repo's
session, the same way `~/.claude/skills/` works for skills — copy or symlink this directory's
`orchestrator.js`/`task.js` into your own `~/.claude/workflows/`. Because this repo can be checked
out at any path, nothing here assumes that location: invoke directly from this checkout with
`{ scriptPath: "<this repo>/workflows/orchestrator.js" }` instead if you'd rather not copy/symlink
(both `Workflow` and `taskScript` below take `args` as JSON too).

- **orchestrator** — drive a whole GitHub milestone on any repo: resolve the board ids by name, compute the story dependency DAG, dispatch each level's stories in parallel — each story's own subtasks run **sequentially**, one worktree/branch/PR per subtask, merged before the next subtask starts — escalate conflicts to a capped Opus resolver.
- **task** — drive ONE subtask issue: intake → spec → plan → adversarial validation → strict-TDD implementation → review → full verification → PR, in its own fresh worktree/branch. **Stops at PR — never merges.**

Nothing repo-specific is compiled in. Repo, checkout path, milestone, base branch, board, labels,
subtask-ordering convention and even the test/lint commands are arguments or discovered at runtime.
Board setup for a new repo: the `github-project-setup` skill.

A repo-local `.claude/workflows/<name>.js` shadows the global file of the same name — keep local
`orchestrator.js`/`task.js` out of repos that should use these.

---

## orchestrator

### Invoke

```
Workflow({ name: "orchestrator" }, args: {
  repo: "paulomtts/refactor-nori",
  repoDir: "/home/paulomtts/Code/refactor-nori",
  milestone: 4,
  baseBranch: "main",
  nonce: "2026-08-10T18:00:00Z",
  project: { number: 12 },
  taskScript: "/home/paulomtts/Code/leave-me-alone/workflows/task.js",
  dryRun: true
})
```

### Args

| field | required | notes |
|---|---|---|
| `repo` | yes | `owner/name`. |
| `repoDir` | yes | absolute path to the checkout. Worktrees are created under `<repoDir>/.claude/worktrees/`. |
| `milestone` | yes | milestone **number**; the title is resolved from it. |
| `baseBranch` | yes | what every subtask PR targets. **Never defaulted** — nothing maps a milestone to a branch, and guessing would target the wrong integration branch. |
| `nonce` | yes | any fresh string (e.g. the current timestamp). `agent()` caches on prompt text across a resume, so without it a resumed run replays the *first* run's stale GitHub snapshot. |
| `project` | **yes**, unless `boardless` | `{ number, statusField?, options? }`. `statusField` defaults `"Status"`; `options` defaults `{backlog:"Backlog", inProgress:"In progress", inReview:"In review", done:"Done"}`. Required because forgetting it used to degrade silently: every card move — `task.js`'s In progress / In review as well as the merge stage's Done — was skipped without one failure, and merged subtasks sat in Backlog for weeks. |
| `boardless` | no | `true` to run issues-and-PRs-only **on purpose**, waiving the `project` requirement. |
| `taskScript` | **yes** | absolute path to this checkout's `workflows/task.js` (e.g. `<repo>/workflows/task.js`). Workflow scripts have no filesystem or self-location API, so a sibling script cannot be resolved relatively, and there is **no default** — this repo can be checked out at any path by anyone, so baking one in would hardcode a single machine/user. Missing or malformed fails at **launch**; a syntactically valid path that doesn't actually resolve to `task.js` fails at the **first subtask dispatch** instead, and the escalation names the path. |
| `labels` | no | `{ story: "story", subtask: "subtask" }`. |
| `branchPrefix` | no | default `"task-"` → branch `task-<subtask number>`. Detection of existing PRs is **prefix-agnostic**: a subtask's PR is matched by head-branch *suffix* (ref ends with the subtask number, preceded by a non-digit), so changing the prefix between runs never orphans already-merged work. Still: never randomise or timestamp it. |
| `ordinalPattern` | no | JS regex string, first capture group = the ordinal used to order a story's subtasks. Default matches `L2.3.1 …` / `1.2 …` prefixes; a plain descriptive title falls back to the `sub_issues` endpoint's natural (creation) order. |
| `coauthor` | no | commit trailer identity. Default `Claude <noreply@anthropic.com>`. |
| `maxResolveAttempts` | no | default `3`. |
| `autoMerge` | no | default `true`. Set `false` to stop right after each subtask's PR opens — merge, conflict/test resolution, issue-closing, and the board's "Done" move are all skipped; every merge then waits for an explicit human decision. Since subtask N+1 needs subtask N's code actually merged to build on, `autoMerge:false` means a story can only ever advance **one subtask per run** before stopping — that's correct behavior, not a bug. Recommended for a workflow's first real run against a milestone. |
| `dryRun` | no | see below. |

### Phases

1. **Configure** (haiku) — looks the project up **by name**: project number → `Status` field id → each option id. No literal `PVT_…`/`PVTSSF_…` id exists anywhere in these scripts. A missing field or option disables the board for the run and says so in the log, rather than failing the milestone.
2. **Detect** (haiku) — read-only GitHub snapshot: the milestone's story issues, each story's `blockedBy` numbers, each story's native `sub_issues` (order and titles verbatim), each **subtask's** PR found by head-branch suffix (the subtask number — prefix-agnostic, REST not GraphQL), and this repo's own verification commands (read from its `CLAUDE.md` / testing standards / CI workflows / manifest). It judges nothing — levels are computed in-script. A PR lookup that *fails* (API error) is reported as `"unknown"`, and any `"unknown"` aborts the run before dispatch — an unanswered API is not evidence either way.
3. **Dispatch** (per level) — `computeLevels` turns `blockedBy` into dependency levels; each level's **stories** run in parallel through `pipeline()`. Inside each story, its `remainingSubtasks` run **sequentially** — subtask N+1 only starts after subtask N has actually merged into `baseBranch`, so nothing ever branches off a stale base. No `blockedBy` edges anywhere = one flat level (every story dispatches in parallel). A subtask whose PR is already **merged** but whose issue is still open gets bookkeeping only (close + board), never a re-implementation; a subtask with an **open** PR skips straight to merge.
4. **Merge** (haiku, lock-serialized) — once per subtask, inside one in-script mutex, in a dedicated `orchestrator-merge` worktree (detached at `origin/<baseBranch>` — never `repoDir`, which concurrently-running subtask pipelines are actively using, and detached so it can't collide with a checkout of the base branch elsewhere): wait for CI → squash-merge → **independently verify** `state == MERGED` with a non-null `mergeCommit` (a zero exit code is not proof) → re-run the full suite on the updated base → verify/close the subtask the PR should have closed → move its card to Done → mirror the parent story's card (and close the story issue once every one of its subtasks is Done) → remove the subtask's now-merged local worktree and branch (debris left behind is what collides with future runs).
5. **Resolve** (opus, capped) — merge conflicts and post-merge test failures get up to `maxResolveAttempts` autonomous attempts in a scratch worktree, with explicit licence to synthesise a third design rather than pick a side, and an explicit ban on weakening tests. Exhaustion is a **full stop**: `halted` blocks all new dispatch and the escalation payload is *returned*, not thrown, so it reaches the session intact.

A subtask is done only when its issue is **closed AND its PR merged**. A closed issue with no merged
PR reads as remaining work; a merged PR with an open issue is finished code needing only bookkeeping.
A **CLOSED story** is done outright — its single state field can't be corrupted piecemeal by flaky
PR lookups (which once re-implemented merged work during a GitHub outage). PR-squash caveat: never
use `git merge-base --is-ancestor` to detect merged work here — squash merges make every branch read
unmerged; **PR state is the only reliable signal**.

An agent that dies without returning its structured output is retried **once** with an amended
prompt (it is a transient harness fault, not a real blocker); a second failure takes the normal
escalation path.

### dryRun

`dryRun: true` runs Configure + Detect only — both read-only — and returns the resolved board ids, the
discovered verification commands, the dependency levels, and each story's *remaining* subtasks with
the branch name and any already-existing PR each one would use. Nothing is dispatched and no GitHub
or board write happens. **Run this first against any new repo.**

### Returns

`{ repo, milestone, baseBranch, done: true, levels, completed }` on success, or
`{ …, escalated: true, level, story, subtask, pr, trigger, attempts, message, completed }` on a full stop.

---

## task

Drives one **subtask** issue, start to finish, in its own fresh worktree/branch. Usable standalone
(it discovers its parent story and board ids itself) or dispatched by the orchestrator (which passes
verification commands and resolved board ids down already, sequentially, one subtask at a time).

### Invoke

```
Workflow({ name: "task" }, args: {
  repo: "paulomtts/refactor-nori",
  repoDir: "/home/paulomtts/Code/refactor-nori",
  issue: 591,
  baseBranch: "main",
  project: { number: 12 }
})
```

### Args

`repo`, `repoDir`, `baseBranch` as above, plus:

| field | required | notes |
|---|---|---|
| `issue` | yes | the **subtask** issue number. A story (or an unlabelled issue) is refused. |
| `verification` | no | pre-discovered `{fullSuite[], typecheck, lint[]}`; otherwise discovered in Intake. |
| `project`, `branchPrefix`, `coauthor` | no | same as the orchestrator. `project` may be `{number}` or already-resolved ids. |
| `dryRun` | no | Intake only: returns the branch/worktree it *would* use and the discovered verification commands. No worktree, no writes. |

### Phases

**Resume** → **Intake** → **Board** → **Spec** → **Plan** → **Validate** → **Implement** → **Review** →
**Verify** → **PR** → **Board**. One worktree, one branch, one PR — all for this one subtask.

**Resume** is a read-only, Haiku-cheap PR lookup for this issue's branch, run before anything else
(mirrors the orchestrator's own `Detect`). Branch names are deterministic per issue, so any PR found
there is always this pipeline's own prior attempt: a merged PR short-circuits with `note: 'resumed:
PR already merged'`; an open PR short-circuits with `note: 'resumed: PR already open from a prior
run'`. Neither case re-runs Intake or anything after it.

**Spec/Plan/Validate** are also resumable: the plan file is saved under a deterministic name
(`issue-<N>.md`, no date), and Validate prepends `<!-- task-pipeline: validated -->` to it on
success. A rerun checks for that marker before doing anything else — if present, Spec/Plan/Validate
are skipped entirely and the existing plan is handed straight to Implement.

Baseline tests run once at the start of Implement; if the suite is already red before any change is
made (and the run isn't resuming known-green work), Implement stops and reports it rather than fixing
(or plowing ahead past) someone else's failure. Worktree/branch creation is idempotent: a leftover
branch with no open PR — an open PR is live work, and Implement stops rather than touching it — is
checked for a `Plan-Hash: <hash of the current plan file>` trailer on its commits — a match means
the existing commits genuinely implement the plan just handed to this run, so
Implement RESUMES from the next uncompleted step instead of discarding them; no match means the
branch is stale relative to the current plan and gets hard-reset to `origin/<baseBranch>`, as before.
Board card moves are best-effort — a failed move logs and never stops the pipeline. Two more
best-effort issue comments checkpoint progress: one right after Validate succeeds, one right after
Implement finishes — neither can fail the pipeline, they're purely so a killed run's last checkpoint
is visible without reading transcripts.

### Returns

`{ issue, pr, branch, worktree, plan, tests }`, `{ issue, pr, branch, worktree, note: 'resumed: ...' }`
on a Resume short-circuit, or `{ issue, refused|blocked, reason|detail, … }` when a stage stopped it.
The orchestrator treats anything without a `pr` as an escalation.

---

## Why per-subtask, not per-story

An earlier version of these scripts opened one worktree/branch/PR **per story** (every subtask as a
sequential commit on one shared branch, one PR at the end). That traded away real per-subtask
visibility — nothing merges into `baseBranch`, and no milestone progress is visible, until an entire
story's worth of subtasks are done. Reverted back to the pyjinhx originals' shape: one PR per
subtask, merged before the next subtask starts. Concretely, within one story, subtask N+1 never
branches until subtask N is actually sitting on `baseBranch` — so nothing ever stacks on an unmerged
branch, and the milestone shows real, incremental, merged progress after every subtask instead of
only after a whole story lands. The cost is running the full verification gate once per subtask
instead of once per story — more total suite runs, but each subtask gets the same full rigor on its
own, not a shared one.

## check-workflows

`scripts/check-workflows.mjs` is this repo's own guard on the workflow scripts: it catches a script
that no longer parses, or whose `meta` block the Workflow tool would reject, before anyone tries to
run it.

```
node scripts/check-workflows.mjs            # every workflows/*.js in this repo
node scripts/check-workflows.mjs a.js b.js  # only these paths
```

With no path arguments it checks every `*.js` file in this repo's `workflows/` directory, sorted by
name — resolved from the script's own location, so it does not matter what directory you invoke it
from. Each target is compiled with `vm.Script` (wrapped the way the Workflow harness wraps it), so a
syntax error is reported as the V8 parse error itself (`Unexpected token …`). Then the meta block is
checked: a top-level `export const meta` must exist; its object literal must be statically
resolvable — calls, spreads and other non-literal syntax are rejected as an impure `meta`;
`meta.name` and `meta.description` must each be a non-empty string; and if `meta.phases` is present
it must be an array whose every entry is an object with a non-empty string `title`, reported per
index (`meta.phases[0].title must be a non-empty string`). One file can collect several meta
violations in a single run.

By default each violation prints as `FAIL <path>: <message>` on **stderr**, followed by
`checked N workflow script(s); M failed` on **stdout**. Exit status is 0 when every file passes and
1 when any file fails, in every mode below.

- **`--json`** — prints one pretty-printed (2-space) JSON document to stdout *instead of* the human
  output: `{ "ok": <bool>, "results": [{ "path", "ok", "violations": [<string>, …] }, …] }`. `ok` is
  true only when every entry is. `results` follows **argv order**, not sorted order; `violations` is
  empty for a passing file and otherwise holds exactly the messages the `FAIL` lines would have
  carried. Both the `FAIL` lines and the summary line are suppressed — stdout is the document and
  nothing else, stderr is empty — and the exit code is unchanged, so a failing run still emits a
  complete document.
- **`--quiet`** — drops the per-file `FAIL` diagnostics (stderr is empty) but still prints the
  summary line to stdout. Useful for hooks and CI steps that only want the count and the exit code.
- **Precedence: `--json` wins.** Passing both is the same as passing `--json` alone, byte for byte
  on stdout and stderr, in either order — JSON mode is already strictly quieter (it drops the `FAIL`
  lines *and* the summary), and its document is the payload the caller asked for, so silencing it
  would leave nothing but an exit code.

Both flags are position-independent (before or after the paths), are never mistaken for target
paths, and repeat harmlessly. There are no other flags: any other `--`-prefixed argument is treated
as a target path and fails as an unreadable file.

## Notes

- **Verification commands are never assumed.** Both workflows read the target repo's own
  `CLAUDE.md` / testing standards doc / CI workflows / manifest and use what they find, including
  pinned tool versions and repos whose test tiers must run as separate invocations. The orchestrator
  discovers them once and passes them down; `task.js` then skips re-discovery.
- **`task.js` resumes from durable state, not from workflow memory.** A killed/interrupted run is
  recovered by re-checking GitHub (does this issue's branch already have a PR?) and the plan file
  (is it already marked validated?) and the branch's own commits (do they carry this plan's hash?) —
  the same "external state is the source of truth" pattern the orchestrator uses for subtask
  doneness, just applied at task.js's own stage granularity. This is why re-running `task.js` on an
  issue that already has a merged PR, an open PR, a validated plan, or partially-committed matching
  work is cheap and safe instead of redoing (or worse, discarding) that work.
- **Ordering needs no configuration.** Ordinal-prefixed titles (`L2.3.1 …`) are detected and sorted
  by the orchestrator before dispatching a story's subtasks; plain descriptive titles keep the
  `sub_issues` endpoint's natural (creation) order. The default pattern is deliberately anchored and
  dotted so a title like `Support 2.0 config` never accidentally matches.
- **Board writes are isolated.** Every card move is its own low-effort Haiku agent with a read-only
  find + a single `updateProjectV2ItemFieldValue` mutation, against ids resolved by name for that run.
- **`Workflow({name: "orchestrator"})` can replay a stale script after an edit** — the harness caches
  by name. Iterating on either file mid-session? Launch with the script's full text inlined (or
  `{scriptPath: <absolute path to the edited file>}`) instead of `{name: "..."}` until the session
  picks up the change on its own. This bites nested calls too: `orchestrator.js`'s own
  `workflow('task', ...)` call site uses `{scriptPath: taskScript}` (the caller-supplied
  `args.taskScript`, never a bare name) so editing `task.js` alone (without touching `orchestrator.js`)
  can't leave the orchestrator silently dispatching a stale `task.js` underneath a freshly-edited
  orchestrator. Since `taskScript` has no default (see Args above), this stays true regardless of
  where this repo is checked out — nothing here assumes a fixed path.
- **Isolation must be off for the driving session's repo.** Subagents inherit worktree isolation;
  an isolated orchestrator session cannot enter its own `task-*` worktrees and deadlocks. The target
  repo's `.claude/settings.json` needs `"worktree": { "bgIsolation": "none" }` (repo-scoped — a new
  target repo needs its own).
- Prerequisites for a repo: the `github-project-setup` skill (board) and
  `creating-stories-and-subtasks` / `milestone` (issues).
