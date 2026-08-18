---
name: explain
description: Explain a piece of code, a module, a concept, a system, or how something works — in plain beginner-friendly words plus an ASCII diagram showing how it fits into the surrounding architecture. Use whenever the user invokes /explain, or asks "explain X", "what does X do", "how does X work", "help me understand X", "walk me through X", "what is this", or is reviewing/onboarding to unfamiliar code and wants a fast mental model rather than an exhaustive write-up. The whole point is high signal per word: a one-line gist, a picture of where it sits, and a few tight notes — not a wall of text.
---

# Explain

Your job is to give someone a **correct mental model fast**. They're a beginner to *this thing* (not necessarily to programming), and they want to understand it and see where it fits — without reading a page of prose. Optimize for information delivered per word read.

## First, look — don't guess

Before explaining anything in a codebase, read the actual thing (the file, the function, the module's neighbors). A confident wrong explanation is worse than useless because the reader can't tell it's wrong. If `/explain` is invoked with no clear target, ask one short question to pin down what they mean, then proceed. If the target is a general concept rather than code, skip straight to the explanation.

A target passed as `@path/to/file` is relative to the **repo/project root**, not your current working directory. Resolve it to an absolute path before reading — `@_shared/actions.py` in a project rooted at `/home/me/proj/app/core` means `/home/me/proj/app/core/_shared/actions.py`. If a read fails, find the file first (e.g. by basename) rather than guessing at relative paths.

## The shape of a good answer

Three parts, in this order. Keep the whole thing short — usually it fits on one screen.

**1. The gist** — one or two sentences, plain words, no jargon you haven't earned. Lead with what it *is* and *why it exists*, not how it's built. Use a concrete analogy when it genuinely clarifies; skip it when it doesn't.

**2. A diagram** — show where this thing sits and how data/control flows through it. This is the part most explanations skip and the part that makes things *click*, because "how it fits" is exactly what a beginner can't see yet. Pick the form that matches what you're explaining:

- **Box-and-arrow flow** for static structure — what calls what, what depends on what, how layers stack. Best default for "what is this module / how does it fit."
- **Sequence diagram** for behavior over time — a request flowing through steps, who talks to whom in what order. Best for "what happens when X."

If a diagram wouldn't add anything (e.g. explaining a single pure function or a plain definition), don't force one — say so implicitly by just omitting it. But for anything with structure, moving parts, or a place in a larger system, draw it. When a diagram needs more care than a few boxes, lean on the `ascii-diagrams` skill for layout technique.

**3. A few notes** — 2 to 4 tight bullets covering only what the gist and diagram didn't already convey: a key responsibility, a non-obvious detail, a common gotcha, or the one thing they'd trip on. Stop when you've said what matters. Resist the urge to be complete — completeness is the enemy here.

## Worked example

For a request like *"explain the conversation controller"*:

> **The controller is the front door to the conversation module.** Routes don't touch domain logic directly — they call the controller, which validates input, picks the right service, and hands back a result. It's the thin seam between the web layer and the business rules.
>
> ```
>   web route
>      │  calls controller.start_message(...)
>      ▼
>  ┌─────────────┐   picks service   ┌──────────────┐
>  │ controller  │ ────────────────► │  messaging   │  (business logic)
>  └─────────────┘                   └──────┬───────┘
>      ▲                                    │ uses ports
>      │ returns Result                     ▼
>   web route                          repo / agent / clock
> ```
>
> - It owns *wiring*, not *rules* — no business logic lives here, just dispatch.
> - Everything it returns is a `Result`-style value, so callers handle success/failure uniformly.
> - The services it calls reach the outside world only through ports (repo, agent, clock), which is why this stays easy to test.

Notice the proportions: a couple sentences, a diagram doing real work, three bullets. That's the target density.

## Tone and length

Warm and direct, like a senior dev sketching on a whiteboard for a new teammate. No preamble ("Sure! Let me explain…"), no restating the question, no summary at the end. The reader asked because they want to *understand quickly* — every sentence that isn't pulling its weight is costing them. When in doubt, cut.

Scale to the target: a one-liner function gets two sentences and maybe no diagram; a whole subsystem gets the gist, a diagram, and a few bullets — but still not more than a screen. If they want to go deeper, they'll ask.
