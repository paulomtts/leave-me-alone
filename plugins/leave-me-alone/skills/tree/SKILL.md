---
name: tree
description: Draw an ASCII containment/hierarchy tree showing what contains what — a class hierarchy, a folder structure, a domain model's nesting, a system's component ownership. Use whenever the user invokes /tree, or asks to "show the tree", "draw the containment tree", "what contains what", "show me the hierarchy/structure of X", or wants a class/module/domain-model nesting diagrammed. Distinct from `explain`'s box-and-arrow diagrams, which cover flow and dependency, not containment — use `tree` specifically for "what's inside what."
---

# tree

Show someone what's inside what, fast and correctly. A containment tree answers one question only: if you cracked this thing open, what would you find nested inside it? Not what it calls, not what it depends on — what it *owns*.

## First, look — don't guess

Read the actual code or structure before drawing anything: the class/type definitions, the folder layout, the schema. A tree that guesses at field names or nesting is worse than no tree, because it looks authoritative. If the target is ambiguous (a whole repo with no obvious root), ask which subtree they mean, or pick the most likely root and say so in one line.

## Finding real containment

Containment is a **has-a / is-composed-of** relationship: X holds a list of Y, X embeds Y as a field, a directory holds files, a class owns sub-objects. It is not:

- **Calls / uses** — a service invoking a repository is a dependency, not containment. That belongs in `explain`'s box-and-arrow diagram.
- **References by id** — a `Creature` holding a `zone_id` doesn't make Creature contain Zone; if anything the ownership runs the other way (Zone contains Creatures).
- **Implements / conforms to** — a class implementing a protocol/interface isn't nested inside it. Interfaces are cross-cutting, not part of the containment chain (see below).

When two things are mutually referential, ownership direction usually follows lifecycle: whichever one's deletion should cascade-delete the other is the container.

## Output format

An ASCII tree using box-drawing characters (`├──`, `└──`, `│`), one root, children indented underneath. Annotate each node with just enough to be useful — scalar fields inline, collections marked with their element type:

```
Vivarium
├── id, name, max_size
└── zones: list[Zone]
    ├── id, name, terrain, temperature, size
    ├── creatures: list[Creature]
    │   ├── id, name, sex, size
    │   └── ...
    └── features: list[Feature]
```

Rules of thumb:
- Scalar/primitive fields go first on a node, as a plain comma-separated line — don't give each `int`/`str` field its own tree branch, that's noise.
- A field that's itself a collection of a modeled type gets its own branch, labeled `field_name: list[Type]` (or `Type` for a single nested object), then expands one level further.
- Stop expanding a type once you've shown it in full elsewhere in the tree — write `...` or `(see above)` rather than duplicating a large subtree.
- Keep depth to what's real. Don't invent intermediate wrapper nodes to make the diagram prettier.

## Cross-cutting concerns

Protocols, interfaces, mixins, or shared base classes that multiple nodes conform to don't fit the strict containment hierarchy — forcing them in as fake parents/children misrepresents the structure. Call these out **below** the main tree instead:

```
Cross-cutting:
- Creature, Feature both implement Locatable (has x, y within their Zone)
- Species is referenced by Creature (creature.species_id) but is not owned by it — Species lives independently
```

## Worked example

For a request like *"show me the tree for the order module"*:

```
Order
├── id, status, created_at, customer_id
├── shipping_address: Address
│   └── street, city, postal_code, country
└── line_items: list[LineItem]
    ├── id, quantity, unit_price
    └── product: ProductSnapshot
        └── sku, name, price_at_purchase

Cross-cutting:
- Order and ProductSnapshot both implement Serializable (to_json/from_json)
- LineItem.product_id references the live Product catalog entry but embeds a frozen ProductSnapshot, not a live reference — the snapshot is what's actually contained
```

## Tone and length

Lead with the tree — it's the deliverable, not a preamble. A sentence or two of setup only if the root or scope needs disambiguating. Cross-cutting notes stay terse, a few bullets at most. No summary after the tree restating what it already shows.
