---
name: walkthrough
description: Use when the user invokes /walkthrough, or asks to see, explore or click through how a feature, screen, flow or UX behaves today, step by step, as a draft artifact — "show me what the user sees", "draw the screens we have", "let me explore the flow", "what happens when X fails" — especially for flows with conflict, error, retry or permission branches that are hard to see by reading code.
---

# walkthrough

Turn a topic into an **explorable, step-by-step artifact** the user can click through: the screens as the user would see them on one side, what the system does behind each step on the other. The point is to let the reader *feel the UX*, including the branches nobody tests by hand.

## 1. Read the real thing first

Build only from evidence: templates, components, routes, controllers, string tables, docs, tests. Work out:

- **Entry**: what the user does to reach the flow.
- **Paths**: the happy path, plus every branch the code can take (conflict, error, retry, no permission, stale state, empty response).
- **Copy**: the real user-facing strings, in the language the product defaults to (or the one the user asks for). Quote them; do not paraphrase.
- **Reachability**: for each screen, whether anything can actually trigger it today.

Tag every claim as **verified** (read in code or run) or **inferred** (reasoned from code, not observed). If you did not drive the real app, say so on the page.

## 2. Shape of the artifact

One HTML file. Load `artifact-design` first, then publish with the Artifact tool, and reuse the project's own design tokens (colors, radii, fonts) if it has them.

- **Path tabs** across the top, one per path, happy path first.
- **Stage** (left): a mock of the surrounding app (just enough chrome to place the screen) with the real screen rebuilt on it. Modals sit over a scrim, toasts appear where the product puts them.
- **Step card** (right, sticky), the same four parts for every step:
  - *You see*: what is on screen, in plain words.
  - *Behind the scenes*: what the server or system does at that moment.
  - *Rough edge*: only where one exists, with a badge: `in the code today` (verified) or `inferred from code`.
  - Back and Next buttons plus a dot per step, each dot clickable.
- **Working controls**: anything the real screen lets the user click should work on the stage (picks, toggles, close). Each step may preset the state it needs; the user's clicks then override it.
- **Dead ends get their own path**: silent failures, disabled buttons with no explanation, empty responses. These are usually the finding.

Example data is allowed and must look like the product's real content. Mark it as example text in the page intro.

## 3. Data model

Drive the page from data so adding a path is cheap:

```js
PATHS = [{ label: "A · Overlapping edits", steps: [{
  title, sees, server,
  gap, gapKind,            // optional: "gap" (verified) | "unv" (inferred)
  picks,                   // optional preset state for this step
  render: state => html    // the stage for this step
}]}]
```

One `render(state)` per step, one `draw()` that rebuilds stage and card, one delegated click handler.

## 4. Finish

- Page intro states what it was built from and whether the real app was driven.
- In the reply: link, the paths included, the rough edges found (verified vs inferred), and one offer to verify the inferred items in the running app.
- Write the file to the scratchpad directory. Do not commit it to the project unless asked.

## Common mistakes

| Mistake | Fix |
|---|---|
| Static screenshots side by side | Make it steppable; the order of events is the content. |
| Only the happy path | Add a path per failure branch; dead ends are the most useful part. |
| Invented copy or states | Quote the string table; if a state has no code, leave it out. |
| Presenting inference as fact | Badge it `inferred from code` and offer to verify. |
| Mock chrome that competes with the screen | Keep the surrounding app to a title bar and a body. |
| A step card that repeats the screen | *You see* says what changes; *Behind the scenes* says why. |
