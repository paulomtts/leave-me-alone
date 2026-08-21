---
name: setup-report
description: Use when the user asks to see or generate a progress diagram/dashboard/snapshot of in-flight work — "/setup-report", "show me where things stand", "visualize progress on the milestone", "update the progress board" — or asks to refresh an artifact a prior /setup-report call already made this session.
---

# setup-report

Renders the current state of in-flight work as a published Artifact, always in the ONE fixed
template defined by `reference.html`: header (eyebrow + title + dek), a 4-cell stat strip
(Merged / Dispatching now / Queued behind deps / Escalations), a dependency-DAG diagram (levels
as columns, one pip per unit, edges from real dependency relations), a "Caveats" notes section,
and a single detail table. Every run produces this same shape — same section order, same stat
categories, same diagram grammar — regardless of what the underlying work looks like. Only the
content changes: counts, labels, node/lane count, table rows, prose.

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
grammar (`.nodebox`, `.nid`, `.nlabel`, `.pip`, `.pip.run`) and the rest of the template stay
identical either way. Node and level counts still come from the real data — a run with 2 nodes
is not stretched to look like a run with 7 — only the diagram *type* is fixed, not its
dimensions.

## 3. Build the artifact

Follow `reference.html` exactly: its CSS tokens (cool blue-biased neutrals, an indigo accent
held *separate* from the semantic colors so it never collides with the done-green, all three
themes defined token-level — bare `:root`, `prefers-color-scheme` guarded by
`:not([data-theme="light"])`, and `[data-theme="dark"]`), its three type roles (system serif
for headings, system sans for prose, mono reserved strictly for identifiers), and every
structural section in the order it appears there:

- Header: one-line eyebrow (scope/repo/date) + title naming the work + one-sentence dek.
- The 4-cell stat strip, in this exact order: **Merged** (done) / **Dispatching now** (active)
  / **Queued behind deps** (queued) / **Escalations** (blocked). Relabel only when the source's
  own terminology is clearer (e.g. a ledger board's own stage names), but keep four cells in
  this done → active → queued → blocked order.
- The dependency-DAG figure (SVG): levels as columns, `LEVEL N` headers, one `.nodebox` per
  node with its id/label and one `.pip` per child unit (`.pip.run` for the one in progress),
  curved `.edge` paths for real dependency relations, and a `figcaption` explaining the
  structure in prose — same as step 2 produced it.
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

## 4. Publish or update

- **First time this session for this scope:** publish new. Title = the work's name (not
  "Progress"). Pick one stable favicon emoji.
- **Same scope, called again this session:** redeploy over the same file — call `Artifact`
  again with the same `file_path`; no `url` needed, it updates in place automatically.
- **User asks to update an artifact from a past session** ("update my progress board",
  a pasted artifact link): find it with `Artifact({action: "list"})` (or the pasted URL) and
  pass its `url` — do not publish a duplicate.
