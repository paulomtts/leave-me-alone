# Migrating leave-me-alone from GitHub Projects to brd

**Date:** 2026-09-17
**Status:** Approved design, pending implementation plan

## Motivation

The orchestrator and task workflows currently read their structure from GitHub
Milestones, Issues, sub-issues and a Projects v2 board. That costs API round
trips, agent tokens, and a large amount of per-repo setup ceremony whose only
purpose is to make GitHub simulate a hierarchy.

`brd` — a local kanban CLI with cards, `parent_id`, `blocked_by` and `status` —
already models that hierarchy natively. Moving tracking onto it reduces GitHub
API friction and spend, and removes most of the setup surface.

## Scope

**In scope.** Everything that reads or writes *tracking* state: the milestone /
story / subtask breakdown, dependency edges, and status.

**Out of scope.** Pull requests stay on GitHub. The stacked-PR review flow is
the product of these workflows and does not change: one worktree and branch per
subtask, each PR targeting the previous subtask's branch, nothing ever merged by
a run.

## Data model

brd needs no new fields. The mapping is positional:

| GitHub concept | brd equivalent |
| --- | --- |
| Milestone | a root card (no `parent_id`) |
| Story (`story` label, on the board) | a child of the milestone card |
| Subtask (`subtask` label, native sub-issue) | a child of a story card |
| Story `blockedBy` | `blocked_by` edge between story cards |
| Subtask ordering (ordinal prefix in title) | `blocked_by` edge between sibling subtask cards |
| Projects v2 `Status` field, four named options | brd's built-in `status` |

Three of the five board conventions the orchestrator requires today dissolve
into brd primitives: the `story`/`subtask` labels become tree depth, sub-issue
linking becomes `--parent`, and the `Status` single-select becomes a field every
card already has.

### Status values

Three states only: `todo` → `in_progress` → `done`. These are brd's defaults, so
nothing needs configuring.

`done` means **the subtask's PR has been opened**. A run never merges anything
and cannot observe a merge, so "shipped" is the furthest state it can honestly
report. This retires the `in_review` state, which would have no occupant.

### `blocked` is ignored

brd derives `blocked` at read time from `blocked_by` (and, since brd #38, from
ancestors too), and refuses to let it be written. The workflows must:

- never write it — already impossible; and
- treat it as a synonym for `todo` on read. Any check asking "is this not yet
  started?" must accept both, or a blocked card falls through a naive
  `status === 'todo'` comparison into the wrong bucket.

Readiness is decided by the orchestrator's own DAG walk, not by brd's derived
field. The two compute the same thing from the same edges but can legitimately
disagree — brd treats a blocker as satisfied only when its stored status is
exactly `done`, while a story's completeness also involves its subtasks and PR
state. Keeping brd's projection decorative leaves the DAG as the single
authority.

For the same reason, **`brd next` must not be used for dispatch**, in either
form. Its readiness rule and ordering are brd's, not the stack's.

### Dependency conventions

Dependency is expressed exactly one way — `blocked_by` edges — at every level.
Two rules must be validated at creation time, neither enforced by brd. The
first survives from the current conventions; the second replaces the ordinal
convention it retires:

1. **At most one blocker per story.** A stack roots on exactly one parent.
   `setup-milestone` rejects a second edge at creation time rather than letting
   the orchestrator discover it at dispatch.
2. **A story's subtasks are always chained** (`--blocked-by <previous>`), even
   when the diffs could run in parallel, because each subtask's PR targets the
   previous one's branch. Independent stories are left unlinked so they dispatch
   in parallel.

The ordinal-prefix-in-title convention is **dropped**. Sibling order comes from
the dependency chain, with creation time as the tiebreaker for genuinely
independent siblings. Ordinal prefixes may remain in titles as human-readable
decoration, but nothing parses them.

## Storage and the durable record

As of brd #35, a project's database lives at `.brd/board.db` inside the repo and
is committed to git; the generated `.brd/.gitignore` excludes only
`board.db-journal`. Board state therefore travels with the repo, satisfying the
portability requirement natively. No JSON snapshot mechanism is needed.

This creates one hazard specific to these workflows. `find_project_db` walks up
from the current directory looking for `.brd/board.db`. Because that file is now
a tracked working-tree file, **every git worktree has its own copy**, checked out
at whatever commit it branched from. Two rules follow:

1. **Every brd mutation targets the main checkout**, addressed by absolute path,
   never inheriting a worktree's working directory. The board is a single live
   store; worktree copies are stale artifacts.
2. **`.brd/board.db` never enters a feature-branch commit.** Board state is
   committed deliberately on the main branch, decoupled from the PR stack.
   Otherwise each branch carries a divergent binary SQLite file — a conflict git
   cannot resolve, in the middle of a stacked chain.

Rule 1 needs an active guard, not error handling: mutating from inside a
worktree raises nothing, because `.brd/board.db` genuinely exists there. It
succeeds against the wrong database. Before mutating, compare
`git rev-parse --git-dir` with `--git-common-dir` and refuse when they differ.

Rule 2 is a hazard rather than a convention, because inside a worktree
`.brd/board.db` is a legitimately modified tracked file that any broad
`git add` would sweep in silently.

## Component changes

### Deleted

`scripts/resolve.mjs` (81 lines) and its test. Its entire purpose is translating
a project number into GitHub's opaque GraphQL node ids. brd uses one id type — a
UUID string — in every command, so there is nothing to resolve.

`parseOrdinal` / `orderSubtasks` (`workflows/orchestrator.js:33-54`) and their
callers' sorting, per the dropped ordinal convention.

### Changed

**`scripts/detect.mjs` becomes a hybrid.** The census at lines 104-136 — one
milestone lookup, one story list, and two calls per story for `blockedBy` and
sub-issues — collapses into a single `brd tree <milestone-id>`, which returns
the same nested `id/title/status/blocked_by/children` shape in one local call.
The PR-state lookup at lines 137-150 **stays on `gh`**: which PRs exist and which
merged is still a GitHub question. `prepareCheckout` (lines 71-82, `git fetch`
plus `worktree prune`) is pure git and does not move.

**`workflows/task.js` loses its embedded mutations.** Lines 381-382 build
`findCard` and `setStatus` as GraphQL mutation strings interpolated into a
natural-language prompt, and lines 395-435 instruct an agent to query sibling
sub-issue statuses and roll the parent story up by progress. All of it becomes
`brd update <id> --status <s>` plus a rollup helper reading `brd show <parent>`.

The rollup rule is by *progress*, not by the least-advanced child, and is
unchanged from the behaviour it replaces: if every child is `todo`, the parent
is `todo`; if every child is `done`, the parent is `done`; any other mix is
`in_progress`. Children resolving to `blocked` count as `todo`, per the rule
above. It applies at both levels — a story rolls up from its subtasks, and the
milestone card rolls up from its stories — so updating a subtask walks upward
until the root is reached.

This is the highest-value change in the migration, and not for cost reasons.
The header comment on `detect.mjs:1-13` documents why those steps were pulled
out of an agent: handing a model a shell "rented a shell with opinions, and it
acted on them: substituting `gh pr list` for the endpoint it was given,
reporting an API failure as an empty list." The `task.js` status block is the
last place still doing that. brd's ids make the commands short enough to live in
plain code, closing the failure class rather than making it cheaper.

**`scripts/ship.mjs`.** `titleFromIssue` (line 63) currently strips an ordinal
prefix from a title fetched via `gh issue view` (lines 123-125); the title now
comes from the brd card. `Closes #<issue>` in `buildBody` (line 72) has nothing
to close and is replaced by a `brd card: <id>` traceability line. After the PR is
created, ship sets the card to `done`.

**Milestone addressing.** `--milestone 12` was ergonomic; a UUID is not. The
orchestrator matches a root-level card by title substring, failing loudly on
ambiguity, and also accepts a raw card id.

### Unchanged

`scripts/worktree.mjs`; the branch and PR-base derivation (`computeLevels`,
`storyTip`, `storyRoot`, `stackBases`); `gh.mjs`'s retry machinery; and
`gh pr create` itself. The DAG logic already operates on a generic
`{title, blockedBy, subtasks}` shape produced by `detect()` and never touches
the GitHub API, so swapping the data source only requires re-keying
`storiesByNumber` (a `Map` on issue numbers) to `storiesById` on UUID strings.

### Skills

**`setup-project`** shrinks from 362 lines of GitHub precondition policing — the
board exists, `Status` has four exactly-named options, `story`/`subtask` labels
exist, sub-issues are enabled — to three checks: `brd` is on `PATH`, the repo is
registered (`brd init` if not), and, because PRs stay, a GitHub remote with `gh`
authenticated.

**`setup-milestone`** creates cards with `brd add --title … --parent …
--blocked-by …` instead of `gh issue create` plus labelling plus a sub-issue
attach that required the child's *database* id specifically. It enforces the two
surviving conventions above.

**`setup-report`** renders from the committed board rather than live GitHub
queries.

## Error handling

Board reads become local and deterministic, so **retries do not apply to them** —
retrying a `CycleError` is meaningless. `withRetries` survives only for what
stays on GitHub: the PR listing and `gh pr create`.

brd's contract, verified: exit `1` on failure and `0` on success, with a
structured body, e.g.
`{"ok": false, "error": {"type": "CycleError", "message": "…"}}`.

**Every brd call asserts `ok === true` and throws otherwise. No call degrades to
`[]`.** This is the hazard `detect.mjs:110-113` warns about — a failed query
becoming an empty list is how "a milestone ends up flat, with every story
dispatched at once against a base none has built on." brd makes it easy to get
right because the discriminator is explicit in the payload instead of inferred
from an empty array.

Failure modes to handle: `ProjectNotFoundError` (unregistered directory),
`CardNotFoundError` (stale id), `InvalidStatusError` (avoided by never writing
`blocked`), `CycleError` (reachable from `setup-milestone`).

Escalation policy is unchanged: the orchestrator full-stops.

## Testing

Two layers.

**Unit tests keep the injectable-runner pattern** (`detect.test.mjs:8-22`), with
a `brdRunner` mirroring `ghRunner`. Fixtures get substantially simpler: one
nested `brd tree` payload replaces five hand-written route shapes.

**Integration tests against the real CLI are newly possible.** brd is local,
fast, and isolatable with `XDG_DATA_HOME` plus a temp directory, so a full board
can be built and torn down in well under a second. Against GitHub this needed
network, auth and a disposable repo.

This matters beyond hygiene. Hand-written route fixtures encode a *belief* about
what GitHub returns, and a wrong belief passes tests while failing in
production. A temp brd board has no such gap: the DAG and level computation can
be checked against the real dependency resolver, including the ancestor
inheritance added in brd #38.

Coverage the migration specifically needs:

- `storiesById` keyed by UUID strings where it was numeric. `task.js:419`
  documents a bug where `-F` coerced numeric-looking strings to int and the
  mutation was rejected; UUIDs retire that class.
- The parent-status rollup helper.
- The `ok:false` → throw path, per command.
- The worktree guard refusing to mutate.

`resolve.test.mjs` is deleted with `resolve.mjs`.

## Upstream dependency

This design depends on brd #38 (merged), which added ancestor-blocking
inheritance to `resolve_status` and `brd next --parent <id>`. Both are verified
working in the installed binary.

Only the inheritance fix is load-bearing here, and indirectly: it makes the
board's own display agree with the orchestrator's view of readiness, so a human
reading `brd tree` is not told that work inside a blocked story is actionable.
`brd next --parent` was requested before this design settled on the
orchestrator's own DAG walk as the single authority; it is not used for
dispatch. It remains useful to humans and other consumers of the same board.
