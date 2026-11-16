---
name: brief
description: Use when the user invokes /brief, or asks for a quick recap/summary of "what's going on", "where we are", "the current scenario", "how far along we are", or "what's happening right now" in the conversation or task — wants the gist and the progress fast, not a wall of text.
---

# Brief

Run `explain` (the `/explain` skill), targeted at **the current scenario** — the conversation state, the task in flight, the system just discussed — rather than a code file. Same three-part shape (gist, diagram, notes), but push harder on brevity: this is a recap, not a tutorial.

The recap must cover three things, in order: **where things stand right now**, **how far along the to-dos are** (when the session has any), and **any decision that needs the user's input to proceed**. A status that omits a pending decision leaves the reader unaware they're the blocker.

## How to apply

1. Invoke the `explain` skill with the current scenario as the target.
2. Gist = one sentence naming where things stand right now (who's doing what, what's blocked on what).
3. **Progress block** — when the session has a task list (or clearly established work items), print it right after the gist, in a code block so columns align. Skip it when there are no to-dos; never invent items.

```
Release 0.1.0   [█████████████░░░░░░░]  3.3 of 5 items · ~65%

 ✓  Release preparation        done: on main, CI green
 ●  xarch review, steps 1-4    [█░░░░░░░░░] step 1 of 4, nothing committed
 ○  xarch review, steps 5-10   [░░░░░░░░░░] not started
 ⏸  Tag 0.1.0, GitHub release  [░░░░░░░░░░] waits on: the review
```

   - Glyphs: `✓` done · `●` in progress · `○` not started · `⏸` blocked (say on what) · `✗` failed or abandoned (say why). Blocked and failed items are never hidden.
   - Bars: 10 cells per item, 20 for the overall bar. Done items skip the bar and show `done:` plus evidence (committed, merged, tests green).
   - The number is derived, not felt: done = 1, in progress = a fraction you can justify, others = 0; overall = the mean. Show "X of N items" beside the percent, and mark `~` / say "estimate" when a fraction was judged rather than counted.
   - Order: done, in progress, blocked, not started. With more than 7 items, collapse the done ones into one line.
4. Skip the diagram if the scenario is linear enough to say in a sentence; otherwise draw an ASCII flowchart or sequence diagram only when there's real branching or multi-party back-and-forth (e.g. "agent A dispatched B, which is blocked on C's PR") — a picture beats a paragraph there.
5. Notes: at most 3 tight bullets. The last one always surfaces decisions that require the user specifically — a choice only they can make, an approval, a pick between options — not generic next steps that agents/automation will handle on their own. If nothing is waiting on the user right now, say so in one clause ("nothing needs your input") instead of omitting it.

## Anti-pattern

Restating everything said so far in prose. If it doesn't change the reader's mental model of *where things stand right now*, cut it.
