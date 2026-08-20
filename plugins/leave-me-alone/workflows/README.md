# Workflows

Two Workflow scripts and the deterministic helpers they drive.

- **orchestrator** — one GitHub milestone, end to end, as a stack of pull requests. Computes the
  story dependency DAG, dispatches each level's stories in parallel, runs each story's subtasks
  sequentially, and full-stops on the first escalation. **Never merges anything.**
- **task** — one subtask issue, end to end, in its own worktree and branch: explore, spec, review the
  spec, plan, review the plan, implement under strict TDD, review the diff, verify, open a PR.
  **Stops at the PR.**

The one idea underneath both: **agents decide as little as possible.** Ordering, branch names, PR
targets, doneness and every gate live in plain JavaScript with tests. Agents exist because a Workflow
script cannot execute a command — the ones that only need to run something use a `Bash`-only agent
type and a one-line prompt.

## Preconditions

Install the `leave-me-alone` plugin, then **restart once**. Agent types are a native plugin
component and register themselves; Workflow scripts are not distributable by a plugin, so a
SessionStart hook copies `workflows/*.js` and the runtime helpers into `~/.claude/workflows/`.

The plugin is the source of truth and the hook OVERWRITES — edit the plugin, not the copy.

`bun` and `gh` on PATH. A GitHub Projects v2 board — there is no boardless mode. Board setup and the
milestone conventions are the `setup-project` and `setup-milestone` skills.

## Helper scripts

Everything mechanical lives in `scripts/`, runs under `bun`, and is unit-tested without a network.
Each is also usable standalone for inspecting or debugging a run.

| script | what it answers |
|---|---|
| `detect.mjs` | the whole milestone census: stories, `blockedBy`, sub-issues, PRs. Also does the ONE `git fetch` + `worktree prune` for the run |
| `resolve.mjs` | a project number → the node ids the mutation API needs |
| `worktree.mjs` | create a subtask's worktree idempotently; report what was already there. Never resets, deletes or commits |
| `plan-check.mjs` | is there a saved, validated plan for this issue? |
| `ship.mjs` | verify → push → open the PR. Nothing is pushed after a red command |
| `check-workflows.mjs` | do the workflow scripts still parse? |

## orchestrator

```jsonc
Workflow({ scriptPath: "<repo>/workflows/orchestrator.js" }, args: {
  repo: "owner/name", repoDir: "/abs/path", milestone: 12, baseBranch: "main",
  nonce: "<current timestamp>",
  taskScript:    "<repo>/workflows/task.js",       // required, absolute
  detectScript:  "<repo>/scripts/detect.mjs",      // required, absolute
  projectScript: "<repo>/scripts/resolve.mjs",     // required when project is a number
  project: { number: 13 },                          // or the resolved {id, fieldId, optionIds}
  verification: { fullSuite: ["npm test"], typecheck: "", lint: [] },
  dryRun: true,
})
```

| arg | required | notes |
|---|---|---|
| `repo`, `repoDir`, `milestone`, `baseBranch` | yes | no defaults; `baseBranch` is never guessed |
| `nonce` | yes | busts the Detect cache so a re-run re-reads GitHub |
| `taskScript`, `detectScript` | yes | absolute paths; this repo can be checked out anywhere |
| `projectScript` | when `project.number` | omit only if you pass resolved ids |
| `project` | yes | `{number}` or `{id, fieldId, optionIds}`. No boardless mode |
| `verification` | no | supply it and Detect becomes a pure trigger |
| `branchPrefix` | no | defaults to `m<milestone>/task-`. **Constant for a milestone's life** |
| `maxConcurrentStories` | no | default 4 |
| `triggerAgentType` | no | default `command-runner`; `""` for the default subagent |
| `dryRun` | no | returns the plan and writes nothing |

### Phases

| phase | agents | what |
|---|---|---|
| Configure | 0–1 | `resolve.mjs` → board ids. 0 if you pass them |
| Detect | 1 | `detect.mjs` → the census, plus the run's single fetch/prune |
| — | 0 | cycles, levels, branch names, PR bases, PR matching, verification filtering |
| Dispatch | 0 | `workflow(task.js)` per subtask — the agents are all inside `task.js` |

Configure and Detect run **concurrently**; they share no data. A board failure disables nothing —
it stops the run, because a milestone whose cards silently never move looks exactly like one that
never ran.

### dryRun

Returns the resolved board ids, the discovered verification commands, the dependency levels, and per
subtask its `branch` and **`prTargets`**. Read that column: each subtask should target the previous
one's branch, and a story's first subtask should target its blocker's tip. A blocked story rooted at
`baseBranch` means a missing `blockedBy` edge.

## task

Invoked per subtask by the orchestrator, which forwards `scriptsDir`, the resolved `project`,
`verification`, `triggerAgentType` and the subtask's own `baseBranch` — its **stack parent**, not the
milestone base.

| arg | required | notes |
|---|---|---|
| `repo`, `repoDir`, `issue`, `baseBranch` | yes | `baseBranch` is this subtask's stack parent |
| `scriptsDir` | yes | absolute path to `scripts/` |
| `project` | yes | resolved ids only; `task` never resolves them itself |
| `verification` | no | otherwise Explore discovers it |
| `plansDir`, `specsDir` | no | default under the **worktree**, so the PR carries them |
| `branchPrefix`, `coauthor`, `triggerAgentType` | no | |
| `allowNoVerification` | no | opt in to running with no test suite. Refused otherwise |

### Phases

| # | phase | agent type | skill | what |
|---|---|---|---|---|
| 1 | Explore | `repo-reader` | — | issue, parent story, repo docs, the code it touches. Never writes |
| 2 | Worktree | `command-runner` | — | `worktree.mjs`. Must precede anything that writes |
| 3 | plan-check | `command-runner` | — | `plan-check.mjs`. A validated plan skips 4–7 |
| 4 | Spec | `spec-author` | — | writes `docs/superpowers/specs/issue-N-design.md`. No shell |
| 5 | ValidateSpec | `plan-critic` | — | corrects the spec **in place**, before anything is planned on it |
| 6 | Plan | `plan-author` | `writing-plans` | writes `docs/superpowers/plans/issue-N.md` from the spec **on disk** |
| 7 | ValidatePlan | `plan-critic` | — | corrects the plan; adds `<!-- task-pipeline: validated -->` |
| 8 | Implement | `code-worker` | TDD | commits spec+plan first, then strict TDD with `Plan-Hash` trailers |
| 9 | Review | `code-worker` | TDD, debugging | reviews the diff, fixes, reports three raw numbers |
| 10 | Ship | `command-runner` | — | `ship.mjs` → verify, push, PR |

Spec and plan are written **inside the worktree**, so each PR carries the spec and plan it was built
from, and a worktree deleted between runs is recreated from the branch with the plan still on it.

### Gates

Decisions live in the script, off values the agents merely report:

- **no full-suite command** → refuses to start; every later check would be vacuous
- **dirty worktree after Review** → stops; the PR would not contain the work
- **zero commits** → stops
- **untagged commits** (`Plan-Hash` missing) → stops, and says *do not re-run* — a later run would
  read the branch as stale and hard-reset it
- **plan written without `writing-plans`** → stops; a plan in another format is a different artifact
- **unresolved blockers from Review** → stops

`blocked: 'tests'` is load-bearing: the orchestrator maps that exact string to escalation trigger
`tests`, everything else to `blocked`.

### Returns

`{ issue, pr, branch, worktree, plan, tests }` on success, or
`{ issue, refused|blocked, reason|detail, … }` when a gate stopped it. `blocked` is one of
`verification`, `validation`, `implement`, `review`, `tests`, `pr`.

## Why per-subtask, not per-story

One subtask = one branch = one worktree = one PR. A story is a grouping that supplies *ordering*: its
subtasks run sequentially, each branch cut from the previous one's, producing a stack a human merges
bottom-up. Stories in the same dependency level run in parallel, in separate worktrees.

Nothing is merged during a run. "Done" means "has a PR against the right base" — a PR against the
wrong base counts as **not** done, deliberately.

## Notes

- **Branch names are derived, never discovered:** `branchPrefix + issue number`. A merged PR found
  under a different name halts the run rather than being re-implemented.
- **Subtask order is the PR targets.** Reordering after PRs exist re-points the bases and those PRs
  read as wrong-base. Give every subtask an ordinal prefix.
- **Only one blocker per story.** A stack roots on one parent; two stops the run.
- **The shared checkout is touched once**, by `detect.mjs`, before dispatch. `task.js` is forbidden
  from running `fetch` or `worktree prune` against it — several subtasks share that `.git`, and a
  prune deletes other lanes' worktrees.
- **Worktrees are left behind** on purpose, so a blocked subtask can be inspected. Cleanup is yours.
