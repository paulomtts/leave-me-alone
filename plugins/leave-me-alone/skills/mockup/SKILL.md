---
name: mockup
description: Use when the user invokes /mockup, or asks to draft, mock up or sketch a NEW or changed UI feature as an artifact that must match the existing app and tell the builder what to build it with — "draft this screen", "mock it up faithfully", "annotate which components to use", "show what is new vs what exists". The draft is built from the real source, marks what is new, and carries build notes that name the real components.
---

# mockup

Draft a new feature as one HTML artifact that a builder can read instead of the spec. Three promises: every part that exists today looks and reads exactly like the app, every new part is visibly marked, and every part names the existing component to build it with. A draft that is only plausible is worse than none, because the builder will copy its mistakes.

## 1. Read the real thing first

Build the existing surfaces from source, never from memory or a token palette. For each screen the feature touches, read its templates, component classes, stylesheets and string tables, plus the standards that govern it (component taxonomy, design system, builtin-by-default). Work out:

- **Structure and order**: the real regions, their order, the real labels (render them in the language the user asks the artifact to be in; the app's own copy language does not decide that).
- **Real CSS**: copy the actual rules and class names, with the project's design tokens. Never approximate a spacing, radius, shadow or variant.
- **Real states**: model them from the component's props and scripts, not from intuition. Empty, read-only, locked, expired, refused, loading. Behaviour you assumed is the usual place the first draft is wrong (a lapsed lock is not a deleted record; a read-only drawer may hide a button rather than disable it).
- **Reachability**: whether the thing you draw can actually happen today.

Tag every claim **verified** (read in source) or **inferred**. If you did not render the page, say so on it.

## 2. Shape of the artifact

One file, one page, English unless told otherwise. Load `artifact-design` first, then publish with the Artifact tool, updating the same URL on every later pass.

**Start from the project's template when it has one.** If `docs/artifacts/_mockup-template.html` exists in the repo, the page MUST be built from it: copy it to `docs/artifacts/<feature>-mockup.html`, replace the blocks marked `TEMPLATE: replace`, fill its sections in its order, and keep its page chrome unchanged (the sticky top bar with the two toggles and the theme control, the Contents sidebar built from `<section data-nav>`, the marker and badge classes, each section's `data-allow` list, the build-note pin markup and its script). Do not invent a second layout. Only when that file does not exist, build the page from the fallback structure below.

The template's section order: Intent, Read first (where the code differs from the brief), Decisions (D1…), Open questions (Q1…), Not drawn, Alternatives (optional), Hero, lettered cards (a Today/After pair where a surface changes), Rules (optional, R1… with today, proposed rule, severity, source and the cards that show it), Build summary, Fidelity notes, Revisions, Badge reference.

- **Page chrome** (fallback only): a sticky top bar with the title and the toggles from sections 3 and 4, and a Contents sidebar listing every section with scroll-spy, collapsing into a drawer on narrow screens.
- **Hero**: the main surface at its real size (a drawer is its real width, in its real surrounding, over a dimmed neighbour), with the states side by side. Interactive where cheap: disclosures, toggles, an expand animation, a replay button. Respect reduced motion.
- **Cards**: lettered, each a caption plus a stage showing one state, one dialog or one list. The caption says what the card proves.
- **Decisions** and **Open questions** notes at the top. A decision records who made it; a guess is labelled a guess.
- **Fidelity notes** at the bottom: for each surface, the source files it mirrors, what is existing and what is new, every deliberate deviation with its reason, and everything you could not verify.
- **Build summary**: a table of every new component the build needs (proposed name, what it composes, where it lives per the taxonomy) and every existing one reused.

## Badges

Badges are a closed vocabulary; use no other. Each section allows only the badges in its row. App badges drawn inside a stage are copies of real UI and fall outside this list. The project template enforces it: `data-allow` on each section prints the allowed set under the heading and outlines any other badge in red, with a console warning.

| Badge | Means | Allowed in |
|---|---|---|
| NEW · MOVED · CHANGED marker | not in the app yet · exists in a new place · exists, behaviour changes | on drawn elements inside a stage: Hero, cards |
| Owner · Guess | the owner decided · the author's guess | Decisions |
| Open · Answered | unanswered · answered, answer kept beside it | Open questions |
| Recommended | the option the author recommends | Open questions, Alternatives |
| Verified · Inferred | read in source · reasoned, not read | Read first, Rules, Fidelity notes |
| High · Medium · Low | harm the rule gap does | Rules |
| Builtin · Primitive · Existing · Extend · New · Unsure | component kind to build with | build notes, Build summary |
| Draft N · Rendered · Not rendered | draft number or date, whether the page was rendered | top bar |

Intent, Not drawn and Revisions carry no badges.

## 3. Mark new against existing

A "Highlight new elements" toggle, on by default. NEW is a visible outline plus a small tag; MOVED (an existing element in a new place) and CHANGED (an existing element whose behaviour changes) each get their own colour. Anything without a marker is existing behaviour, so the reader can trust the unmarked parts as a reference.

## 4. Build notes

A "Show build notes" toggle, off by default, remembered in `localStorage` inside try/catch. When on, numbered pins sit on the parts of the draft with leader lines to notes in a side margin; under about 1000px the notes become a numbered list below each card and the lines drop.

Each note has: a kind tag (**BUILTIN** from the UI framework, **PRIMITIVE** from the app, **EXISTING** reused as-is, **EXTEND** an existing component that gains a prop or variant, **NEW**), the component name, its source path, and one line on how to use it (variant, props, slot). Cover every new or moved element and the existing part it mounts into. Verify every name and path by reading the source; never guess. Where it is unclear write **UNSURE** and say what you checked. Prefer a builtin, then an app primitive, and propose a new component only when neither fits, as the standards say.

## 5. Working method

- Do it in passes, not one shot: draft, then a **fidelity pass** (rebuild every existing part from source and report where the draft was wrong), then a **callouts pass**. One editor on the file at a time.
- When delegating, give the agent the real component catalogues and source paths, the language rule, and the file and URL to update in place. Ask for the list of places the earlier draft was wrong, the UNSURE notes and the unverifiable names, not for a victory lap.
- Keep a local copy beside the repo's other artifacts and make the published file and the copy identical (`cmp`). Check that the inline script parses (`node --check`) and that ids are unique.
- The page source is the artifact: read the file to answer questions about it. Rendering is optional; when you did not render, say the layout, spacing and pin positions are unchecked.
- Invented copy, sample data and numbers are labelled as such. Fonts and icons that are approximations are listed in the fidelity notes.

## 6. Report

Lead with the URL. Then, in order: where the real app differed from what you were told (the part to read first), what is new versus existing in three lines, the UNSURE notes, and the open questions the page now lists.
