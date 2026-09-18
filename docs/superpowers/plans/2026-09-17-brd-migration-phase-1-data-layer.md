# brd Migration — Phase 1: the data layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the orchestrator read its milestone structure from `brd` instead of GitHub Milestones, Issues, sub-issues and Projects v2, while pull requests stay exactly where they are.

**Architecture:** A new `brd.mjs` wraps the CLI the way `gh.mjs` wraps `gh` — injectable runner, strict `ok` checking, no retries. A new `naming.mjs` derives branch and artifact names from card ids, replacing the GitHub issue numbers they were built from. `detect.mjs`'s census becomes one `brd tree` call plus pure reshaping, keeping its PR lookup on `gh`. `orchestrator.js` is re-keyed from issue numbers to card ids, and its ordinal-prefix sorting is replaced by a topological sort over sibling `blocked_by` edges.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, `bun` as the runtime for the scripts themselves, `brd` ≥ the commit adding `brd import` (#40).

**Spec:** `docs/superpowers/specs/2026-09-17-brd-migration-design.md`

## Global Constraints

- **Tests run with `node --test`, never `bun test`** — they are written against `node:test`, which bun's runner cannot execute. Scripts themselves run under `bun` at runtime.
- **Every brd call asserts `ok === true` and throws otherwise. No call ever degrades to `[]`.** A failed read becoming an empty list is how a milestone goes flat and every story dispatches at once against a base none has built on.
- **brd calls are never retried.** They are local and deterministic; a failure is real. `withRetries` remains for `gh` only.
- **`blocked` is never written, and on read means `todo`.** brd derives it; readiness comes from the orchestrator's own DAG walk.
- **Anything that MATCHES a card keys on its 8-character short id, never on the slug.** A title can be edited after a PR is open; slug-based matching would orphan the PR and make finished work read as not done.
- **`brd next` is not used for dispatch, in either form.**
- Every brd invocation passes an explicit `cwd` of the main checkout (`repoDir`). brd resolves its project by walking up from the working directory.

---

### Task 1: `brd.mjs` — the injectable runner and strict parse

**Files:**
- Create: `plugins/leave-me-alone/scripts/brd.mjs`
- Test: `plugins/leave-me-alone/scripts/brd.test.mjs`

**Interfaces:**
- Consumes: `jsonFrom` from `./gh.mjs` (parses from the first structural character, so tool-manager banners like mise's do not break it).
- Produces: `brdRunner(args, {cwd})`, `brdData(text)`, `brd(args, {cwd, run})`, `class BrdError`.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/scripts/brd.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brdData, brd, BrdError } from './brd.mjs'

test('brdData returns the data payload of a successful call', () => {
  assert.deepEqual(brdData('{"ok": true, "data": [{"id": "a"}]}'), [{ id: 'a' }])
})

test('an ok:false body throws with the error type, and never returns a value', () => {
  const body = '{"ok": false, "error": {"type": "CardNotFoundError", "message": "no card with id nope"}}'
  assert.throws(() => brdData(body), err => {
    assert.ok(err instanceof BrdError)
    assert.equal(err.type, 'CardNotFoundError')
    assert.match(err.message, /no card with id nope/)
    return true
  })
})

test('a tool-manager banner above the JSON is tolerated', () => {
  assert.deepEqual(brdData('mise tools: brd@0.1.0\n{"ok": true, "data": 1}'), 1)
})

test('brd() passes argv and cwd through to the injected runner', async () => {
  const calls = []
  const run = async (args, opts) => {
    calls.push({ args, opts })
    return '{"ok": true, "data": {"title": "Milestone"}}'
  }
  const data = await brd(['tree'], { cwd: '/abs/repo', run })
  assert.deepEqual(data, { title: 'Milestone' })
  assert.deepEqual(calls, [{ args: ['tree'], opts: { cwd: '/abs/repo' } }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/brd.test.mjs`
Expected: FAIL — `Cannot find module './brd.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// plugins/leave-me-alone/scripts/brd.mjs
// The brd equivalent of gh.mjs: an injectable runner plus a parse that refuses
// to let a failure look like an empty result.
//
// Deliberately NO retries. Every call here is a local SQLite read or write, so
// a failure is a real one — retrying a CycleError just fails four times.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { jsonFrom } from './gh.mjs'

const execFileAsync = promisify(execFile)

export class BrdError extends Error {
  constructor(type, message) {
    super(`${type}: ${message}`)
    this.name = 'BrdError'
    this.type = type
  }
}

// brd prints its error payload to STDOUT and exits 1, leaving stderr EMPTY.
// execFile rejects on the non-zero exit, so the body we need is on err.stdout —
// the opposite of ghError(), which reads stderr.
export async function brdRunner(args, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync('brd', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (err) {
    if (err && typeof err.stdout === 'string' && err.stdout.trim()) return err.stdout
    throw err
  }
}

export function brdData(text) {
  const payload = jsonFrom(text)
  if (!payload || payload.ok !== true) {
    const error = payload && payload.error
    throw new BrdError(
      (error && error.type) || 'BrdFailure',
      (error && error.message) || 'brd reported failure without an error body')
  }
  return payload.data
}

export async function brd(args, { cwd, run = brdRunner } = {}) {
  return brdData(await run(args, { cwd }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/brd.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/brd.mjs plugins/leave-me-alone/scripts/brd.test.mjs
git commit -m "Add brd.mjs: injectable runner with strict ok-checking"
```

---

### Task 2: `naming.mjs` — card identity for branches and artifacts

**Files:**
- Create: `plugins/leave-me-alone/scripts/naming.mjs`
- Test: `plugins/leave-me-alone/scripts/naming.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `shortId(cardId)`, `slugify(title, max)`, `taskStem(card)`, `taskBranch(branchPrefix, card)`, `refMatchesCard(ref, cardId)`. A `card` is `{id, title}`.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/scripts/naming.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortId, slugify, taskStem, taskBranch, refMatchesCard } from './naming.mjs'

const CARD = { id: 'a32af745-15ef-45cd-b52c-64c19ae82c17', title: '40.1 feat: write rows' }

test('shortId is the first 8 hex characters, dashes ignored, lowercased', () => {
  assert.equal(shortId(CARD.id), 'a32af745')
  assert.equal(shortId('A32AF745-15EF-45CD-B52C-64C19AE82C17'), 'a32af745')
})

test('shortId rejects anything that is not a card id rather than returning junk', () => {
  assert.throws(() => shortId(''), /not a card id/)
  assert.throws(() => shortId(undefined), /not a card id/)
  assert.throws(() => shortId('nope'), /not a card id/)
})

test('slugify lowercases, collapses punctuation to single dashes, and trims them', () => {
  assert.equal(slugify('40.1 feat: write rows'), '40-1-feat-write-rows')
  assert.equal(slugify('  Hello,   World!  '), 'hello-world')
})

test('slugify truncates without leaving a trailing dash', () => {
  assert.equal(slugify('abcdefghij klmnopqrst uvwxyz', 24), 'abcdefghij-klmnopqrst')
})

test('taskStem is slug then short id, so the id is a stable suffix', () => {
  assert.equal(taskStem(CARD), '40-1-feat-write-rows-a32af745')
})

test('a card whose title slugifies to nothing still gets a usable stem', () => {
  assert.equal(taskStem({ id: CARD.id, title: '???' }), 'a32af745')
})

test('taskBranch prefixes the stem', () => {
  assert.equal(taskBranch('m12', CARD), 'm12/task-40-1-feat-write-rows-a32af745')
})

test('matching keys on the short id, so an edited title still finds its PR', () => {
  const branch = taskBranch('m12', CARD)
  const renamed = { ...CARD, title: 'completely different title' }
  assert.equal(refMatchesCard(branch, renamed.id), true)
})

test('matching does not confuse two different cards', () => {
  assert.equal(refMatchesCard('m12/task-quoting-03a6dc10', CARD.id), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/naming.test.mjs`
Expected: FAIL — `Cannot find module './naming.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// plugins/leave-me-alone/scripts/naming.mjs
// A card's identity in every derived name: branches, plan files, spec files.
//
// The two halves are not equal. The short id is load-bearing and the slug is
// decoration: a card's title can be edited after its PR is open, and if
// matching keyed on the slug that edit would orphan the PR — the run would
// report finished work as not done. So everything that MATCHES uses the id, and
// the slug exists only so `git branch` and PR lists are readable.
//
// Eight hex characters matches the Plan-Hash convention already used in this
// repo, and collides with probability that does not matter inside one milestone.

export function shortId(cardId) {
  const hex = String(cardId ?? '').replace(/-/g, '')
  if (!/^[0-9a-f]{8,}$/i.test(hex)) throw new Error(`not a card id: ${JSON.stringify(cardId)}`)
  return hex.slice(0, 8).toLowerCase()
}

export function slugify(title, max = 24) {
  const flat = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (flat.length <= max) return flat
  // Cut at a word boundary rather than mid-word: a trailing "-uv" fragment
  // makes a branch name harder to read, not easier.
  const cut = flat.slice(0, max)
  const lastDash = cut.lastIndexOf('-')
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '')
}

export function taskStem(card) {
  const slug = slugify(card && card.title)
  const id = shortId(card && card.id)
  return slug ? `${slug}-${id}` : id
}

export function taskBranch(branchPrefix, card) {
  return `${branchPrefix}/task-${taskStem(card)}`
}

export function refMatchesCard(ref, cardId) {
  return String(ref ?? '').includes(shortId(cardId))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/naming.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/naming.mjs plugins/leave-me-alone/scripts/naming.test.mjs
git commit -m "Add naming.mjs: derive branch and artifact names from card ids"
```

---

### Task 3: sibling ordering from `blocked_by` edges

**Files:**
- Create: `plugins/leave-me-alone/scripts/census.mjs`
- Test: `plugins/leave-me-alone/scripts/census.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `orderSiblings(cards)` — takes raw `brd tree` child nodes (`{id, title, status, blocked_by, created_at, children}`) and returns them in execution order.

This replaces `parseOrdinal`/`orderSubtasks` in `orchestrator.js:33-54`, which sorted on an ordinal prefix parsed out of the title. Order now comes from the dependency chain the cards actually carry.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/scripts/census.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderSiblings } from './census.mjs'

const card = (id, created_at, blocked_by = []) => ({
  id: `${id}0000000-0000-4000-8000-000000000000`.slice(0, 36),
  title: id, status: 'todo', blocked_by: blocked_by.map(b => `${b}0000000-0000-4000-8000-000000000000`.slice(0, 36)),
  created_at, children: [],
})
const titles = cards => cards.map(c => c.title)

test('a chain runs in dependency order, not creation order', () => {
  // b was created first but is blocked by a: a must come first.
  const b = card('b', '2026-01-01T00:00:00Z', ['a'])
  const a = card('a', '2026-01-02T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([b, a])), ['a', 'b'])
})

test('independent siblings keep creation order', () => {
  const a = card('a', '2026-01-02T00:00:00Z')
  const b = card('b', '2026-01-01T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([a, b])), ['b', 'a'])
})

test('a three-card chain resolves fully', () => {
  const c = card('c', '2026-01-01T00:00:00Z', ['b'])
  const b = card('b', '2026-01-02T00:00:00Z', ['a'])
  const a = card('a', '2026-01-03T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([c, b, a])), ['a', 'b', 'c'])
})

test('an edge pointing outside the sibling set does not order siblings', () => {
  // Blocked by a card in another story: irrelevant to ordering HERE.
  const a = card('a', '2026-01-01T00:00:00Z', ['z'])
  const b = card('b', '2026-01-02T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([a, b])), ['a', 'b'])
})

test('an empty list is an empty list, not a throw', () => {
  assert.deepEqual(orderSiblings([]), [])
  assert.deepEqual(orderSiblings(undefined), [])
})

test('cards are never silently dropped', () => {
  // Defensive: a cycle cannot be persisted by brd, but truncating the list
  // would silently remove subtasks from a milestone.
  const a = card('a', '2026-01-01T00:00:00Z', ['b'])
  const b = card('b', '2026-01-02T00:00:00Z', ['a'])
  assert.throws(() => orderSiblings([a, b]), /could not be ordered/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/census.test.mjs`
Expected: FAIL — `Cannot find module './census.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// plugins/leave-me-alone/scripts/census.mjs
// Reshaping `brd tree` into the flat census the orchestrator's graph code
// already expects. Pure functions only: no CLI, no I/O.

// Execution order for one card's children.
//
// Order used to be parsed out of an ordinal prefix in the title. It now comes
// from the blocked_by edges between the siblings themselves, so the board
// states the order rather than encoding it in text. Edges pointing OUTSIDE the
// sibling set are ignored here — a subtask blocked by another story's card is a
// dispatch concern, not a sibling-ordering one. Independent siblings keep
// creation order.
export function orderSiblings(cards) {
  const list = cards ?? []
  if (list.length === 0) return []

  const byId = new Map(list.map(card => [card.id, card]))
  const indegree = new Map(list.map(card => [card.id, 0]))
  const unlocks = new Map(list.map(card => [card.id, []]))

  for (const card of list) {
    for (const blockerId of card.blocked_by ?? []) {
      if (!byId.has(blockerId)) continue
      unlocks.get(blockerId).push(card.id)
      indegree.set(card.id, indegree.get(card.id) + 1)
    }
  }

  const earliestFirst = (a, b) =>
    String(byId.get(a).created_at ?? '').localeCompare(String(byId.get(b).created_at ?? ''))
    || String(a).localeCompare(String(b))

  const ready = list.filter(card => indegree.get(card.id) === 0).map(card => card.id).sort(earliestFirst)
  const ordered = []
  while (ready.length > 0) {
    const id = ready.shift()
    ordered.push(byId.get(id))
    for (const next of unlocks.get(id)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
    ready.sort(earliestFirst)
  }

  if (ordered.length !== list.length) {
    const stuck = list.filter(card => !ordered.includes(card)).map(card => card.id)
    throw new Error(`census: ${stuck.length} card(s) could not be ordered — cyclic blocked_by among siblings: ${stuck.join(', ')}`)
  }
  return ordered
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/census.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/census.mjs plugins/leave-me-alone/scripts/census.test.mjs
git commit -m "Add census.mjs: order sibling cards by their blocked_by chain"
```

---

### Task 4: flatten a `brd tree` into the census shape

**Files:**
- Modify: `plugins/leave-me-alone/scripts/census.mjs`
- Test: `plugins/leave-me-alone/scripts/census.test.mjs`

**Interfaces:**
- Consumes: `orderSiblings` from Task 3.
- Produces: `findMilestone(roots, needle)` and `flattenMilestone(root)`. `flattenMilestone` returns `{milestoneTitle, stories: [{id, title, status, blockedBy: string[], subtasks: [{id, title, status}]}]}` — the same shape `detect()` produces today, with `id` (a card UUID) replacing `number`.

- [ ] **Step 1: Write the failing test**

```javascript
// append to plugins/leave-me-alone/scripts/census.test.mjs
import { findMilestone, flattenMilestone } from './census.mjs'

const ID = n => `${n}0000000-0000-4000-8000-000000000000`.slice(0, 36)
const node = (n, title, extra = {}) => ({
  id: ID(n), title, status: 'todo', blocked_by: [], created_at: `2026-01-0${n}T00:00:00Z`,
  children: [], ...extra,
})

const TREE = node(1, 'Milestone 12: CSV export', {
  children: [
    node(2, 'Story: CSV writer', {
      children: [node(4, 'feat: write rows'), node(5, 'feat: quoting', { blocked_by: [ID(4)] })],
    }),
    node(3, 'Story: Document it', { blocked_by: [ID(2)], status: 'blocked',
      children: [node(6, 'docs: usage', { status: 'blocked' })] }),
  ],
})

test('findMilestone matches a root card by exact id', () => {
  assert.equal(findMilestone([TREE], ID(1)).title, 'Milestone 12: CSV export')
})

test('findMilestone matches by case-insensitive title substring', () => {
  assert.equal(findMilestone([TREE], 'csv export').id, ID(1))
})

test('findMilestone fails loudly when nothing matches', () => {
  assert.throws(() => findMilestone([TREE], 'nonexistent'), /no milestone card/)
})

test('findMilestone fails loudly on ambiguity rather than guessing', () => {
  const other = node(9, 'Milestone 13: CSV import')
  assert.throws(() => findMilestone([TREE, other], 'csv'), /ambiguous/)
})

test('flattenMilestone produces stories with ordered subtasks', () => {
  const census = flattenMilestone(TREE)
  assert.equal(census.milestoneTitle, 'Milestone 12: CSV export')
  assert.deepEqual(census.stories.map(s => s.title), ['Story: CSV writer', 'Story: Document it'])
  assert.deepEqual(census.stories[0].subtasks.map(s => s.title), ['feat: write rows', 'feat: quoting'])
})

test('story blockedBy carries card ids through', () => {
  assert.deepEqual(flattenMilestone(TREE).stories[1].blockedBy, [ID(2)])
})

test('a derived "blocked" status is read as "todo"', () => {
  // brd projects blocked at read time; readiness is the orchestrator's DAG walk,
  // so blocked must not survive into the census as a distinct state.
  const census = flattenMilestone(TREE)
  assert.equal(census.stories[1].status, 'todo')
  assert.equal(census.stories[1].subtasks[0].status, 'todo')
})

test('in_progress and done are passed through untouched', () => {
  const tree = node(1, 'M', { children: [node(2, 'S', { status: 'done',
    children: [node(3, 'T', { status: 'in_progress' })] })] })
  const story = flattenMilestone(tree).stories[0]
  assert.equal(story.status, 'done')
  assert.equal(story.subtasks[0].status, 'in_progress')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/census.test.mjs`
Expected: FAIL — `findMilestone is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// append to plugins/leave-me-alone/scripts/census.mjs

// brd derives `blocked` at read time from the dependency graph. The orchestrator
// decides readiness with its own DAG walk, and the two can legitimately disagree
// — brd counts a blocker satisfied only at stored status `done`, while a story's
// completeness also involves its subtasks and PR state. So the projection is
// flattened away HERE, in one place, rather than checked for everywhere.
function storedStatus(status) {
  return status === 'blocked' ? 'todo' : status
}

// `--milestone` used to be a small integer. A UUID is not typeable, so a title
// substring is accepted too — but never guessed at: two matches is an error.
export function findMilestone(roots, needle) {
  const wanted = String(needle ?? '').trim()
  const list = roots ?? []
  const byId = list.find(root => root.id === wanted)
  if (byId) return byId

  const lowered = wanted.toLowerCase()
  const matches = list.filter(root => String(root.title ?? '').toLowerCase().includes(lowered))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new Error(`no milestone card matching "${wanted}" — root cards are: ${list.map(r => r.title).join(', ') || '(none)'}`)
  }
  throw new Error(`ambiguous milestone "${wanted}" — matches: ${matches.map(m => m.title).join(', ')}`)
}

export function flattenMilestone(root) {
  const stories = orderSiblings(root.children ?? []).map(story => ({
    id: story.id,
    title: story.title,
    status: storedStatus(story.status),
    blockedBy: story.blocked_by ?? [],
    subtasks: orderSiblings(story.children ?? []).map(subtask => ({
      id: subtask.id,
      title: subtask.title,
      status: storedStatus(subtask.status),
    })),
  }))
  return { milestoneTitle: root.title, stories }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/census.test.mjs`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/census.mjs plugins/leave-me-alone/scripts/census.test.mjs
git commit -m "Add flattenMilestone and findMilestone to census.mjs"
```

---

### Task 5: an integration test against the real `brd`

**Files:**
- Create: `plugins/leave-me-alone/scripts/census.integration.test.mjs`

**Interfaces:**
- Consumes: `brd` from Task 1, `findMilestone`/`flattenMilestone` from Task 4.
- Produces: nothing importable.

This layer was impossible against GitHub. Hand-written route fixtures encode a *belief* about what the source returns, and a wrong belief passes tests while failing in production. brd is local and isolatable, so the census can be checked against the real dependency resolver — including the ancestor inheritance from brd #38.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/scripts/census.integration.test.mjs
// Runs the REAL brd against a throwaway registry. Skipped when brd is absent,
// so the unit suite still runs on a machine without it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brd } from './brd.mjs'
import { findMilestone, flattenMilestone } from './census.mjs'

let hasBrd = true
try { execFileSync('brd', ['--help'], { stdio: 'ignore' }) } catch { hasBrd = false }

let root, repo, env
before(() => {
  if (!hasBrd) return
  root = mkdtempSync(path.join(tmpdir(), 'brd-census-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  env = { ...process.env, XDG_DATA_HOME: path.join(root, 'data') }
})
after(() => { if (root) rmSync(root, { recursive: true, force: true }) })

const brdCli = (...args) => execFileSync('brd', args, { cwd: repo, env, encoding: 'utf8' })
const cli = (...args) => JSON.parse(brdCli(...args)).data
const addCard = (title, opts = []) => cli('add', '--title', title, ...opts).id

test('census matches a real board, including inherited blocking', { skip: !hasBrd && 'brd not installed' }, async () => {
  cli('init', '--name', 'census-demo')
  const milestone = addCard('Milestone 12: CSV export')
  const storyA = addCard('Story: CSV writer', ['--parent', milestone])
  const storyB = addCard('Story: Document it', ['--parent', milestone])
  cli('block', storyB, '--by', storyA)
  const rows = addCard('feat: write rows', ['--parent', storyA])
  addCard('feat: quoting', ['--parent', storyA, '--blocked-by', rows])
  addCard('docs: usage', ['--parent', storyB])

  const roots = await brd(['tree'], { cwd: repo, run: async args => brdCli(...args) })
  const census = flattenMilestone(findMilestone(roots, 'CSV export'))

  assert.deepEqual(census.stories.map(s => s.title), ['Story: CSV writer', 'Story: Document it'])
  assert.deepEqual(census.stories[0].subtasks.map(s => s.title), ['feat: write rows', 'feat: quoting'])
  assert.deepEqual(census.stories[1].blockedBy, [storyA])
  // brd reports docs: usage as `blocked` through its parent; the census flattens
  // that to todo, because readiness is decided by the DAG walk.
  assert.equal(census.stories[1].subtasks[0].status, 'todo')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/census.integration.test.mjs`
Expected: FAIL if `census.mjs` is incomplete; on a machine without brd the test reports as skipped, which is also acceptable.

- [ ] **Step 3: No implementation needed**

Tasks 1-4 already provide everything. If this test fails, the bug is in `census.mjs` or `brd.mjs` — fix it there rather than weakening the assertions.

- [ ] **Step 4: Run the whole suite**

Run: `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/`
Expected: PASS — 175 pre-existing tests plus the new ones, 0 failures

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/census.integration.test.mjs
git commit -m "Add integration test running the census against a real brd board"
```

---

### Task 6: `detect.mjs` reads structure from brd, PRs from gh

**Files:**
- Modify: `plugins/leave-me-alone/scripts/detect.mjs:25-53` (parseArgs), `:97-136` (the census half of `detect`)
- Modify: `plugins/leave-me-alone/scripts/detect.test.mjs:24-35` (BASE_ROUTES) and the `detect` tests
- Test: `plugins/leave-me-alone/scripts/detect.test.mjs`

**Interfaces:**
- Consumes: `brd` (Task 1), `findMilestone`/`flattenMilestone` (Task 4), `refMatchesCard` (Task 2).
- Produces: `detect()` returning `{milestoneTitle, stories, pullRequests, prLookupFailed, prepared}` — unchanged in shape except that stories and subtasks carry `id` instead of `number`.

Keep: `prepareCheckout` (`detect.mjs:71-82`) and the PR listing (`:137-150`) exactly as they are. Only the census changes.

- [ ] **Step 1: Write the failing test**

```javascript
// replace the census-facing tests in plugins/leave-me-alone/scripts/detect.test.mjs
import { detect, parseArgs, filterPullRequests } from './detect.mjs'

const MILESTONE_ID = 'aaaaaaaa-0000-4000-8000-000000000000'
const STORY_ID = 'bbbbbbbb-0000-4000-8000-000000000000'
const SUB_ID = 'cccccccc-0000-4000-8000-000000000000'

const TREE = {
  ok: true,
  data: [{
    id: MILESTONE_ID, title: 'Sprint one', status: 'todo', blocked_by: [],
    created_at: '2026-01-01T00:00:00Z',
    children: [{
      id: STORY_ID, title: 'CSV writer', status: 'todo', blocked_by: [],
      created_at: '2026-01-02T00:00:00Z',
      children: [{
        id: SUB_ID, title: 'write rows', status: 'todo', blocked_by: [],
        created_at: '2026-01-03T00:00:00Z', children: [],
      }],
    }],
  }],
}

const fakeBrd = () => async () => JSON.stringify(TREE)

test('parseArgs takes a milestone as a title or an id, not an integer', () => {
  assert.equal(parseArgs(['--repo', 'a/b', '--milestone', 'Sprint one']).milestone, 'Sprint one')
  assert.equal(parseArgs(['--repo=a/b', `--milestone=${MILESTONE_ID}`]).milestone, MILESTONE_ID)
})

test('parseArgs rejects an empty milestone', () => {
  assert.throws(() => parseArgs(['--repo', 'a/b', '--milestone', '']), /needs --milestone/)
})

test('detect builds its census from brd and its PR list from gh', async () => {
  const ghCalls = []
  const gh = async (args) => {
    ghCalls.push(args.join(' '))
    return '{"number":7,"url":"u7","state":"open","merged_at":null,"ref":"m12/task-write-rows-cccccccc","base":"main"}\n'
  }
  const result = await detect({
    repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
    run: gh, runBrd: fakeBrd(), git: async () => '',
  })

  assert.equal(result.milestoneTitle, 'Sprint one')
  assert.deepEqual(result.stories.map(s => s.id), [STORY_ID])
  assert.deepEqual(result.stories[0].subtasks.map(s => s.id), [SUB_ID])
  // The ONLY gh calls left in the census path are about pull requests.
  assert.ok(ghCalls.every(call => call.includes('pulls')), `unexpected gh calls: ${ghCalls.join(' | ')}`)
})

test('a brd failure stops the run instead of yielding an empty milestone', async () => {
  const failing = async () => '{"ok": false, "error": {"type": "ProjectNotFoundError", "message": "no .brd marker found above /abs/repo"}}'
  await assert.rejects(
    detect({ repo: 'you/thing', milestone: 'Sprint one', repoDir: '/abs/repo',
      run: async () => '', runBrd: failing, git: async () => '' }),
    /ProjectNotFoundError/)
})

test('filterPullRequests matches a subtask by its short id', () => {
  const pulls = [{ ref: 'm12/task-write-rows-cccccccc' }, { ref: 'm12/task-other-dddddddd' }]
  assert.deepEqual(filterPullRequests(pulls, [SUB_ID]).map(p => p.ref), ['m12/task-write-rows-cccccccc'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/detect.test.mjs`
Expected: FAIL — `detect needs --milestone <positive integer>` and unrouted gh calls for `milestones/…`

- [ ] **Step 3: Write minimal implementation**

In `parseArgs`, replace the milestone-integer validation and drop the label flags:

```javascript
export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--repo': 'value', '--milestone': 'value', '--compact': 'boolean', '--repo-dir': 'value',
  })
  const out = { repo: flags['--repo'], milestone: String(flags['--milestone'] ?? '').trim(), compact: flags['--compact'] === true }
  if (typeof out.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
    throw new Error('detect needs --repo owner/name')
  }
  if (out.milestone.length === 0) {
    throw new Error('detect needs --milestone <card id or title substring>')
  }
  const repoDir = flags['--repo-dir']
  if (repoDir !== undefined) {
    if (typeof repoDir !== 'string' || !repoDir.startsWith('/')) {
      throw new Error('detect: --repo-dir must be an absolute path')
    }
    out.repoDir = repoDir
  }
  return out
}
```

Replace the census block (the milestone lookup, story list, and the per-story `blockedBy` + `sub_issues` loop) with:

```javascript
  // One local call replaces a milestone lookup, a story list, and two API calls
  // per story. NOT wrapped in withRetries: brd is local, so a failure is real.
  const roots = await brd(['tree'], { cwd: repoDir, run: runBrd })
  const { milestoneTitle, stories } = flattenMilestone(findMilestone(roots, milestone))
```

Update the signature and the PR filter call:

```javascript
export async function detect({ repo, milestone, repoDir, run = ghRunner, runBrd = brdRunner, git = gitRunner, wait }) {
```

```javascript
    pullRequests = filterPullRequests(all, stories.flatMap(story => story.subtasks.map(sub => sub.id)))
```

And make `filterPullRequests` match on short ids:

```javascript
// Deliberately LOOSE — anything whose branch name contains any subtask's short
// id. The orchestrator matches exactly and separately looks for near misses, so
// over-reporting here is free and under-reporting is not.
export function filterPullRequests(pulls, subtaskIds) {
  const ids = [...new Set((subtaskIds ?? []).map(id => shortId(id)))]
  return (pulls ?? []).filter(pull => {
    const ref = String((pull && pull.ref) ?? '')
    return ids.some(id => ref.includes(id))
  })
}
```

Add the imports at the top of `detect.mjs`:

```javascript
import { brd, brdRunner } from './brd.mjs'
import { findMilestone, flattenMilestone } from './census.mjs'
import { shortId } from './naming.mjs'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/detect.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/detect.mjs plugins/leave-me-alone/scripts/detect.test.mjs
git commit -m "detect: read milestone structure from brd, keep PR state on gh"
```

---

### Task 7: re-key `orchestrator.js` from issue numbers to card ids

**Files:**
- Modify: `plugins/leave-me-alone/workflows/orchestrator.js:33-54` (delete `parseOrdinal`/`orderSubtasks`), `:99-110` (`remainingSubtasks`, `computeLevels`), `:193-235` (`storyTip`, `storyRoot`, `stackBases`), `:425-431` (`attachPullRequests`), `:548` (the `DEFAULT_ORDINAL` constant and `opts.ordinalPattern` read), `:868`, `:914`, `:926-930` (the dry-run table builders)
- Modify: `plugins/leave-me-alone/workflows/orchestrator.test.mjs` — including DELETING the existing `orderSubtasks` tests (around `:40-52`), removing `orderSubtasks` from the import list (`:19`) and from the exported-surface assertion list (`:24`)
- Test: `plugins/leave-me-alone/workflows/orchestrator.test.mjs`

**Scope note (pre-flight ruling):** `ordinalPattern` and `storiesByNumber` thread through more of this file than a first reading suggests — every site listed above. Grep for both names and for `story.number` / `subtask.number` before declaring the task done; a partial re-key produces branches literally named `task-undefined` rather than an error. `attachPullRequests` must match PRs by short id, consistent with `filterPullRequests` from Task 6.

**Interfaces:**
- Consumes: the census shape from Task 4 (`story.id`, `story.blockedBy` as card ids, `story.subtasks[].id`), plus `taskBranch` from Task 2.
- Produces: unchanged exported graph functions, now keyed by card id.

The graph logic itself does not change — it already operates on a generic shape and never touches an API. What changes is the key type (string UUID, not integer), the removal of ordinal sorting (the census now arrives pre-ordered), and branch derivation.

- [ ] **Step 1: Write the failing test**

```javascript
// in plugins/leave-me-alone/workflows/orchestrator.test.mjs
const A = 'aaaaaaaa-0000-4000-8000-000000000000'
const B = 'bbbbbbbb-0000-4000-8000-000000000000'
const S1 = '11111111-0000-4000-8000-000000000000'
const S2 = '22222222-0000-4000-8000-000000000000'
const S3 = '33333333-0000-4000-8000-000000000000'

const STORIES = [
  { id: A, title: 'CSV writer', status: 'todo', blockedBy: [],
    subtasks: [{ id: S1, title: 'write rows', status: 'todo' },
               { id: S2, title: 'quoting', status: 'todo' }] },
  { id: B, title: 'Document it', status: 'todo', blockedBy: [A],
    subtasks: [{ id: S3, title: 'usage', status: 'todo' }] },
]

test('levels come from story blockedBy, keyed by card id', () => {
  const levels = computeLevels(STORIES)
  assert.deepEqual(levels.map(level => level.map(s => s.id)), [[A], [B]])
})

test('subtasks keep the order the census gave them — no re-sorting by title', () => {
  // Titles carry no ordinal any more; the census already ordered these by
  // their blocked_by chain, so the orchestrator must not reorder them.
  assert.deepEqual(remainingSubtasks(STORIES[0]).map(s => s.id), [S1, S2])
})

test('a story stacks on the previous subtask branch, and a blocked story on its blocker tip', () => {
  const byId = new Map(STORIES.map(s => [s.id, s]))
  assert.equal(storyRoot(STORIES[0], byId, 'm12', 'main'), 'main')
  assert.equal(storyTip(STORIES[0], byId, 'm12', 'main'), 'm12/task-quoting-22222222')
  assert.equal(storyRoot(STORIES[1], byId, 'm12', 'main'), 'm12/task-quoting-22222222')
})

test('two blockers still stop the run rather than guessing a root', () => {
  const byId = new Map(STORIES.map(s => [s.id, s]))
  const greedy = { ...STORIES[1], blockedBy: [A, 'cccccccc-0000-4000-8000-000000000000'] }
  assert.throws(() => storyRoot(greedy, byId, 'm12', 'main'), /one blocker/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: FAIL — the existing functions expect `number` and an `ordinalPattern` argument

- [ ] **Step 3: Write minimal implementation**

Delete `parseOrdinal` and `orderSubtasks` (`orchestrator.js:33-54`) entirely, then drop the `ordinalPattern` parameter from every signature that threads it through (`remainingSubtasks`, `computeLevels`, `storyTip`, `storyRoot`, `stackBases`). Replace each `orderSubtasks(x, ordinalPattern)` call with `x` — the census arrives ordered.

Re-key the lookup map and derive branches from the card:

```javascript
import { taskBranch } from '../scripts/naming.mjs'

function remainingSubtasks(story) {
  return (story.subtasks ?? []).filter(subtask => !isSubtaskDone(subtask))
}

function storyTip(story, storiesById, branchPrefix, baseBranch, seen = new Set()) {
  const ordered = story.subtasks ?? []
  if (ordered.length > 0) return taskBranch(branchPrefix, ordered[ordered.length - 1])
  return storyRoot(story, storiesById, branchPrefix, baseBranch, seen)
}
```

Keep the existing two-blocker guard and the `seen` cycle guard exactly as they are; only the key type changes. Rename `storiesByNumber` to `storiesById` throughout, and replace every `story.number` with `story.id` and every `subtask.number` with `subtask.id`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/workflows/orchestrator.js plugins/leave-me-alone/workflows/orchestrator.test.mjs
git commit -m "orchestrator: key the story graph by card id, drop ordinal sorting"
```

---

### Task 8: delete `resolve.mjs` and correct the docs it is named in

**Files:**
- Delete: `plugins/leave-me-alone/scripts/resolve.mjs`, `plugins/leave-me-alone/scripts/resolve.test.mjs`
- Modify: `plugins/leave-me-alone/workflows/README.md:45-60`, `README.md:20-29`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

`resolve.mjs` exists only to translate a project number into GitHub's opaque GraphQL node ids. brd uses one id type everywhere, so the concept has no successor.

- [ ] **Step 1: Confirm nothing still imports it, and clear the one live reference**

Run: `grep -rn "resolve.mjs\|resolveProject\|projectScript" plugins/ README.md`

Expected live references: `orchestrator.js:608-609` (reads `opts.projectScript`) and `orchestrator.js:768-772` (an error branch telling the caller to pass a path to `scripts/resolve.mjs`). Nothing imports the module — these are an options read and an error message.

**Pre-flight ruling:** clear both here rather than leaving a guard that points at a deleted file. Delete the `projectScript` options read, and keep the guard at `:768` but change its remedy text to say the board ids must be passed explicitly as a resolved `{id, fieldId, optionIds}` block, because no resolver exists any more. **Do not delete the guard itself** — without it, a `project` given as a number would proceed with unresolved ids and fail later and worse.

Leave the `project` argument and `task.js`'s board consumption alone: `task.js` still needs board ids until Phase 2 rewrites its status block. If you find a reference in `task.js`, leave it untouched — that is Phase 2's, and it is not a reason to stop.

- [ ] **Step 2: Delete the files**

```bash
git rm plugins/leave-me-alone/scripts/resolve.mjs plugins/leave-me-alone/scripts/resolve.test.mjs
```

- [ ] **Step 3: Correct the documentation**

In `plugins/leave-me-alone/workflows/README.md`, remove the `resolve.mjs` row from the scripts table, drop the `projectScript` argument line, and change the `detect.mjs` row to read: `the whole milestone census from brd (one \`brd tree\`), plus the PR listing from gh. Also does the ONE git fetch + worktree prune for the run`.

In the root `README.md`, delete the paragraph requiring `gh auth status` to show the **`project`** scope and the `gh auth refresh -s project,read:project` snippet — no board access is needed any more. Add `brd` to the list of required tools alongside `bun`, `gh` and `git`.

- [ ] **Step 4: Run the whole suite**

Run: `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/`
Expected: PASS, 0 failures, and no test file missing

- [ ] **Step 5: Commit**

```bash
git add -A plugins/leave-me-alone/ README.md
git commit -m "Delete resolve.mjs: brd ids need no node-id translation"
```

---

## Phase 1 exit criteria

- `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/` is green.
- `detect.mjs` makes no `gh` call about milestones, issues, sub-issues or `blockedBy` — only about pull requests. Verify with:
  `grep -nE "milestones/|issue list|sub_issues|blockedBy" plugins/leave-me-alone/scripts/detect.mjs` returning nothing.
- The integration test builds a real brd board and the census matches it.

**Not in this phase, by design:** `task.js` (its status mutations, artifact paths and `plan-check`), the snapshot writer, `auto-allow.sh`, and the three setup skills. Those are Phases 2 and 3. Phase 1 leaves `task.js` untouched and therefore still GitHub-keyed — the milestone is not runnable end to end until Phase 2 lands.
