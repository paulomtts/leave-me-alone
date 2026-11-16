---
name: progress
description: Use when the user invokes /progress (or /p), or asks "how far along are we", "what's done and what's left", "show progress" — prints a compact, scannable progress report of the things to do in this session.
---

# Progress

Print where the session's to-do work stands, as one compact block. Terminal text only: no artifact. Read the session's task list first, then what the conversation established.

## Shape

Put the report in a code block so columns align.

```
<One sentence: where things stand right now.>

Release 0.1.0   [█████████████░░░░░░░]  3.3 of 5 items · ~65%

 ✓  Release preparation        done: on main, CI green
 ✓  Audit round 6 + fix pass   done: on main, CI green
 ●  xarch review, steps 1-4    [█░░░░░░░░░] step 1 of 4, nothing committed
 ○  xarch review, steps 5-10   [░░░░░░░░░░] not started
 ⏸  Tag 0.1.0, GitHub release  [░░░░░░░░░░] waits on: the review, PyPI account

Next: finish review step 1.

- <≤3 bullets: non-obvious state of in-flight items, risks, anything that needs the user>
```

## Rules

1. **Source of truth:** the task list; if empty, work the conversation clearly established. Never invent items. No to-dos at all: one line saying so, no bars.
2. **Glyphs:** `✓` done · `●` in progress · `○` not started · `⏸` blocked (say on what) · `✗` failed or abandoned (say why). Failed and blocked items are never hidden.
3. **Bars:** 10 cells per item, 20 for the overall bar (`█` done, `░` left). Finished items skip the bar and show `done:` plus evidence (committed, merged, tests green), not just the word.
4. **The number is derived, not felt:** done = 1, in progress = the fraction you can justify from steps completed, others = 0. Overall = their mean. Show it as "X of N items" beside the percent; use `~` and say "estimate" when any fraction was judged rather than counted. If items are clearly unequal in size, say you weighted them and how.
5. **Many items:** with more than 7, collapse the done ones into one line ("✓ 6 done: …names") and list only the rest. With several goals, one overall bar per goal, with their items beneath.
6. **Order:** done first, then in progress, blocked, not started — so the frontier sits in the middle of the block.
7. **Next:** one line, the single next action and who takes it (me, a subagent, you).
8. **Bullets:** the last bullet surfaces anything that needs the user (a decision, approval, credential); if nothing does, say "nothing needs your input".

## Anti-pattern

Narrating history, or padding. Report state, not a log of what happened; if a line doesn't change the reader's picture of what's left, cut it.
