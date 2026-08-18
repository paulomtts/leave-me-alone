---
name: setup-report
description: Use when the user asks to see or generate a progress diagram/dashboard/snapshot of in-flight work — "/setup-report", "show me where things stand", "visualize progress on the milestone", "update the progress board" — or asks to refresh an artifact a prior /setup-report call already made this session.
---

# setup-report

Renders the current state of in-flight work as a published Artifact: a stat strip, a
diagram, blocker or caveat call-outs, and a detail table. The *shape* of the diagram is
never fixed — it comes from whatever structure the work actually has. Forcing every run into
one fixed template (fixed stage names, fixed lane count) is the failure mode this skill exists
to avoid.

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

## 2. Let the data pick the diagram's shape

Do not reuse a fixed set of stage names or lane count across runs. Derive both from what this
source actually models:

| Source | Stages come from | Lanes come from |
|---|---|---|
| Orchestrator/milestone run | The real pipeline this repo uses to land work (e.g. implement → push → PR → CI → merge — confirm against actual `gh` state, don't assume) | Stories (each subtask a marker within its story's lane) |
| Ledger board | The board's own stage headers, in order, verbatim | Cards (seams) |
| Session task list | Whatever statuses the tasks actually use | Tasks, or a single lane if there's no natural grouping |

A run with 2 lanes and 3 stages is not a smaller version of a run with 6 lanes and 5 stages —
build the SVG to the real dimensions each time.

## 3. Build the artifact

**`reference.html` is the default visual system.** Follow it unless the user asks for something
else: cool blue-biased neutrals; an indigo accent held *separate* from the semantic colors so
it never collides with the done-green; three type roles — a system serif for headings, system
sans for prose, and mono reserved strictly for identifiers (issue numbers, branch names,
commands); a four-cell stat strip; note cards with a bold lead-in line; and a detail table with
a `tabular-nums` leading column, grouped by unit with a `.lead` top-border, and pill status
badges. All three themes are defined token-level (bare `:root`, `prefers-color-scheme` guarded
by `:not([data-theme="light"])`, and `[data-theme="dark"]`); keep that structure.

**Its diagram shape is NOT the default.** `reference.html` draws a dependency DAG — levels as
columns, each node carrying one pip per child unit, curved edges from real `blockedBy`
relations — because that run's structure was a graph at rest, with nothing yet in motion.
`reference-pipeline.html` is a second finished example in the same visual system drawing a
different shape: per-lane stage progression, `marker-end` arrows, dashed edges for
waiting/blocked, and a vertical dashed line for a gate shared across lanes — because that run's
structure was work moving through stages. Read whichever is closer to what step 2 produced, and
build a third shape when neither fits. Never copy either file's field names, issue numbers,
stage labels, or level count.

Sections to include, adapted to what step 2 produced:
- Header: one-line eyebrow (scope/repo/date) + title naming the work + one-sentence dek.
- Stat strip: counts by terminal state (done / gated-or-blocked / queued — label per the
  data's real states, not these exact words).
- The diagram (SVG), sized to the real shape step 2 produced.
- Note cards: one per *distinct* real blocker, each naming what's actually stopping progress
  and the concrete fix — never a placeholder like "needs review." When nothing is blocked, use
  the same cards for real caveats instead (a gap in the automated gate, a deliberate
  constraint), and say which it is — never manufacture a blocker to fill the section.
- A full detail table, one row per unit, so nothing in the stat strip is unauditable.

**Load the `artifact-design` skill before writing markup** (required by the Artifact tool) —
it governs light/dark tokens, responsive rules, and general page craft; this skill only
supplies the domain-specific diagram pattern.

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
