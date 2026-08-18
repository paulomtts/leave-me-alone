---
name: brief
description: Use when the user invokes /brief, or asks for a quick recap/summary of "what's going on", "where we are", "the current scenario", or "what's happening right now" in the conversation or task — wants the gist fast, not a wall of text.
---

# Brief

Run `explain` (the `/explain` skill), targeted at **the current scenario** — the conversation state, the task in flight, the system just discussed — rather than a code file. Same three-part shape (gist, diagram, notes), but push harder on brevity: this is a recap, not a tutorial.

The recap must cover two things, in order: **where things stand right now**, and **any decision that needs the user's input to proceed**. A status that omits a pending decision leaves the reader unaware they're the blocker.

## How to apply

1. Invoke the `explain` skill with the current scenario as the target.
2. Gist = one sentence naming where things stand right now (who's doing what, what's blocked on what).
3. Skip the diagram if the scenario is linear enough to say in a sentence; otherwise draw an ASCII flowchart or sequence diagram only when there's real branching or multi-party back-and-forth (e.g. "agent A dispatched B, which is blocked on C's PR") — a picture beats a paragraph there.
4. Notes: at most 3 tight bullets. The last one always surfaces decisions that require the user specifically — a choice only they can make, an approval, a pick between options — not generic next steps that agents/automation will handle on their own. If nothing is waiting on the user right now, say so in one clause ("nothing needs your input") instead of omitting it.

## Anti-pattern

Restating everything said so far in prose. If it doesn't change the reader's mental model of *where things stand right now*, cut it.
