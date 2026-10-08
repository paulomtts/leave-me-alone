---
name: explain
description: Explain a feature, flow, concept, system, or piece of code as a business mental model — who is involved, what happens, why it matters — using ASCII flowcharts (boxes with labeled arrows) and sequence diagrams, in words a product person can follow. Use whenever the user invokes /explain, or asks "explain X", "what does X do", "how does X work", "help me understand X", "walk me through X", "what is this", or is onboarding to something unfamiliar and wants a fast mental model. Business view by default; pass `--technical` for the code-architecture view. The whole point is high signal per word: a short lead, a picture, a few tight notes — not a wall of text.
---

# Explain

Give someone a **correct mental model fast**. By default the reader is a product person: they care about who is involved, what happens, and what it means for the business — not how it is built. Optimize for information delivered per word read.

If the arguments contain `--technical`, use [Technical view](#technical-view) instead. Only the flag switches views; wording like "architecture" in the request does not.

## First, look — don't guess

Before explaining anything in a codebase, read the actual thing (the file, the function, the module's neighbors). A confident wrong explanation is worse than useless because the reader can't tell it's wrong. Code is evidence for the business model, not the subject: read it, then describe what it does in business terms. If `/explain` is invoked with no clear target, ask one short question to pin down what they mean, then proceed. If the target is a general concept rather than code, skip straight to the explanation.

A target passed as `@path/to/file` is relative to the **repo/project root**, not your current working directory. Resolve it to an absolute path before reading. If a read fails, find the file first (e.g. by basename) rather than guessing at relative paths.

## The shape of a good answer

Keep the whole thing short — it should fit on one screen.

**1. The lead** — three short lines, always in this order:

- **Who** — the actors (customer, admin, partner, the system acting on someone's behalf).
- **What** — the outcome, in one sentence of plain words.
- **Why it matters** — the business value or the cost of it going wrong.

**2. Diagrams** — pick the form that fits; use one or both.

- **Flowchart** for how things relate or where the flow branches. Business nouns go in boxes; the verb goes on the arrow.
- **Sequence diagram** for who does what, in order, over time. One column per actor.

Skip a diagram only when it would add nothing (a single definition, a one-step action). For anything with several actors or steps, draw it.

Always draw the **failure branches** next to the happy path — refund, declined payment, approval denied, item out of stock. Show each as one labeled branch off the main flow, not a full sub-flow. If it needs more than a branch, say so in the notes.

**3. A few notes** — 2 to 4 bullets covering only what the lead and diagrams didn't: a business rule, an exception that costs money or trust, who is affected and how. Stop when you've said what matters. Completeness is the enemy here.

## Vocabulary

Use business nouns and verbs. Words a product person already knows (login, payment, notification, order) are fine. Leave out implementation words: API, endpoint, queue, schema, cache, class and function names, file paths. When code is the target, translate what it does into actors, things and outcomes: `OrderService.create` becomes "the customer places an order".

## Diagram conventions

Boxes hold nouns; arrows carry verbs. Keep labels short and read left-to-right or top-to-bottom.

Flowchart, with a failure branch:

```
 ┌──────────┐  places   ┌─────────┐  is charged  ┌─────────┐  ships to  ┌──────────┐
 │ Customer │ ────────► │  Order  │ ───────────► │ Payment │ ─────────► │ Customer │
 └──────────┘           └─────────┘              └────┬────┘            └──────────┘
                                                      │ declined
                                                      ▼
                                              ┌───────────────┐
                                              │ Order on hold │ ──notifies──► Customer
                                              └───────────────┘
```

Sequence diagram, with a failure branch:

```
 Customer          Store            Payments         Warehouse
    │ places order   │                 │                 │
    │───────────────►│ charges         │                 │
    │                │────────────────►│                 │
    │                │   approved      │                 │
    │                │◄────────────────│ ships order     │
    │                │─────────────────────────────────►│
    │ confirmation   │                 │                 │
    │◄───────────────│                 │                 │
    │                │                 │                 │
    │    ✗ if declined: Store holds the order and asks the customer to retry
```

## Worked example

For a request like *"explain checkout"*:

> **Who:** a customer buying from the store; the payment provider and the warehouse act on the order.
> **What:** turns a basket into a paid order that gets shipped.
> **Why it matters:** this is where revenue is actually captured — a failure here is a lost sale.
>
> ```
>  ┌──────────┐ fills  ┌────────┐ pays for ┌─────────┐ triggers ┌──────────┐
>  │ Customer │ ─────► │ Basket │ ───────► │  Order  │ ───────► │ Shipment │
>  └──────────┘        └────────┘          └────┬────┘          └──────────┘
>                                               │ payment declined
>                                               ▼
>                                       ┌───────────────┐
>                                       │ Order on hold │ ──asks retry──► Customer
>                                       └───────────────┘
> ```
>
> - Stock is reserved when the order is placed, not when it ships, so a held order still ties up inventory.
> - A declined payment never cancels the order automatically; the customer has 24 hours to retry.
> - Customers get an email at each step: placed, held, shipped.

Notice the proportions: a three-line lead, a diagram doing real work with its failure branch, three bullets.

## Technical view

Used only with `--technical`. Same short shape, aimed at an engineer new to this code.

1. **The gist** — one or two sentences: what it *is* and *why it exists*, not how it's built. Use a concrete analogy only when it clarifies.
2. **A diagram** — box-and-arrow for static structure (what calls what, how layers stack), sequence diagram for behavior over time (a request flowing through steps). Omit it for a single pure function or a plain definition.
3. **2–4 notes** — a key responsibility, a non-obvious detail, a gotcha. Code, file and class names are welcome here.

## Tone and length

Warm and direct, like someone sketching on a whiteboard for a new teammate. No preamble ("Sure! Let me explain…"), no restating the question, no summary at the end. Every sentence that isn't pulling its weight costs the reader time. When in doubt, cut. Scale to the target: a small thing gets a lead and maybe no diagram; a whole subsystem still gets no more than one screen. If they want to go deeper, they'll ask.
