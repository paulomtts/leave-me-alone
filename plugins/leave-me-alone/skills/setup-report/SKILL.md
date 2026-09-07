---
name: setup-report
description: Use when the user asks to see or generate a progress diagram/dashboard/snapshot of in-flight work — "/setup-report", "show me where things stand", "visualize progress on the milestone", "update the progress board" — or asks to refresh an artifact a prior /setup-report call already made this session.
---

# setup-report

Renders the current state of in-flight work as a published Artifact, always in the ONE fixed
template defined by `reference.html`: header (eyebrow + title + dek), a 4-cell stat strip
(PRs opened / In progress / Queued behind deps / Escalations), a dependency-DAG diagram (levels
as columns, one pip per unit, edges from real dependency relations), a "Caveats" notes section,
and a single detail table. Every run produces this same shape — same section order, same stat
categories, same diagram grammar — regardless of what the underlying work looks like. Only the
content changes: counts, labels, node/lane count, table rows, prose.

**For an orchestrator run specifically, "Merged" is never the right first cell — the
orchestrator never merges anything, by design, so a "Merged" count is always 0 and tells the
reader nothing. Use "PRs opened" instead**: the count of subtasks with an open PR, regardless
of CI state. That number moves as the run progresses and is what a reader actually wants to
know. Only use "Merged"/"Done" literally when the source can genuinely reach that terminal
state (a ledger board, a task list) — see the state model below.

## 1. Find the work to visualize

Don't ask first — look. In priority order, the first source that has live data wins:

1. **An active orchestrator/milestone run** (GitHub Projects v2 board with story/subtask
   issues, per this session's `orchestrator`/`task`/`setup-milestone` skills) — pull real state with
   `gh`: issue/sub-issue status, PR state, CI check conclusions (`gh pr checks`), board Status
   field.
2. **A ledger board** (`.claude/ledger/BOARD.md`, if the repo has one — see the `ledger`
   skill) — each `###` card is a unit, its `##` header is its stage, `Blocked:` lines are
   blockers.
3. **The current session's own task list / plan** (`TaskList`, or the plan just discussed) —
   use when neither of the above applies, e.g. a single-branch feature with no board.

If two sources plausibly apply (e.g. mid-orchestrator-run *and* a ledger card exists for the
same milestone), or neither has anything live, ask the user which scope they mean rather than
guessing.

**Always re-derive current state, never reuse stale numbers from earlier in the conversation.**
A CI gate mentioned as blocking ten minutes ago may already be clear.

## 2. Map the source onto the fixed template

`reference.html` is not one option among several — it is the template every run produces.
Derive its *content* from whatever source step 1 found, but never its *shape*:

| Source | Level (DAG column) comes from | Node comes from | Pip comes from |
|---|---|---|---|
| Orchestrator/milestone run | Dependency depth in the story DAG (`blockedBy`) | A story | Its subtasks |
| Ledger board | The board's own stage order, treated as levels | The stage | Its cards |
| Session task list | A single level if there's no natural dependency grouping | The task list itself, or a natural sub-grouping | Individual tasks |

When the source has no real dependency edges (a ledger board, a flat task list), draw the DAG
with one level and no edges rather than switching to a different diagram type — the node/pip
grammar (`.nodebox`, `.nid`, `.nlabel`, `.pip`, `.pip.run`, `.pip.done`) and the rest of the
template stay identical either way. Node and level counts still come from the real data — a run
with 2 nodes is not stretched to look like a run with 7 — only the diagram *type* is fixed, not
its dimensions.

### Three states per unit, not two

Every pip and every table-row pill takes exactly one of three states — queued (hollow /
`.pill.queued`, grey), in progress (ringed / `.pill.run`, amber), done (filled /
`.pill.done`, green) — and a given unit's pip and pill must always show the same state: that's
the "renderings must agree" rule below applied per-unit, not just in aggregate. For an
orchestrator run, "done"
means **PR open with CI green and mergeable, not merged into main** — the orchestrator never
merges, so the table's "done" pill and the diagram's filled pip both mean "ready for human
review," never "landed."

**Determining "in progress" when there's no PR yet is the part that's easy to get wrong.**
`task.js` implements each subtask in a local worktree and only pushes a branch and opens a PR
once the subtask's own verification gate passes — so a subtask that's mid-implementation is
invisible to `gh pr list` and to `git ls-remote`. There is no direct signal for it. Infer it
instead from the story's own sequencing rule (subtasks within a story always run strictly one
at a time): for each story that is unblocked (its blocker, if any, already has every subtask
with an open PR) and not yet fully done, the **first subtask in that story's order without an
open PR is in progress**; every subtask after it in that story is queued, not in progress. A
story that is *not yet unblocked* has all of its subtasks queued — none of them are "in
progress," even the first one, because the story hasn't started at all. Get this wrong and
"in progress" either double-counts (marking every not-yet-PR'd subtask as active) or
undercounts (leaving genuinely active work bucketed as queued, which is the exact complaint
that prompted this section).

**Confirming the run hasn't stalled, when nothing observable has changed.** A quiet tick
(no new PR, same CI conclusions as last check) is not evidence of a stall — orchestrator runs
spend real time between observable PRs on implementation and the full verification gate. Check
`wc -l` and the mtime on the run's `journal.jsonl`
(`<transcript-dir>/subagents/workflows/<runId>/journal.jsonl`) against the previous check: a
growing line count with a recent mtime means it's actively working even with nothing new to
show; a flat count with a stale mtime across two checks is the actual signal something needs
attention (check the task's own status, look for an error in its last result).

## 3. Build the artifact

Follow `reference.html` exactly: its CSS tokens (cool blue-biased neutrals, an indigo accent
held *separate* from the semantic colors so it never collides with the done-green, all three
themes defined token-level — bare `:root`, `prefers-color-scheme` guarded by
`:not([data-theme="light"])`, and `[data-theme="dark"]`), its three type roles (system serif
for headings, system sans for prose, mono reserved strictly for identifiers), and every
structural section in the order it appears there:

- Header: one-line eyebrow (scope/repo/date) + title naming the work + one-sentence dek.
- The 4-cell stat strip, in this exact order: **PRs opened** (done) / **In progress** (active)
  / **Queued behind deps** (queued) / **Escalations** (blocked) — see "Three states per unit"
  above for exactly what "PRs opened" and "In progress" each count. Relabel only when the
  source's own terminology is clearer (e.g. a ledger board's own stage names, or "Merged"/"Done"
  when the source can genuinely reach that state), but keep four cells in this
  done → active → queued → blocked order.
- The dependency-DAG figure (SVG): levels as columns, `LEVEL N` headers, one `.nodebox` per
  node with one `.pip` per child unit in its correct state (`.pip` queued, `.pip.run` in
  progress, `.pip.done` done — never leave every non-queued pip as `.pip.run`, that's the
  two-state mistake this skill used to make), curved `.edge` paths for real dependency
  relations, and a `figcaption` explaining the structure in prose — same as step 2 produced it.
- `<h2>Caveats</h2>` notes: one card per *distinct* real blocker, each naming what's actually
  stopping progress and the concrete fix — never a placeholder like "needs review." When
  nothing is blocked, use the same cards for real caveats instead (a gap in the automated gate,
  a deliberate constraint), and say which it is — never manufacture a blocker to fill the
  section.
- A full detail table (`# / Lvl / Story / Subtask / Status` columns, or the closest equivalent
  for the source), one row per unit, grouped with the `.lead` top-border per group, pill status
  badges — so nothing in the stat strip is unauditable.
- Footer: snapshot timestamp, run/scope identifier, spec reference if one exists.

**Load the `artifact-design` skill before writing markup** (required by the Artifact tool) —
it governs light/dark tokens, responsive rules, and general page craft; this skill only
supplies the fixed structural template above.

### Rebuild from state, never patch the last render

On every refresh, build one state object first — a unit list (`id`, `lane`, `state`, label)
plus the lane/level structure — from the live source, and write the whole file from it. The
stat strip, the diagram, and the detail table are three *renderings of that one object*, so
they cannot disagree.

**Never update a published board by string-replacing its markup.** Patching mutates a
rendering while the state it depicts lives only in the previous render, so any element the
substitution misses silently keeps a stale value. This has produced false boards twice: a
regex written as `class="pip) (done|merging)("` matched only pips that already carried a
second class, leaving three merged subtasks drawn hollow — a reader saw them as skipped;
and a phrase replacement appended to text already containing that phrase, producing
"filled merged, filled merged, ringed red escalated". The counts were right both times,
because they came from `gh api`. The diagram was wrong, because it came from a regex over
prior markup — and the diagram is what a reader reads first.

Before publishing, verify the renderings agree: total units in the diagram == rows in the
table == sum of the stat strip. If they don't, the state object is right and a rendering is
stale — rebuild, don't patch the difference.

A third failure mode, milder than a broken regex but from the same root cause: an incomplete
state model. A run that produced hours of correct-looking updates before anyone noticed every
non-queued unit was rendered as "in progress" — because the template's `.pip.done`/`.pill.done`
had no rule wired up for units whose PR was already open and green, so there was nowhere for
"done" to render even though the underlying state (`gh pr checks`) was right the whole time.
Same lesson as above, one step earlier: verify the template actually has a distinct rendering
for every state the source can produce *before* the first publish of a long-running report, not
just that the renderings agree with each other on each refresh — three renderings that agree
with each other are still wrong if they're all agreeing on a state model that's missing a case.

## 4. Publish or update

- **First time this session for this scope:** publish new. Title = the work's name (not
  "Progress"). Pick one stable favicon emoji.
- **Same scope, called again this session:** redeploy over the same file — call `Artifact`
  again with the same `file_path`; no `url` needed, it updates in place automatically.
- **User asks to update an artifact from a past session** ("update my progress board",
  a pasted artifact link): find it with `Artifact({action: "list"})` (or the pasted URL) and
  pass its `url` — do not publish a duplicate.
