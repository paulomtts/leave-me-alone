# Dropping GitHub from the DRIVE pipeline: local-only, orchestrator-merged

**Date:** 2026-09-22
**Status:** Approved design, pending implementation plan

## Motivation

The brd migration (`2026-09-17-brd-migration-design.md`) removed GitHub from
the *tracking* layer and deliberately kept pull requests: "Pull requests stay
on GitHub. The stacked-PR review flow is the product of these workflows and
does not change."

Two things since then change that calculus:

- A real end-to-end run (2026-09-19/22, a throwaway two-subtask milestone
  against this repo) confirmed the whole pipeline works, but also surfaced
  that a subtask's own progress is now entirely reconstructible from brd's
  tree — the thing that made `gh` load-bearing for tracking is gone, and what
  remains is `gh` used purely as a *delivery* mechanism (open a PR, check it
  exists) for work whose shape brd already knows end to end.
- brd's tree already gives a human everything the GitHub PR list gave them
  for deciding what's ready and in what order: dependency edges, status,
  hierarchy. The remaining reason DRIVE talks to GitHub during a run is to
  publish work somewhere a human can review it — not to know what to do next.

This spec removes GitHub from DRIVE runs entirely. Every subtask/story/
milestone lands as local git branches; a human, using brd's tree the same way
they'd have used the PR list, decides when and what to merge into `main`/
`master` themselves.

## Scope

**In scope.** Everything `ship.mjs`, `worktree.mjs`, and `detect.mjs` do with
`gh`: opening PRs, checking for a live PR before touching a branch, listing
PRs for the census. The orchestrator's new terminal phase that merges a
completed milestone into one local branch.

**Out of scope.**

- The permission hook (`auto-allow.sh`) — no changes. Its existing defer-on-
  main/master rule already covers the one new action (a merge into the real
  base) correctly; see "Landing on main/master" below.
- `setup-report`'s optional `gh pr checks` — unaffected; that reads CI status
  for whatever a human has already pushed by hand, which is orthogonal to
  DRIVE no longer pushing automatically. Its own skill doc may want a note
  that CI status now only exists once a human has pushed, but that is a doc
  fix, not a design change.
- brd itself, the skills (`setup-project`, `setup-milestone`), and the
  Explore/Spec/Plan/Validate/Implement/Review stages of `task.js` — none of
  these talk to GitHub today and none of them change here.
- Whether a human, after a milestone lands, chooses to push it and open PRs
  on GitHub anyway. That stays entirely their call and needs no plugin
  support beyond what already exists (`gh` is still on their machine).

## What "done" means now

Unchanged in spirit, narrower in mechanism: a subtask's card still reaches
`done` once it is verified and its work is committed to its branch. What
changes is what "verified and committed" is checked *against*.

Today, `isSubtaskDone` in `orchestrator.js` treats a subtask as done when it
has an open PR (`subtask.pr` truthy) — the PR object is fetched from GitHub
and is the actual signal. Once GitHub is out of the loop, the brd card's own
`status` field becomes the sole signal, exactly as brd's status already governs
`isStoryClosed`.

This is a genuine simplification, not just a substitution. `detect.mjs`
currently carries a `prLookupFailed` flag specifically to distinguish "GitHub
did not answer" from "there is genuinely no PR" — collapsing those two states
was flagged during the brd migration as the failure mode behind the
2026-08-17 outage (a transient API failure read as "nothing here," causing
merged work to be re-implemented). With no external service in the loop for
DRIVE runs, that whole category of bug has nothing left to happen to:
`prLookupFailed` and the `gh api .../pulls` call it protects both go away.

## Component changes

### `ship.mjs`

Drops `git push` and `gh pr create` (and the post-failure "does a PR already
exist" recovery check that existed only to guard a non-retried `gh pr
create`). Becomes: refuse a dirty worktree → run every `--verify` command,
same as today, stop with nothing changed if any fails → roll the card to
`done`. No `--repo` argument, no `gh` invocation of any kind.

The PR-body-from-commits logic (`buildBody`) is deleted with it — there is no
PR to carry that body, and the commit messages `Implement` already writes are
the only narrative that survives. This raises the bar on Implement's commit
message quality slightly (there's no PR description backstopping a terse
commit), but that's a property Implement already aims for under strict TDD;
nothing in this spec asks it to change.

### `worktree.mjs`

Drops the open-PR check in `prepare()` — there is no PR to check for, so
nothing else can be "driving" a branch via one. `branchExisted`/
`worktreeExisted` alone continue to govern whether a fresh worktree is
created or an existing one reused; that idempotency logic already works
independently of the PR check and needs no change.

### `detect.mjs`

Drops the `gh api .../pulls?state=all` call, `filterPullRequests`, and
`prLookupFailed` entirely, per "What 'done' means now" above. The census
becomes `brd tree` alone — one local call, same as today, minus the GitHub
round trip that used to follow it.

### `orchestrator.js` — new **Integrate** phase

A new terminal phase after Dispatch, eligible only when the entire milestone
completed with every story reporting `done` and nothing escalated. (A partial
run — some stories done, one escalated — does not run Integrate at all; see
"Partial runs" below.)

Story-level stacking already does most of the work for free: a story that
`blocked_by`s another already branches from that story's tip, so its tip
already contains its blocker's commits by git ancestry. Integrate's actual job
is combining the tips of *independent* (unblocked-by-each-other) stories,
which diverged from a common ancestor and were never going to merge into each
other just by being built:

1. Create one new local branch off the milestone's `baseBranch`.
2. Walk the same dependency levels `computeLevels` already produces. For each
   level, merge every story's tip that is not already an ancestor of the
   integration branch (a chained story's tip already is, via stacking, and
   merging it again would be a no-op `git merge` at worst — still safe to
   attempt uniformly rather than special-case it).
3. On a clean merge: continue.
4. On a conflict: dispatch an agent to resolve it (reading both stories' own
   diffs, not just the conflict markers — the same "read the real files, not
   a summary" discipline every other DRIVE stage already follows), then
   re-run the milestone's full verification command on the result. A
   *different* dispatch judges that verification, mirroring why Validate and
   Review are already separate dispatches from Implement — the agent that
   resolved the conflict does not get to grade its own resolution.
   - Verification passes: continue, Integrate proceeds.
   - Verification still fails: escalate. Leave every original story branch
     untouched — the attempted resolution lives only on the (abandoned)
     integration branch, which is not reported as ready. Nothing a human
     needs is lost or corrupted.
5. On success: stop. Report the integration branch, which stories/subtasks it
   contains, and that it is ready for a human to merge. **The orchestrator
   never runs `git merge` against `main`/`master`, or pushes anything,
   anywhere.** That boundary is unchanged from today's "never merges" — only
   the object it stops at moves from a PR to a local branch.

### Landing on `main`/`master`

Deliberately out of automation. `auto-allow.sh`'s existing rule already
defers any `git merge`/`push`/`rebase` naming `main`/`master` explicitly, and
that rule needs no change: a human runs `git merge <integration-branch>`
themselves, the same prompt they'd get for any other merge into the branch
everything else builds on. This was considered and rejected as a narrower,
more-tightly-gated auto-allow exception (see the brainstorming transcript for
2026-09-22) — rejected specifically to avoid adding any exception, however
narrow, to a rule that was hardened through five found holes during the brd
migration itself.

### `gh.mjs`

`readFlags`, `jsonFrom`, and `lastLine` are generic CLI-script plumbing other
scripts (`brd.mjs`, `plan-check.mjs`, `rollup.mjs`) already depend on and
keep needing regardless of this change. `ghRunner`, `ghError`, and
`withRetries` (built specifically for flaky network calls to GitHub) become
unused by every DRIVE script once the above lands. Whether they're deleted
outright or kept for `setup-report`'s `gh pr checks` is an implementation-plan
decision, not a design one — nothing in this spec depends on which.

## Partial runs

If Integrate is not eligible (the milestone did not complete cleanly), the
orchestrator halts exactly as it does today: an escalation report naming
what's left, with every story/subtask that DID reach `done` sitting on its
own local branch, un-merged. This was a deliberate choice, not a default:
verified work is not integrated piecemeal as it lands, so a milestone either
lands as one reviewable unit or doesn't land at all. The cost is that a
cleanly-finished story sits idle, un-integrated, until whatever blocked a
sibling story is resolved and the run completes — accepted because it keeps
"the orchestrator merges" meaning exactly one thing: the whole milestone,
verified, atomically, not a growing pile of partial integrations a human has
to reason about mid-run.

## Error handling

Unchanged for every stage before Integrate — Explore through Ship already
have their own stop-vs-continue rules and this spec touches none of them.
Integrate itself has exactly two terminal outcomes, both already covered
above: a ready branch, or an escalation with every original branch preserved
untouched. There is no partial-Integrate state to reason about — either the
whole walk over dependency levels completes, or the run stops at the first
unresolvable conflict and reports it.

## Testing

Same shape as the brd migration: `orchestrator.test.mjs`'s PURE-region tests
extend to cover Integrate's eligibility rule (whole milestone done, no
escalations) and the dependency-level merge-ordering logic. `ship.mjs`,
`worktree.mjs`, and `detect.mjs` themselves gain no new tests — they lose the
ones covering code they no longer have (the PR-body builder, the open-PR
check, `prLookupFailed`), and their remaining behavior is already covered by
what stays.

The new coverage belongs to the orchestrator's Integrate phase specifically:
an integration test that builds a real local git history with two
independent branches carrying a deliberate conflict on the same file, and
proves the resolve → re-verify → escalate-on-failure path leaves both
original branches byte-for-byte untouched, while the success path produces
an integration branch containing exactly the expected commits from both
stories.

## Upstream dependency

None. This spec depends only on brd's status field and tree, both already in
place since the previous migration. No brd changes are needed.
