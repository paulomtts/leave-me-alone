---
name: bedtime
description: Keep `am` (agent-manager) runs moving unattended while the developer sleeps. Watches the run event stream, and on every escalation diagnoses it, makes a judgement call to fix it, and resumes the run, never stopping to ask a question. Use when the user says "/bedtime", "I'm going to sleep", "I'm heading to bed", "keep the runs going overnight", or asks you to babysit/shepherd `am` runs while they are away.
---

# bedtime

The developer has gone to sleep and cannot answer until morning. Your job is to keep `am` runs moving, unblock escalations yourself, and leave a clear report for the morning.

## Ground rules

- **Never block on the developer.** Do not use `AskUserQuestion`, do not end a turn with a question, do not wait for approval. When unsure, pick the most conservative reasonable option, do it, and record the decision (and the alternative you rejected) in the report.
- **Stay inside the safe zone.** Work on local branches and worktrees only. Never push, never merge into main/master, never force-push, never delete branches or data, never touch anything outside the repo and the `am` runs. If a fix would require any of that, park the escalation instead (see "Parking").
- **Don't cheat the gates.** Never weaken, skip or delete tests, lint, or the `--verify` commands to make a run pass; never use `--allow-no-verification`. A fix must make the real gate pass.
- **Reversible beats clever.** Prefer small, targeted fixes that are easy to review and revert.

## 1. Orient

1. Find the runs to shepherd: those the user named, or else this repo's active ones (`am runs --pretty`, `am status <run-id> --pretty`).
2. Determine the repo's `--verify` gate commands (from the original `am run`, the run's recorded suite via `am status`, the repo's docs or CI config). `am resume` needs `--verify` every time.
3. Create the morning report file at `~/.claude/bedtime/<repo-name>-<YYYY-MM-DD>.md` and append to it as you go (see "Morning report").
4. Handle any run that is **already** escalated: `am events --escalations --project <repo> --pretty`.

## 2. Watch

Start the event stream as a background monitor, not a polling loop:

```
am watch --all --follow --from-now
```

Filter its JSON lines to events that need action: a run going `escalated`, `done` or `failed`, and a story `escalated` or `failed`. Ignore the rest, so each notification costs one short turn. Use `am runs` / `am status <run-id>` only for on-demand checks. If the stream dies, restart it with `--since-seq <last gseq seen>` so no event is lost.

## 3. On an escalation

1. **Diagnose.** Read why it escalated: `am status <run-id> --pretty`, `am events <run-id> --tail 30 --pretty`, `am logs <run-id> <card>` (add `--phase`/`--attempt` for the failing one). Find the root cause, not the symptom.
2. **Decide.** Typical causes and the usual call:
   - *Failing verification / test / type / lint error*: fix the code in the card's worktree/branch, run the gate locally to confirm.
   - *Environment or tooling* (missing dependency, port conflict, stale container, lock file): fix the environment; do not alter project config unless that is the actual bug.
   - *Merge or stacking conflict*: resolve it, preferring the card's intent and the already-merged work.
   - *Ambiguous or contradictory card/spec*: choose the interpretation most consistent with the rest of the milestone and existing code; note it in the report. Edit the card only if the run cannot proceed otherwise.
   - *Flaky failure*: re-run once to confirm flakiness, then resume; if it fails again treat it as real.
3. **Fix, then relaunch.** Commit the fix on the card's branch with a clear message, then continue the run:

   ```
   am resume <run-id> --verify "<gate commands>"
   ```

   Always pass `--verify` on every resume: a resume without it records an empty suite, and a later `--verify` does not repair it. If a run was already started without `--verify`, the fix is `am reset <run-id>` plus a fresh `am run --milestone ... --verify ...` (progress on branches is kept; check what the run will redo first).
4. **Verify the relaunch took.** Confirm the run left `escalated` (`am status`) and the stream shows progress before moving on.
5. **Log it** in the morning report: run, card, what broke, root cause, what you changed, what you decided and why.

## Parking

Don't loop forever. Park an escalation instead of fixing it when:
- the same card has escalated 3 times after your fixes,
- the fix needs a forbidden action (push, merge to main, destructive change, credentials/secrets, spending money),
- the cause is a genuine product decision that cannot be inferred safely.

To park: leave the run escalated (or `am pause`/`am cancel` if it is still burning cycles), write what you learned and the options for the developer in the report, and **continue with the other runs**. Parking one run must never stop the others.

## Finishing

Keep watching until every shepherded run is `done` or parked. Then stop the monitor and finish with the morning report.

## Morning report

Keep `~/.claude/bedtime/<repo-name>-<YYYY-MM-DD>.md` up to date as events happen, so it is accurate even if the session dies. Sections, in this order:

1. **Status**: one line per run: done / running / parked.
2. **Needs you**: parked escalations, each with the cause, what you tried, and the decision for the developer (recommended option first).
3. **Judgement calls**: every non-obvious decision and the alternative rejected, so the developer can overrule them.
4. **Fixes applied**: run, card, branch, commit, one-line summary.

End your final message with a short version of "Needs you" and the report path.

## Common mistakes

- Asking the developer anything. They are asleep; decide, record, move on.
- Polling `am runs` in a loop instead of the `am watch --all --follow --from-now` stream.
- Resuming without `--verify`.
- Making a run pass by loosening the gate instead of fixing the cause.
- Retrying the same fix endlessly instead of parking after 3 failed attempts.
- Letting one parked run stop work on the others.
- Pushing or merging "to be helpful". Nothing leaves local branches.
