# brd Migration — Phase 2: the workflows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `task.js` drive a brd card instead of a GitHub issue, so a milestone becomes runnable end to end again.

**Architecture:** The status machinery moves out of a prompt and into a deterministic script (`rollup.mjs`), joining `detect.mjs`/`ship.mjs`/`plan-check.mjs`. `task.js` stops deriving its own branch — the orchestrator already computes one, so it is passed in, leaving exactly one derivation. Artifact filenames key off that branch's stem rather than an issue number. The GitHub Projects board block disappears entirely from both workflows, which is what finally retires the `gh` `project` scope.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, `bun` as the script runtime, `brd`.

**Spec:** `docs/superpowers/specs/2026-09-17-brd-migration-design.md`
**Predecessor:** `docs/superpowers/plans/2026-09-17-brd-migration-phase-1-data-layer.md` (merged as PR #45)

## Global Constraints

- **Tests run with `node --test`, never `bun test`.** Suite stands at **201 passing, 0 failures** at the start of this phase.
- **Every brd call asserts `ok === true` and throws otherwise. No call ever degrades to `[]`.** Use `brd()` from `scripts/brd.mjs`.
- **brd calls are never retried.** `withRetries` remains for `gh` only.
- **`blocked` is never written, and on read means `todo`.**
- **Anything that MATCHES a card keys on its 8-character short id, never on a slug or title.** A title can be edited after a PR is open.
- **A Workflow script (`task.js`, `orchestrator.js`) executes in a sandbox with NO module resolution.** An `import` in either breaks it at launch, and no unit test catches that because the harness slices the `PURE` region out rather than loading the file. Anything shared must be **inlined inside the `PURE` markers**, exactly as `orchestrator.js:36-62` already mirrors `naming.mjs`. Deterministic `scripts/*.mjs` files are NOT Workflow scripts and may import freely.
- **`done` means the subtask's PR has been opened.** A run never merges, so that is the furthest state it can honestly report. There is no `in_review`.

---

### Task 1: `rollup.mjs` — the pure rollup rule

**Files:**
- Create: `plugins/leave-me-alone/scripts/rollup.mjs`
- Test: `plugins/leave-me-alone/scripts/rollup.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `storedStatus(status)` and `rollupStatus(children)`. `children` are `brd tree` nodes (`{status, …}`); returns `'todo' | 'in_progress' | 'done' | null`, where `null` means "no children, nothing to roll up".

This is the rule currently written as English prose inside a prompt at `task.js:402` (and duplicated verbatim at `:406`). It is preserved exactly — by *progress*, not by the least-advanced sibling.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/scripts/rollup.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storedStatus, rollupStatus } from './rollup.mjs'

const kid = status => ({ status })

test('blocked reads as todo, everything else passes through', () => {
  assert.equal(storedStatus('blocked'), 'todo')
  assert.equal(storedStatus('todo'), 'todo')
  assert.equal(storedStatus('in_progress'), 'in_progress')
  assert.equal(storedStatus('done'), 'done')
})

test('a card with no children rolls up nothing', () => {
  assert.equal(rollupStatus([]), null)
  assert.equal(rollupStatus(undefined), null)
})

test('every child todo means todo', () => {
  assert.equal(rollupStatus([kid('todo'), kid('todo')]), 'todo')
})

test('every child done means done', () => {
  assert.equal(rollupStatus([kid('done'), kid('done')]), 'done')
  assert.equal(rollupStatus([kid('done')]), 'done')
})

test('any mix means in_progress — by progress, not by the least-advanced sibling', () => {
  assert.equal(rollupStatus([kid('todo'), kid('done')]), 'in_progress')
  assert.equal(rollupStatus([kid('todo'), kid('in_progress')]), 'in_progress')
  // The one that makes "by progress" concrete: a done sibling does not win.
  assert.equal(rollupStatus([kid('done'), kid('in_progress')]), 'in_progress')
})

test('a blocked child counts as todo, not as a fourth state', () => {
  assert.equal(rollupStatus([kid('blocked'), kid('todo')]), 'todo')
  assert.equal(rollupStatus([kid('blocked')]), 'todo')
  assert.equal(rollupStatus([kid('blocked'), kid('done')]), 'in_progress')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/rollup.test.mjs`
Expected: FAIL — `Cannot find module './rollup.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// plugins/leave-me-alone/scripts/rollup.mjs
// A card's status, rolled up its ancestry.
//
// This rule used to live as English prose inside a prompt, with the GraphQL
// mutations to carry it out interpolated into the same string — the last place
// in the pipeline where a model was handed a shell and asked to follow
// instructions exactly. brd's ids are short enough that it can be code.

// brd derives `blocked` at read time and refuses to store it. The orchestrator
// decides readiness from its own DAG walk, so `blocked` is flattened here the
// same way census.mjs flattens it: one place, not a check at every comparison.
export function storedStatus(status) {
  return status === 'blocked' ? 'todo' : status
}

// By PROGRESS, not by the least-advanced sibling: one done child among
// unstarted ones means the parent is under way, not unstarted.
export function rollupStatus(children) {
  const statuses = (children ?? []).map(child => storedStatus(child && child.status))
  if (statuses.length === 0) return null
  if (statuses.every(status => status === 'todo')) return 'todo'
  if (statuses.every(status => status === 'done')) return 'done'
  return 'in_progress'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/rollup.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/rollup.mjs plugins/leave-me-alone/scripts/rollup.test.mjs
git commit -m "Add rollup.mjs: the parent-status rule, as code rather than prompt prose"
```

---

### Task 2: `rollup.mjs` — the walk up the tree

**Files:**
- Modify: `plugins/leave-me-alone/scripts/rollup.mjs`
- Test: `plugins/leave-me-alone/scripts/rollup.test.mjs`

**Interfaces:**
- Consumes: `brd`, `brdRunner` from `./brd.mjs`; `rollupStatus`, `storedStatus` from Task 1.
- Produces: `parseArgs(argv)` and `rollup({card, status, cwd, run})` → an array of `{card, status}` describing every write it made, in order.

- [ ] **Step 1: Write the failing test**

```javascript
// append to plugins/leave-me-alone/scripts/rollup.test.mjs
import { parseArgs, rollup } from './rollup.mjs'

const SUB = 'aaaaaaaa-0000-4000-8000-000000000000'
const STORY = 'bbbbbbbb-0000-4000-8000-000000000000'
const MILE = 'cccccccc-0000-4000-8000-000000000000'

// A fake brd: routes on a distinctive fragment of the argv it is handed.
const fakeBrd = (routes, log = []) => {
  const run = async (args) => {
    log.push(args.join(' '))
    for (const [needle, reply] of routes) {
      if (args.join(' ').includes(needle)) {
        return JSON.stringify({ ok: true, data: typeof reply === 'function' ? reply() : reply })
      }
    }
    throw new Error(`unrouted brd call: ${args.join(' ')}`)
  }
  run.log = log
  return run
}

test('parseArgs requires a card and a status', () => {
  const ok = parseArgs(['--card', SUB, '--status', 'done', '--repo-dir', '/abs/repo'])
  assert.equal(ok.card, SUB)
  assert.equal(ok.status, 'done')
  assert.throws(() => parseArgs(['--status', 'done']), /needs --card/)
  assert.throws(() => parseArgs(['--card', SUB]), /needs --status/)
})

test('refuses to write blocked — it is derived, never stored', () => {
  assert.throws(() => parseArgs(['--card', SUB, '--status', 'blocked']), /derived/)
})

test('writes the card, then the parent when the rollup changes it', async () => {
  let subStatus = 'todo'
  const run = fakeBrd([
    [`update ${SUB}`, () => { subStatus = 'done'; return { id: SUB } }],
    [`show ${SUB}`, () => ({ id: SUB, parent_id: STORY })],
    [`tree ${STORY}`, () => [{ id: STORY, status: 'in_progress', children: [{ id: SUB, status: subStatus }] }]],
    [`update ${STORY}`, { id: STORY }],
    [`show ${STORY}`, { id: STORY, parent_id: null }],
  ])
  const written = await rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run })
  assert.deepEqual(written, [{ card: SUB, status: 'done' }, { card: STORY, status: 'done' }])
})

test('stops walking as soon as a parent does not change', async () => {
  // The story stays in_progress because a sibling is still todo. The milestone
  // therefore cannot have changed either, so it must never be read or written.
  const run = fakeBrd([
    [`update ${SUB}`, { id: SUB }],
    [`show ${SUB}`, { id: SUB, parent_id: STORY }],
    [`tree ${STORY}`, [{ id: STORY, status: 'in_progress',
      children: [{ id: SUB, status: 'done' }, { id: 'other', status: 'todo' }] }]],
  ])
  const written = await rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run })
  assert.deepEqual(written, [{ card: SUB, status: 'done' }])
  assert.ok(!run.log.some(call => call.includes(MILE)), `walked too far: ${run.log.join(' | ')}`)
})

test('a brd failure aborts rather than leaving a half-written ancestry', async () => {
  const run = async () => '{"ok": false, "error": {"type": "CardNotFoundError", "message": "no card"}}'
  await assert.rejects(rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run }), /CardNotFoundError/)
})

test('every brd call is given the repo-dir as cwd', async () => {
  const seen = []
  const run = async (args, opts) => {
    seen.push(opts && opts.cwd)
    return JSON.stringify({ ok: true, data: args[0] === 'show' ? { parent_id: null } : { id: SUB } })
  }
  await rollup({ card: SUB, status: 'in_progress', cwd: '/abs/repo', run })
  assert.ok(seen.length > 0 && seen.every(cwd => cwd === '/abs/repo'), `cwds: ${JSON.stringify(seen)}`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/rollup.test.mjs`
Expected: FAIL — `parseArgs is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// append to plugins/leave-me-alone/scripts/rollup.mjs
import { brd, brdRunner } from './brd.mjs'
import { readFlags } from './gh.mjs'

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--card': 'value', '--status': 'value', '--repo-dir': 'value', '--compact': 'boolean',
  })
  const out = {
    card: String(flags['--card'] ?? '').trim(),
    status: String(flags['--status'] ?? '').trim(),
    cwd: flags['--repo-dir'],
    compact: flags['--compact'] === true,
  }
  if (out.card.length === 0) throw new Error('rollup needs --card <card id>')
  if (out.status.length === 0) throw new Error('rollup needs --status <todo|in_progress|done>')
  // brd rejects this too, but failing here names the caller's mistake rather
  // than surfacing it as a CLI error three frames away.
  if (out.status === 'blocked') {
    throw new Error('rollup: "blocked" is derived from the dependency graph and is never stored')
  }
  if (typeof out.cwd !== 'string' || !out.cwd.startsWith('/')) {
    throw new Error('rollup needs --repo-dir <absolute path>')
  }
  return out
}

// Set a card's status, then walk upward recomputing each ancestor.
//
// Read-then-write per level rather than writing blind: sibling stories run in
// parallel lanes, so this process's view of a shared ancestor can be stale by
// the time it gets here. A parent that does not change ends the walk — if the
// parent's status is unchanged, nothing above it can have changed either.
export async function rollup({ card, status, cwd, run = brdRunner }) {
  const written = []
  await brd(['update', card, '--status', status], { cwd, run })
  written.push({ card, status })

  let child = card
  for (;;) {
    const detail = await brd(['show', child], { cwd, run })
    const parent = detail && detail.parent_id
    if (!parent) return written

    const tree = await brd(['tree', parent], { cwd, run })
    const node = Array.isArray(tree) ? tree[0] : tree
    const target = rollupStatus(node && node.children)
    if (target === null || storedStatus(node.status) === target) return written

    await brd(['update', parent, '--status', target], { cwd, run })
    written.push({ card: parent, status: target })
    child = parent
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const written = await rollup(options)
  process.stdout.write(`${options.compact ? JSON.stringify(written) : JSON.stringify(written, null, 2)}\n`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/rollup.test.mjs`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/rollup.mjs plugins/leave-me-alone/scripts/rollup.test.mjs
git commit -m "rollup: walk a card's ancestry, writing only what actually changes"
```

---

### Task 3: prove the rollup against a real brd board

**Files:**
- Create: `plugins/leave-me-alone/scripts/rollup.integration.test.mjs`

**Interfaces:**
- Consumes: `rollup` from Task 2.
- Produces: nothing importable.

Fakes prove the walk's shape; only the real CLI proves the rule agrees with how brd actually stores and derives status. Follow the pattern in `census.integration.test.mjs` exactly — `execFileSync` with an isolated `XDG_DATA_HOME`, skip when `brd` is absent, clean up the temp directory in a file-level `after` hook.

- [ ] **Step 1: Write the failing test**

```javascript
// plugins/leave-me-alone/scripts/rollup.integration.test.mjs
// Runs the REAL brd against a throwaway registry. Skipped when brd is absent.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rollup } from './rollup.mjs'

let hasBrd = true
try { execFileSync('brd', ['--help'], { stdio: 'ignore' }) } catch { hasBrd = false }

let root, repo, env
before(() => {
  if (!hasBrd) return
  root = mkdtempSync(path.join(tmpdir(), 'brd-rollup-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  env = { ...process.env, XDG_DATA_HOME: path.join(root, 'data') }
})
after(() => { if (root) rmSync(root, { recursive: true, force: true }) })

test('a subtask going done rolls its story and milestone up on a real board',
  { skip: !hasBrd && 'brd not installed' }, async () => {
    const brdCli = (...args) => execFileSync('brd', args, { cwd: repo, env, encoding: 'utf8' })
    const cli = (...args) => JSON.parse(brdCli(...args)).data
    const run = async args => brdCli(...args)

    cli('init', '--name', 'rollup-demo')
    const milestone = cli('add', '--title', 'Milestone').id
    const story = cli('add', '--title', 'Story', '--parent', milestone).id
    const first = cli('add', '--title', 'first', '--parent', story).id
    const second = cli('add', '--title', 'second', '--parent', story, '--blocked-by', first).id

    // One of two subtasks done: story is under way, milestone with it.
    await rollup({ card: first, status: 'done', cwd: repo, run })
    assert.equal(cli('show', story).status, 'in_progress')
    assert.equal(cli('show', milestone).status, 'in_progress')

    // Both done: story done, and the milestone follows.
    await rollup({ card: second, status: 'done', cwd: repo, run })
    assert.equal(cli('show', story).status, 'done')
    assert.equal(cli('show', milestone).status, 'done')
  })
```

- [ ] **Step 2: Run test to verify it fails or passes honestly**

Run: `node --test plugins/leave-me-alone/scripts/rollup.integration.test.mjs`
Expected: PASS if Tasks 1-2 are correct. `brd` IS installed on this machine, so confirm it **ran** rather than skipped — a skipped test is not evidence. If it fails, the bug is in `rollup.mjs`; fix it there rather than weakening an assertion.

- [ ] **Step 3: No implementation needed**

Tasks 1-2 provide everything.

- [ ] **Step 4: Run the whole suite**

Run: `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/`
Expected: PASS, 0 failures

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/rollup.integration.test.mjs
git commit -m "Add integration test: rollup against a real brd board"
```

---

### Task 4: re-key `plan-check.mjs` to the card's short id

**Files:**
- Modify: `plugins/leave-me-alone/scripts/plan-check.mjs:18-48`
- Modify: `plugins/leave-me-alone/scripts/plan-check.test.mjs` (all six tests use integers)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseArgs` taking `--card <8 hex>`, and `matchesCard(filename, shortId)` replacing `matchesIssue`.

Plan files are now named `task-<slug>-<shortid>.md` (Task 6 changes the writer). The existing anti-collision property must survive: one card's plan must never answer for another's. That property currently comes from an exact-suffix check plus a non-digit boundary (`plan-check.mjs:46-47`) — the boundary test is the wrong anchor for hex, since a hex id can legitimately be preceded by `a`-`f`.

- [ ] **Step 1: Write the failing test**

```javascript
// replace the integer-keyed tests in plugins/leave-me-alone/scripts/plan-check.test.mjs
import { parseArgs, matchesCard, pickPlan } from './plan-check.mjs'

test('parseArgs takes an 8-character hex card id', () => {
  assert.equal(parseArgs(['--repo-dir', '/abs/repo', '--card', 'a32af745']).card, 'a32af745')
  assert.throws(() => parseArgs(['--repo-dir', '/abs/repo', '--card', '42']), /--card/)
  assert.throws(() => parseArgs(['--repo-dir', '/abs/repo']), /--card/)
})

test('a plan matches when the short id is its final segment', () => {
  assert.equal(matchesCard('task-write-rows-a32af745.md', 'a32af745'), true)
  assert.equal(matchesCard('task-a32af745.md', 'a32af745'), true)
})

test('one card\'s plan never answers for another', () => {
  // The hazard the old non-digit boundary could not express: hex ids may be
  // preceded by hex characters.
  assert.equal(matchesCard('task-deadbeefa32af745.md', 'a32af745'), false)
  assert.equal(matchesCard('task-rows-a32af746.md', 'a32af745'), false)
  assert.equal(matchesCard('task-rows-a32af745-old.md', 'a32af745'), false)
})

test('only .md files match', () => {
  assert.equal(matchesCard('task-rows-a32af745.txt', 'a32af745'), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/plan-check.test.mjs`
Expected: FAIL — `matchesCard is not a function`, plus `--issue <positive integer>` rejections

- [ ] **Step 3: Write minimal implementation**

Replace the `--issue` flag and its integer validation with `--card`, validated as exactly 8 hex characters, and replace `matchesIssue` with:

```javascript
// The short id is the LAST dash-delimited segment of the stem, so a longer hex
// run ending in the same 8 characters cannot match. The old check tested that
// the preceding character was not a digit, which is the wrong anchor for hex —
// `deadbeefa32af745` would have slipped through it.
export function matchesCard(filename, card) {
  if (!filename.endsWith('.md')) return false
  const stem = filename.slice(0, -'.md'.length)
  return stem.split('-').pop() === card
}
```

Update `pickPlan` and the CLI entry point to call `matchesCard` with `options.card`, keeping the newest-wins sort.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/plan-check.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/plan-check.mjs plugins/leave-me-alone/scripts/plan-check.test.mjs
git commit -m "plan-check: key on the card's short id, anchored on the final segment"
```

---

### Task 5: `ship.mjs` takes a card and a title

**Files:**
- Modify: `plugins/leave-me-alone/scripts/ship.mjs:38-47` (args), `:63-65` (delete `titleFromIssue`), `:67-75` (`buildBody`), `:123-125` (delete the `gh issue view` lookup)
- Modify: `plugins/leave-me-alone/scripts/ship.test.mjs:5,9,10,26-29,32-36,91,156-161`

**Interfaces:**
- Consumes: nothing new.
- Produces: `--card <shortid>` and a now-**required** `--title`; `buildBody(commitLines, card)` writing a `brd card:` reference.

`ship.mjs` already supports `--title` as a bypass that skips the issue lookup (tested at `ship.test.mjs:156-161`). That bypass becomes the only path: the caller has the card title in hand, so the round trip is pure cost.

`titleFromIssue` strips an ordinal prefix — a convention Phase 1 retired. Delete it rather than carrying a regex that now only mangles legitimate titles beginning with a number.

`Closes #<issue>` has nothing to close: merging a PR cannot affect a brd card, and `done` already means "PR opened". Replace it with a plain reference, which is greppable and honest about what merging does.

- [ ] **Step 1: Write the failing test**

```javascript
// in plugins/leave-me-alone/scripts/ship.test.mjs
const ARGS = ['--repo=o/n', '--card=a32af745', '--title=feat: write rows',
  '--branch=m12/task-write-rows-a32af745', '--base=main', '--worktree=/wt', '--verify=npm test']

test('parseArgs takes a card short id and a required title', () => {
  assert.equal(parseArgs(ARGS).card, 'a32af745')
  assert.equal(parseArgs(ARGS).title, 'feat: write rows')
  assert.throws(() => parseArgs(ARGS.filter(a => !a.startsWith('--title'))), /--title/)
  assert.throws(() => parseArgs(ARGS.filter(a => !a.startsWith('--card'))), /--card/)
})

test('the PR body references the card without implying a merge closes it', () => {
  const body = buildBody(['feat: write rows'], 'a32af745')
  assert.match(body, /brd card: a32af745/)
  assert.doesNotMatch(body, /Closes #/)
})

test('the title is used verbatim — ordinal prefixes are no longer a convention', async () => {
  // Use this file's OWN existing fake-runner helper and its call-log
  // convention — do not introduce a new one. A title beginning with digits is
  // the case the deleted titleFromIssue regex would have mangled.
  const { run, log } = <the fake this file already uses, constructed its usual way>
  await ship({ ...parseArgs(ARGS), title: '1.2 feat: quoting', run })
  const created = log.find(call => call.includes('pr create'))
  assert.match(created, /1\.2 feat: quoting/)
  assert.ok(!log.some(call => call.includes('issue view')), `looked the title up: ${log.join(' | ')}`)
})
```

The angle-bracket line above is the one place in this plan you must adapt rather than transcribe: `ship.test.mjs` already has a fake `gh` runner with a call log, and this test must use it. Read the file, use what is there, and do not add a second fake alongside it.

Keep every existing test that covers behavior this task does not change — the verification gate, the clean-tree check, push ordering, and the no-retry-on-mutation rule.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/ship.test.mjs`
Expected: FAIL — `--issue <positive integer>` and `Closes #`

- [ ] **Step 3: Write minimal implementation**

Swap `--issue` for `--card` (a non-empty string), make `--title` required, delete `titleFromIssue` and the `gh issue view` branch, and change `buildBody`'s trailer:

```javascript
export function buildBody(commitLines, card) {
  return [
    ...commitLines,
    '',
    // NOT "Closes" — merging a PR does not and cannot change a brd card, and
    // the card is already `done` by the time this body is written, because
    // done means the PR is open.
    `brd card: ${card}`,
  ].join('\n')
}
```

Preserve the existing trailer lines the file already appends below this.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/ship.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/ship.mjs plugins/leave-me-alone/scripts/ship.test.mjs
git commit -m "ship: take a card and a title, reference the card without implying closure"
```

---

### Task 6: `task.js` identity — card in, branch in, artifacts from the branch

**Files:**
- Modify: `plugins/leave-me-alone/workflows/task.js:168-180` (args), `:218-220` (BRANCH/WORKTREE), `:239-257` (artifact paths), `:558` (plan-check call), `:910` (ship call), plus every label/prose/payload site listed below
- Modify: `plugins/leave-me-alone/workflows/task.test.mjs`

**Interfaces:**
- Consumes: `branch` and `card` as arguments.
- Produces: a `task.js` whose identity is a card UUID and whose branch is given, not derived.

**The single most important decision in this task:** `task.js` no longer derives its branch. `orchestrator.js:978` already computes it with `subtaskBranch`, and two derivations of the same name is precisely the drift the Phase 1 review warned about. `branch` becomes a required argument.

The artifact stem comes from that branch — `m12/task-write-rows-a32af745` → `task-write-rows-a32af745` — so no title lookup is needed to name files:

```javascript
const BRANCH = requireArg('branch')
const STEM = BRANCH.split('/').pop()
const PLAN_PATH = `${plansDir}/${STEM}.md`
const SPEC_PATH = `${specsDir}/${STEM}-design.md`
```

Replace `issue` with `card` throughout. Group the sites by what each actually needs, per the survey:
- **Validation** (`:172`, `:176-179`): delete the `Number()` coercion and the positive-integer guard; require a non-empty string.
- **Branch/worktree** (`:218-220`): as above.
- **Filenames** (`:256-257`): as above.
- **Script calls**: `plan-check --card <shortid>` (`:558`), `ship --card <shortid> --title <card title>` (`:910`).
- **Human-readable labels and prose** (`:432`, `:443-444`, `:475`, `:522`, `:561`, `:586`, `:601`, `:610`, `:626`, `:638`, `:663`, `:695`, `:714`, `:728`, `:739`, `:759`, `:779`, `:805`, `:833`, `:918`): use the short id — a UUID in a log line is noise.
- **Escalation payloads** (`:460`, `:472`, `:492`, `:502`, `:535`, `:543`, `:631`, `:679`, `:689`, `:733`, `:798`, `:849`, `:859`, `:880`, `:933`, `:943`, `:950`, `:954`): carry the full card id, since those are consumed by the orchestrator.

**Delete the `gh issue comment` escalation posts** (`:711`, `:727`, `:767`). There is no issue to comment on, and appending to the card's `description` would overwrite the subtask's spec context (`brd update --description` replaces). The escalation payload plus the orchestrator's full stop is the mechanism; say so in a comment where the calls were, so a reader knows it was removed deliberately rather than lost.

Inline `shortId` inside `task.js`'s `PURE` region, mirroring `orchestrator.js:36-62` — **not** an import, which would break the workflow at launch.

- [ ] **Step 1: Write the failing test**

```javascript
// in plugins/leave-me-alone/workflows/task.test.mjs — add to the loadPure name list: 'shortId'
test('the inlined shortId matches the real naming.mjs', async () => {
  const { shortId } = await loadPure()
  const { shortId: real } = await import('../scripts/naming.mjs')
  const id = 'a32af745-15ef-45cd-b52c-64c19ae82c17'
  assert.equal(shortId(id), real(id))
  assert.throws(() => shortId('nope'))
  assert.throws(() => real('nope'))
})

test('the artifact stem comes from the branch, so it cannot disagree with it', async () => {
  const { stemOf } = await loadPure()
  assert.equal(stemOf('m12/task-write-rows-a32af745'), 'task-write-rows-a32af745')
  assert.equal(stemOf('task-a32af745'), 'task-a32af745')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/workflows/task.test.mjs`
Expected: FAIL — `shortId` and `stemOf` are not in the pure region

- [ ] **Step 3: Write minimal implementation**

Add `shortId` (mirrored from `naming.mjs`, with the same strict UUID validation) and `stemOf(branch)` to `task.js`'s `PURE` region, then make the identity changes listed above.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/workflows/task.test.mjs`, then the full suite
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/workflows/task.js plugins/leave-me-alone/workflows/task.test.mjs
git commit -m "task: drive a brd card, take the branch as given, name artifacts from it"
```

---

### Task 7: `task.js` status — delete the prompt-embedded GraphQL

**Files:**
- Modify: `plugins/leave-me-alone/workflows/task.js:375-423` (delete `boardMoveInstructions` entirely), `:338` (`DEFAULT_OPTION_NAMES`), `:340-359` (`resolveProject`, `board`, `optionNames`), `:283` (the `project` argument), `:441` and `:917` (the two call sites)

**Interfaces:**
- Consumes: `scripts/rollup.mjs` via a trigger step.
- Produces: a `task.js` with no GraphQL in it.

This is the change the whole migration was for. `boardMoveInstructions` builds GraphQL mutation strings, interpolates them into a natural-language prompt, and asks an agent to run them verbatim and then reason out a parent rollup — the last place in the pipeline where a model is handed a shell and asked to follow instructions exactly. `detect.mjs:1-13` documents what that cost when it was done elsewhere.

Both call sites become deterministic trigger steps:

```
bun ${scriptsDir}/rollup.mjs --card ${card} --status in_progress --repo-dir ${repoDir} --compact
```

- Explore tail (`:441`): `in_progress`, unchanged in intent.
- Ship tail (`:917`): **`done`, not `in_review`.** Per the spec, `done` means the PR is open, and `in_review` has no occupant — a run never merges, so it cannot observe anything later than "shipped".

Delete `DEFAULT_OPTION_NAMES`, `resolveProject`, `board`, `optionNames` and the `project` argument. Nothing in `task.js` touches a GitHub Projects board afterwards.

- [ ] **Step 1: Write the failing test**

```javascript
// in plugins/leave-me-alone/workflows/task.test.mjs
import { readFileSync } from 'node:fs'

test('no GraphQL survives anywhere in task.js', () => {
  const source = readFileSync(new URL('./task.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /updateProjectV2ItemFieldValue|projectItems|fieldValueByName/,
    'a board mutation is still being built here')
  assert.doesNotMatch(source, /api graphql/, 'a graphql call is still being built here')
})

test('the board argument and its option names are gone', () => {
  const source = readFileSync(new URL('./task.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /DEFAULT_OPTION_NAMES|resolveProject|statusField/)
})
```

These are source-level assertions rather than behavioral ones, which is unusual and deliberate: the thing being removed is a *string built for an agent to execute*, and the risk is that it survives somewhere the pure-region tests cannot see.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/workflows/task.test.mjs`
Expected: FAIL — the mutation builders are still present

- [ ] **Step 3: Write minimal implementation**

Delete the block and replace both call sites with the trigger step above.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/leave-me-alone/workflows/task.test.mjs`, then the full suite
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/workflows/task.js plugins/leave-me-alone/workflows/task.test.mjs
git commit -m "task: move the status rollup out of a prompt and into rollup.mjs"
```

---

### Task 8: wire the orchestrator to the new contract, and retire the board

**Files:**
- Modify: `plugins/leave-me-alone/workflows/orchestrator.js:1001-1011` (the dispatch), `:772-821` (the whole `project` block and its guard), `:2-8` (`meta`)
- Modify: `plugins/leave-me-alone/workflows/orchestrator.test.mjs`
- Modify: `README.md`, `plugins/leave-me-alone/workflows/README.md`, `plugins/leave-me-alone/skills/task/…` if a description references the board

**Interfaces:**
- Consumes: `task.js`'s new `card` + `branch` contract.
- Produces: a dispatch passing both, and an orchestrator with no board concept.

The orchestrator already computes each subtask's branch at `:978`. Pass it: `{card: subtask.id, branch: subtaskBranch(subtask, branchPrefix), …}`. Delete `issue` from the dispatch.

With `task.js` off the board, the entire `project` argument, `hasResolvedBoardIds`, the `:782` guard and the now-dead `resolveBoardIds` (parked at the end of Phase 1) all go. **This is what finally retires the `gh` `project` scope** — Phase 1 could not, because `task.js` still mutated Projects v2. Update the root `README.md` accordingly, removing the scope requirement and the note saying it goes away in Phase 2.

- [ ] **Step 1: Write the failing test**

```javascript
// in plugins/leave-me-alone/workflows/orchestrator.test.mjs
import { readFileSync } from 'node:fs'

test('the branch the orchestrator dispatches is the one it derives', async () => {
  // subtaskBranch already exists in the pure region — it is what the dry-run
  // table and matchPr both use. Add it to the loadPure name list if it is not
  // exposed yet. This pins that the dispatch cannot drift from the derivation.
  const { subtaskBranch } = await loadPure()
  assert.equal(subtaskBranch({ id: S1, title: 'write rows' }, 'm12'), 'm12/task-write-rows-11111111')
})

test('the dispatch passes card and branch, and no longer passes issue', () => {
  const source = readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8')
  assert.match(source, /card: subtask\.id/)
  assert.doesNotMatch(source, /issue: subtask\.id/,
    'the GitHub key must be gone, not merely unused')
})

test('the board is no longer a concept here', () => {
  const source = readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /resolveBoardIds|hasResolvedBoardIds|optionIds|fieldId/)
})
```

Do not invent a dispatch-args builder to make this testable — the dispatch is constructed inline in the Dispatch stage, outside the pure region, and extracting it purely to assert on it would be a refactor this task did not ask for.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: FAIL — the dispatch still passes `issue`, and the board helpers are present

- [ ] **Step 3: Write minimal implementation**

Make the dispatch change, delete the board block and its tests, and correct `meta.description` and the Configure phase blurb — Configure no longer resolves or validates a board at all, so say what it does now (discovering the repo's verification commands).

- [ ] **Step 4: Run the whole suite**

Run: `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/`
Expected: PASS, 0 failures. Report the total and account for every test removed with the board.

- [ ] **Step 5: Commit**

```bash
git add -A plugins/leave-me-alone/ README.md
git commit -m "orchestrator: dispatch card and branch, retire the Projects v2 board"
```

---

## Phase 2 exit criteria

- `node --test plugins/leave-me-alone/scripts/ plugins/leave-me-alone/workflows/` is green.
- No GraphQL anywhere in `task.js`: `grep -nE "api graphql|updateProjectV2|projectItems" plugins/leave-me-alone/workflows/task.js` returns nothing.
- No `gh issue` call in either workflow: `grep -rn "gh issue" plugins/leave-me-alone/workflows/` returns nothing.
- One branch derivation: `grep -n "branchPrefix" plugins/leave-me-alone/workflows/task.js` shows `task.js` never concatenating one.
- The `gh` `project` scope appears in no doc as a requirement.
- A milestone is runnable end to end — verifiable by a `dryRun` whose `prTargets` column is correct, followed by a real single-subtask run on a scratch repo.

**Not in this phase:** `setup-project`, `setup-milestone`, `setup-report`, and `hooks/auto-allow.sh` — Phase 3.

Two of those deferrals are deliberate calls rather than leftovers:

- **The committed snapshot** (`docs/board/<milestone>.json`, written from `brd tree` so board state travels with the repo) belongs to Phase 3, not here. The orchestrator would be its writer, and this phase already touches the orchestrator — but `setup-report` is its only reader, and writing a snapshot nothing consumes is work that cannot be validated. The two land together in Phase 3.
- **`auto-allow.sh` gains real urgency here.** It has no `brd` entry. Today that is harmless only because `brd` is spawned as a child of `bun <detect.mjs>`, so the allowlist sees `bun`. Task 7 makes `task.js` shell out to `rollup.mjs` — still via `bun`, so the allowlist still sees `bun` and Phase 2 remains unblocked. But the moment anything invokes `brd` directly from a trigger step, every board write prompts and unattended runs stall. If a Phase 2 implementer finds themselves writing a bare `brd …` trigger step, stop and flag it rather than working around the prompt.
