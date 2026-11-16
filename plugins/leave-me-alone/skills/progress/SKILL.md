---
name: progress
description: Use when the user invokes /progress (or /p), or asks "how far along are we", "what's done and what's left", "show progress" — prints a compact progress report of the things to do in this session.
---

# Progress

Print where the session's to-do work stands, in the shape below. Terminal text only: no artifact, no tools needed beyond reading the session's task list (TodoWrite/task list) and what the conversation already established.

## Shape

```
<one sentence: where things stand right now>

<Goal name>
[█████████████░░░░░░░]  ~65%

<Item 1>   [██████████] done, <evidence: on main, CI green, committed…>
<Item 2>   [█████░░░░░] in progress, <what is done / what is left>
<Item 3>   [░░░░░░░░░░] not started
<Item 4>   [░░░░░░░░░░] waits on <blocker>

<One line saying how the percentage was reached, e.g. "The 65% is my rough estimate, not a measurement.">

- <at most 3 bullets: the non-obvious state of in-flight items, and anything waiting on the user>
```

## Rules

1. **Source of truth:** the session's task list first; if empty, the work items the conversation has established. Never invent items.
2. **Bars:** 10 cells per item (`█` done, `░` remaining), the overall bar 20 cells. Align item names in a column.
3. **Per item:** a short status after the bar, with evidence for "done" (committed, merged, tests green) — not just the word.
4. **Overall percentage:** items done divided by total, adjusted for partial items. Always say whether it is a count or an estimate; never pass an estimate off as a measurement.
5. **Blocked items:** say what they wait on.
6. **Last bullet:** surface anything that needs the user (a decision, an approval); if nothing does, say "nothing needs your input".
7. If there are no to-dos in the session, say so in one line instead of drawing empty bars.

## Anti-pattern

Narrating history. Report state, not a log of what happened.
