---
name: layout
description: Use when the user asks to describe, map, or diagram a UI surface's component/layout structure — "map the layout of X", "what's the component tree of this page", "diagram this screen", "how is this view composed", "show me the structure of the settings page". Produces one structural ASCII tree marking swap/re-render boundaries plus tight annotations. Framework-agnostic (React, pyjinhx, vanilla, ...); examples may be framework-flavored.
---

# Layout

Your job is to render a UI surface as **one tree diagram that does the work**, plus the minimum prose the diagram can't say. The reader wants to see the containment structure, where re-renders happen, and what triggers them — on one screen. Completeness is the enemy: show swap boundaries and quirks, not every prop.

## 1. Look first

Read the actual component files, templates, and mount points before drawing anything. Never diagram from memory or guesses — a confident wrong tree is worse than none. Identify three things while reading:

- the **render/containment tree** (who mounts whom, top-down),
- which nodes are **swap/re-render boundaries** (the units that update independently),
- **what triggers** each boundary (event, key, query, subscription, route).

## 2. One tree diagram

A single code block, box-drawing chars (`├── └── │`), containment top-down from the persistent frame (page/app root) to leaves. Conventions:

- **Zone/anchor names** in «guillemets» or quoted ids where they matter: `«main #app-content»`.
- **★ on every reactive/re-rendering unit**, trigger inline: `★ ReactiveComponent react={MODE}`, or React-flavored: `★ useQuery(files)`, `★ context: ThemeCtx`.
- **Mode branches** — when one slot renders alternatives, draw labeled branches with connecting lines (`├── none open ───`, `└── form open ───`).
- **One-word status annotations** where load-bearing: `static`, `route-rendered overlay`, `EMPTY`, `(HTML string prop!)`.
- **×N** for repeated children.

Check the formatting: align ★ markers and annotations into rough columns — the alignment is what makes the tree scannable.

## 3. Update vocabulary (small second block)

If the framework has named events/keys/queries that cause swaps, list them in a second small block, one line each: `KEY — what dirties it — what swaps`. If there's no such concept, fold triggers into the tree and skip this block.

## 4. Notes: 3–6 tight bullets

Only what the diagram can't show: nesting quirks, coexisting data-feed styles, anti-patterns spotted, gaps vs the project's stated target architecture. **Bold the lead phrase** of each bullet. Stop when you've said what matters.

## 5. End with an opening, not a summary

Offer 2–3 concrete next directions: zoom into a branch, review conformity against a standard, draw the target state.

## Worked example (pyjinhx-flavored, abridged)

```
HomePage (Page — framing, never swaps)
├── «header #app-navbar»  NavbarShell
├── «aside #sidebar»      SidebarShell ── library branch: EMPTY
└── «main #app-content»
    └── LibraryDesktopShell          ★ ReactiveComponent  react={MODE}
        │   load(ctx): ctx.active_library_item
        ├── none open ─── LibraryBrowserShell  ★ react={TREE}
        │                 ├── FileRow ×N   static
        │                 └── ActiveUploadsPanel  static
        ├── doc open ──── LibraryDocShell  static
        │                 └── ReconcileModal  route-rendered overlay
        └── form open ─── LibraryFormShell  static, custom __init__
                          ├── tab=table:   FormTable  static
                          └── tab=builder: FormBuilder  static
```

```
MODE — dirtied by open/close of a library item — swaps LibraryDesktopShell
TREE — dirtied by file CRUD/moves — swaps LibraryBrowserShell subtree
```

- **Sidebar is dead weight here** — the library branch renders EMPTY; navigation happens entirely inside `#app-content`.
- **ReconcileModal bypasses the reactive tree** — it's route-rendered as an overlay, so MODE/TREE dirtying never touches it.

Then two or three offered directions ("zoom into the browser branch", "check the form shell against the component taxonomy", ...).

## Tone

Terse, dense, no filler — same register as `/explain`. No preamble, no restating the request, no closing summary. The diagram carries the structure; prose earns its place only by saying what the diagram can't.
