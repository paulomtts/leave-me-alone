# Local-Only DRIVE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove GitHub from every DRIVE run (orchestrator + task). Subtasks and
stories build as local git branches only; the orchestrator gains a terminal
Integrate phase that merges a fully-clean milestone into one local branch and
stops — a human runs `git merge` into `main`/`master` themselves.

**Architecture:** `ship.mjs` stops pushing and opening PRs (verify → mark
`done`). `worktree.mjs` stops checking GitHub for a live PR and gains a real
fix for basing a worktree on a not-yet-pushed local branch. `detect.mjs` stops
listing PRs; `orchestrator.js`'s whole PR-matching apparatus
(`matchPr`/`prMatchesSubtask`/`attachPullRequests`/`normalizePr`) is deleted
because there is no longer an external system whose state can diverge from
brd's. A new deterministic script, `integrate.mjs`, performs one merge attempt
per call, mirroring `worktree.mjs`'s idempotent create-or-reuse style; the
orchestrator drives it story-by-story through the same dependency levels
`computeLevels` already produces, dispatching a conflict-resolution agent only
when a merge actually conflicts.

**Tech Stack:** Node (`node --test`), Bun (workflow scripts at runtime), git,
brd. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-local-only-drive-design.md`

## Global Constraints

- `done` still means "verified and committed to the subtask's branch" — never
  "merged." The orchestrator's own terminal merge is a *separate* fact
  (`integrated: true`), not a change to what a subtask's `done` means.
- The orchestrator never runs `git merge`/`push`/`rebase` against `main` or
  `master`, and never pushes anything, anywhere. `auto-allow.sh` is not
  touched — its existing defer on `main`/`master` already covers this
  correctly (see spec, "Landing on main/master").
- Integrate runs only when the **entire milestone** completed with every
  story `done` and nothing escalated. A halted/partial run never triggers it.
- On an unresolvable merge conflict (resolution attempted, re-verification
  still fails), every original story branch is left byte-for-byte untouched.
  Nothing is silently discarded or force-reset.
- No placeholder PR-shaped fields survive in any return value. `pr`/`url`/
  `pushed`/`number` are gone from `ship.mjs`, `task.js`, and
  `orchestrator.js`'s per-subtask results — replaced by `branch` (already
  known deterministically before dispatch, so nothing round-trips through
  GitHub to learn it).

---

### Task 1: `worktree.mjs` — drop the open-PR check, fix the local-base fallback

**Files:**
- Modify: `plugins/leave-me-alone/scripts/worktree.mjs`
- Test: `plugins/leave-me-alone/scripts/worktree.test.mjs`

**Interfaces:**
- Consumes: `gitRunner` from `./gh.mjs` (unchanged).
- Produces: `prepare(options, git = gitRunner, wait)` — **signature changes**:
  drops the `gh` parameter entirely (no more injectable gh runner). Every
  caller in this codebase (`worktree.test.mjs`, and Task 7's `orchestrator.js`
  wiring) must call it as `prepare(options, git, wait)`, not
  `prepare(options, git, gh, wait)`.
  Result shape drops `openPr` and `prLookupError`; keeps `branch`, `worktree`,
  `branchExisted`, `worktreeExisted`, `created`, `commitCount`.

There is a real bug this task fixes, not just a deletion. Today,
`git worktree add worktree -b branch origin/${base}` always prefixes `base`
with `origin/`. That works today only because `ship.mjs` pushes every subtask
before the next one's worktree is prepared, so `origin/<that branch>` exists
by the time it's needed (see `detect.mjs`'s own comment: *"ship.mjs pushes...
which updates this checkout's own refs/remotes/origin/<branch> as a side
effect"*). Once Task 2 removes that push, `base` for every subtask after a
story's first, and every story rooted on another story's tip, is a **local**
branch that was never pushed — `origin/${base}` will never exist, and
`git worktree add` will hard-fail. `${base}` only legitimately needs the
`origin/` prefix when it names the milestone's own real `baseBranch` (e.g.
`master`), which predates this run and lives on the remote regardless.

- [ ] **Step 1: Write the failing test for the local-base fallback**

Add to `worktree.test.mjs` (near the existing "a brand new subtask gets a
branch cut from the base" test):

```javascript
test('a base that only exists locally (a prior subtask/story branch, never pushed) is used directly, not as origin/<base>', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args[0] === 'rev-parse' && args.includes('origin/story-a-tip')) {
      const err = new Error('fatal: bad revision'); err.code = 128; throw err
    }
    if (args[0] === 'for-each-ref') return ''
    if (args[0] === 'worktree' && args[1] === 'list') return ''
    if (args[0] === 'rev-list') return '0\n'
    return ''
  }
  await prepare({ branch: 'm1/task-b', base: 'story-a-tip', worktree: '/wt', repoDir: '/repo' }, git)
  const addCall = calls.find(c => c[2] === 'worktree' && c[3] === 'add')
  assert.deepEqual(addCall.slice(-1), ['story-a-tip'], 'must branch from the local ref, not origin/story-a-tip')
})

test('a base that IS on the remote (the milestone baseBranch) still uses origin/<base>', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args[0] === 'rev-parse' && args.includes('origin/master')) return 'abc123\n'
    if (args[0] === 'for-each-ref') return ''
    if (args[0] === 'worktree' && args[1] === 'list') return ''
    if (args[0] === 'rev-list') return '0\n'
    return ''
  }
  await prepare({ branch: 'm1/task-a', base: 'master', worktree: '/wt', repoDir: '/repo' }, git)
  const addCall = calls.find(c => c[2] === 'worktree' && c[3] === 'add')
  assert.deepEqual(addCall.slice(-1), ['origin/master'], 'a real remote base must still use origin/<base>')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/leave-me-alone/scripts/worktree.test.mjs`
Expected: FAIL — `prepare` still unconditionally uses `origin/${base}` and
still takes a `gh` parameter the new test calls don't pass.

- [ ] **Step 3: Remove the open-PR check and add the local-base fallback**

Replace `prepare` in `worktree.mjs` (the whole function, lines 49-86) with:

```javascript
export async function prepare(options, git = gitRunner, wait) {
  const { branch, base, worktree, repoDir } = options
  const result = { branch, worktree, branchExisted: false, worktreeExisted: false, created: false, commitCount: 0 }

  result.branchExisted = branchExists(
    await git(['-C', repoDir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/']), branch)
  result.worktreeExisted = worktreePaths(
    await git(['-C', repoDir, 'worktree', 'list', '--porcelain'])).includes(worktree)

  // `base` names a real remote branch only when it IS the milestone's own
  // baseBranch — every other base is another subtask's or story's own local
  // branch, which this run created and never pushes. Prefer origin/<base>
  // when it resolves; fall back to the bare local ref otherwise, rather than
  // requiring the caller to say which kind of base it passed.
  let resolvedBase = base
  try {
    await git(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `origin/${base}`])
    resolvedBase = `origin/${base}`
  } catch { /* no such remote ref — use the local branch directly */ }

  if (!result.worktreeExisted) {
    const args = result.branchExisted
      ? ['-C', repoDir, 'worktree', 'add', worktree, branch]
      : ['-C', repoDir, 'worktree', 'add', worktree, '-b', branch, resolvedBase]
    await git(args)
    result.created = true
  }

  result.commitCount = Number(String(
    await git(['-C', worktree, 'rev-list', '--count', `${resolvedBase}..HEAD`])).trim()) || 0
  return result
}
```

Update the import line to drop the now-unused `ghRunner`, `ghError`,
`jsonFrom`, `withRetries`:

```javascript
import { gitRunner, readFlags } from './gh.mjs'
```

Update `parseArgs` — `--repo` is no longer used by `prepare` at all (it was
only ever for the gh PR-lookup URL). Remove it from the flags spec and the
required-args list:

```javascript
export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--branch': 'value', '--base': 'value',
    '--worktree': 'value', '--repo-dir': 'value', '--compact': 'boolean',
  })
  const out = {
    branch: flags['--branch'], base: flags['--base'],
    worktree: flags['--worktree'], repoDir: flags['--repo-dir'],
    compact: flags['--compact'] === true,
  }
  for (const [key, ok, msg] of [
    ['branch', v => typeof v === 'string' && v.length > 0, '--branch <name>'],
    ['base', v => typeof v === 'string' && v.length > 0, '--base <name>'],
    ['worktree', v => typeof v === 'string' && v.startsWith('/'), '--worktree <absolute path>'],
    ['repoDir', v => typeof v === 'string' && v.startsWith('/'), '--repo-dir <absolute path>'],
  ]) if (!ok(out[key])) throw new Error(`worktree needs ${msg}`)
  return out
}
```

And the CLI entry point no longer needs the `openPr` exit-code check:

```javascript
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await prepare(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
}
```

Also update `gh.mjs`'s file-header comment (line 1), which currently reads
"Shared plumbing for the deterministic `gh` scripts" — that's no longer
accurate once `worktree.mjs`/`ship.mjs`/`detect.mjs` stop being gh scripts:

```javascript
// Shared plumbing for this plugin's deterministic scripts — process
// execution, JSON/text parsing, retries. Not gh-specific despite the
// filename: gitRunner, jsonFrom, lastLine, readFlags etc. are used by scripts
// that never touch GitHub. ghRunner/ghError/withRetries remain for whatever
// still does (setup-report's CI check; a human's own later `gh pr merge`).
```

- [ ] **Step 4: Remove the now-obsolete open-PR tests**

Delete these two tests from `worktree.test.mjs` (lines 64-80 — "a live PR
stops everything before a single git command runs" and "a failed PR lookup is
reported, not treated as 'no PR'"). Update every remaining test in the file
that calls `prepare(options, git, gh, wait)` to drop the `gh` argument —
`prepare(options, git, wait)`.

- [ ] **Step 5: Run the full test file to verify everything passes**

Run: `node --test plugins/leave-me-alone/scripts/worktree.test.mjs`
Expected: PASS, including the two new tests from Step 1.

- [ ] **Step 6: Commit**

```bash
git add plugins/leave-me-alone/scripts/worktree.mjs plugins/leave-me-alone/scripts/worktree.test.mjs plugins/leave-me-alone/scripts/gh.mjs
git commit -m "worktree: drop the open-PR check, fix basing a worktree on a local-only branch"
```

---

### Task 2: `ship.mjs` — stop pushing, stop opening PRs

**Files:**
- Modify: `plugins/leave-me-alone/scripts/ship.mjs`
- Test: `plugins/leave-me-alone/scripts/ship.test.mjs`

**Interfaces:**
- Produces: `ship(options, run = runner, wait)` returns
  `{ passed, verified, detail }` — drops `pushed`, `url`, `number` entirely.
  `passed: true` with no `detail` is now the sole success signal (Task 5's
  `task.js` change and Task 4's `orchestrator.js` change both consume this).
  `parseArgs` drops `--repo` and `--title` (nothing left needs either — no PR
  body, no PR title).

- [ ] **Step 1: Write the failing tests for the new shape**

Replace the PR-related tests in `ship.test.mjs` (the block from "the body is
built from the branch commits" at line 33 through "a flaky push is retried"
at line 185, and "a failed `pr create` does NOT retry" at line 198 through
"a failed `pr create` with no PR afterwards" at line 215) with:

```javascript
test('the happy path verifies, then marks the card done — nothing is pushed', async () => {
  const calls = []
  const run = async (cmd) => {
    calls.push(cmd)
    if (Array.isArray(cmd) && cmd[0] === 'git' && cmd.includes('status')) return { stdout: '', stderr: '' }
    return { stdout: 'ok', stderr: '' }
  }
  const result = await ship({ card: 'a1b2c3d4', branch: 'm1/task-x', base: 'master', worktree: '/wt', verify: ['npm test'] }, run)
  assert.equal(result.passed, true)
  assert.equal('pushed' in result, false)
  assert.equal('url' in result, false)
  assert.equal('number' in result, false)
  assert.equal(calls.some(c => Array.isArray(c) && c.includes('push')), false, 'ship must never push')
  assert.equal(calls.some(c => c === 'npm test' || (Array.isArray(c) && c.join(' ').includes('npm test'))), true)
})

test('a dirty worktree stops before verification runs', async () => {
  const run = async (cmd) => {
    if (Array.isArray(cmd) && cmd.includes('status')) return { stdout: ' M file.js\n', stderr: '' }
    throw new Error('should not reach verification')
  }
  const result = await ship({ card: 'a1b2c3d4', branch: 'm1/task-x', base: 'master', worktree: '/wt', verify: ['npm test'] }, run)
  assert.equal(result.passed, false)
  assert.match(result.detail, /dirty/)
})

test('a RED verify command stops before a second one runs', async () => {
  const seen = []
  const run = async (cmd) => {
    if (Array.isArray(cmd) && cmd.includes('status')) return { stdout: '', stderr: '' }
    seen.push(cmd)
    if (cmd === 'npm test') { const e = new Error('Command failed'); e.stdout = 'FAIL foo.test.js'; throw e }
    return { stdout: 'ok', stderr: '' }
  }
  const result = await ship({ card: 'a1b2c3d4', branch: 'm1/task-x', base: 'master', worktree: '/wt', verify: ['npm test', 'npm run lint'] }, run)
  assert.equal(result.passed, false)
  assert.deepEqual(seen, ['npm test'], 'a red command must stop the suite, not run the rest')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/leave-me-alone/scripts/ship.test.mjs`
Expected: FAIL — `ship` still pushes and returns `pushed`/`url`/`number`.

- [ ] **Step 3: Rewrite `ship()`, `parseArgs()`, and drop `buildBody()`**

Replace `ship()` (lines 94-153) with:

```javascript
export async function ship(options, run = runner, wait) {
  const { branch, worktree, verify } = options
  const result = { passed: false, verified: [], detail: '' }

  // Nothing uncommitted may ship: a dirty tree means the branch does not yet
  // carry the work it claims to.
  const status = await run(['git', '-C', worktree, 'status', '--porcelain'])
  if (String(status.stdout).trim()) {
    result.detail = plainText(`worktree is dirty, so the branch would not contain this work: ${status.stdout.trim()}`, 600)
    return result
  }

  for (const command of verify.filter(Boolean)) {
    try {
      const out = await run(command, { cwd: worktree, shell: true })
      result.verified.push({ command, ok: true, tail: plainText(lastLine(out.stdout)) })
    } catch (err) {
      result.verified.push({ command, ok: false, tail: plainText(verifyError(err)) })
      result.detail = plainText(`verification failed: ${command} — ${verifyError(err)}`, 600)
      return result   // nothing is marked done after a red command
    }
  }
  result.passed = true
  return result
}
```

Remove `buildBody` entirely (lines 63-75) — nothing calls it once there is no
PR body to build.

Update `parseArgs` (lines 31-61): drop `--repo` and `--title` from the flags
loop and the required-args list; `branch` is untouched by this since `branch`
is unaffected by naming:

```javascript
export function parseArgs(argv) {
  const out = { verify: [], compact: false }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const take = () => { if (inline !== undefined) return inline; i += 1; return argv[i] }
    if (flag === '--verify') out.verify.push(take())
    else if (flag === '--compact') out.compact = true
    else if (flag === '--card') out.card = take()
    else if (flag === '--branch') out.branch = take()
    else if (flag === '--base') out.base = take()
    else if (flag === '--worktree') out.worktree = take()
    else throw new Error(`ship: unknown argument "${argv[i]}"`)
  }
  for (const [key, test, msg] of [
    ['card', v => typeof v === 'string' && v.length > 0, '--card <shortid>'],
    ['branch', v => typeof v === 'string' && v.length > 0, '--branch <name>'],
    ['base', v => typeof v === 'string' && v.length > 0, '--base <name>'],
    ['worktree', v => typeof v === 'string' && v.startsWith('/'), '--worktree <absolute path>'],
  ]) if (!test(out[key])) throw new Error(`ship needs ${msg}`)
  if (out.verify.filter(Boolean).length === 0) {
    throw new Error('ship needs at least one --verify <command>; refusing to mark a card done nothing verified')
  }
  return out
}
```

Note `base` stays a required argument even though `ship()` itself no longer
reads it — Task 5's `task.js` still passes it for symmetry with the other
scripts' argument shapes, and a future `--verify`-relative-to-base need is
cheap to keep the plumbing for. If Task 5's review finds it genuinely unused
end to end, drop it there instead; do not guess here.

Update the CLI exit-code check at the bottom (line 159) — `result.number` no
longer exists:

```javascript
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await ship(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (!result.passed) process.exitCode = 1
}
```

`ghError`, `jsonFrom`, `lastLine`, `plainText`, `readFlags`, `withRetries` stay
imported — `ghError`/`lastLine`/`plainText` are still used by `verifyError`
(unrelated to gh; see Task 1's header-comment fix), `jsonFrom`/`withRetries`
are now unused and should be dropped from the import line:

```javascript
import { ghError, lastLine, plainText, readFlags } from './gh.mjs'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/leave-me-alone/scripts/ship.test.mjs`
Expected: PASS.

- [ ] **Step 5: Remove the remaining stale tests**

Delete `'the title is used verbatim...'` (line 161 — `--title` no longer
exists) and `'a push that succeeds but yields no PR URL...'` (line 172 —
nothing pushes). Confirm `node --test plugins/leave-me-alone/scripts/ship.test.mjs`
still passes after the deletions.

- [ ] **Step 6: Commit**

```bash
git add plugins/leave-me-alone/scripts/ship.mjs plugins/leave-me-alone/scripts/ship.test.mjs
git commit -m "ship: stop pushing and opening PRs — verify, then mark the card done"
```

---

### Task 3: `detect.mjs` — drop the PR listing

**Files:**
- Modify: `plugins/leave-me-alone/scripts/detect.mjs`
- Test: `plugins/leave-me-alone/scripts/detect.test.mjs`

**Interfaces:**
- Produces: `detect({ repo, milestone, repoDir, runBrd, git, wait })` — drops
  the `run` (gh runner) parameter entirely. Returns
  `{ milestoneTitle, stories, prepared }` — drops `pullRequests` and
  `prLookupFailed`. Task 4's `orchestrator.js` change consumes this new
  shape.

- [ ] **Step 1: Write the failing test for the new shape**

Add to `detect.test.mjs`:

```javascript
test('detect returns no pull-request fields at all — the census is brd alone', async () => {
  const runBrd = async () => JSON.stringify({ ok: true, data: [
    { id: 'a1b2c3d4-0000-0000-0000-000000000000', title: 'M', parent_id: null, status: 'todo', blocked_by: [], children: [] },
  ] })
  const result = await detect({ repo: 'o/n', milestone: 'M', repoDir: null, runBrd })
  assert.equal('pullRequests' in result, false)
  assert.equal('prLookupFailed' in result, false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/leave-me-alone/scripts/detect.test.mjs`
Expected: FAIL — `detect` still returns both fields.

- [ ] **Step 3: Remove `filterPullRequests` and the PR listing from `detect()`**

Delete `filterPullRequests` entirely (lines 86-92).

Replace `detect()` (lines 94-127) with:

```javascript
export async function detect({ repo, milestone, repoDir, runBrd = brdRunner, git = gitRunner, wait }) {
  const prepared = await prepareCheckout(repoDir, git, wait)

  // One local call replaces a milestone lookup, a story list, and what used
  // to be two API calls per story. NOT wrapped in withRetries: brd is local,
  // so a failure is real.
  const roots = await brd(['tree'], { cwd: repoDir, run: runBrd })
  const { milestoneTitle, stories } = flattenMilestone(findMilestone(roots, milestone))

  return { milestoneTitle, stories, prepared }
}
```

`repo` stays a required argument (`parseArgs` still validates `--repo owner/
name`) even though `detect()` itself no longer uses it — Task 4's
`orchestrator.js` still needs `repo` for other purposes downstream (it is
passed through to `task.js`), and detect's own `--repo` requirement doubles
as an early, clear failure if it's missing, before any work starts. Update
the import line to drop the now-unused `ghRunner`, `jsonFrom`, `parseNdjson`,
`withRetries` (keep `gitRunner`, `readFlags`, `lastLine` — `lastLine` is
re-exported and still used by `worktree.mjs`... no, Task 1 already removed
that import from `worktree.mjs`; check whether anything else in this repo
imports `lastLine`/`jsonFrom`/`parseNdjson` from `detect.mjs`'s re-export
before deleting the re-export line — `grep -rn "from '.*detect.mjs'" plugins/`
and keep only what's still imported from here):

```javascript
import { gitRunner, readFlags } from './gh.mjs'
import { brd, brdRunner } from './brd.mjs'
import { findMilestone, flattenMilestone } from './census.mjs'
```

Drop the re-export line `export { jsonFrom, lastLine, parseNdjson } from
'./gh.mjs'` (line 26) only if the grep above shows nothing imports these
three names from `detect.mjs` specifically (as opposed to from `gh.mjs`
directly) — if something does, keep the re-export line as-is; this is a
mechanical check, not a design decision, and getting it wrong either way is
a one-line fix caught by the test suite failing to resolve an import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test plugins/leave-me-alone/scripts/detect.test.mjs`
Expected: PASS for the new test; several existing tests now fail (Step 5
removes them).

- [ ] **Step 5: Remove the now-obsolete PR-listing tests**

Delete: `'filterPullRequests matches a subtask by its short id'`,
`'the filter never decides...'`, `'no subtasks means no pull requests'`,
`'detect builds its census from brd and its PR list from gh'`,
`'a failed PR listing sets prLookupFailed, NOT an empty list'`,
`'the PR listing is retried, with a pause between attempts'`,
`'it uses the REST pulls endpoint, never \`gh pr list\`'`,
`'a full census survives a banner on the PR listing'` (lines 92-105, 112-130,
158-193, 215-225 — re-check exact ranges against the file as it stands after
Steps 3-4, since earlier deletions shift line numbers).
`'a malformed card id aborts the run rather than reading as a PR-lookup
failure'` (line 149) stays, but its assertion about `prLookupFailed` must be
rewritten to just assert the run throws (the malformed-id guard itself is
unrelated to PR lookups and stays load-bearing — `shortId` still throws on a
bad card id, this test just needs its final assertion updated, not deleted).

- [ ] **Step 6: Run the full file to verify everything passes**

Run: `node --test plugins/leave-me-alone/scripts/detect.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/leave-me-alone/scripts/detect.mjs plugins/leave-me-alone/scripts/detect.test.mjs
git commit -m "detect: drop the PR listing — the census is brd alone"
```

---

### Task 4: `orchestrator.js` — delete the PR-matching machinery, simplify doneness

**Files:**
- Modify: `plugins/leave-me-alone/workflows/orchestrator.js`
- Test: `plugins/leave-me-alone/workflows/orchestrator.test.mjs`

**Interfaces:**
- Produces: `isSubtaskDone(subtask)` — now reads `subtask.status` alone.
  Every per-subtask result field named `pr` becomes `branch` (already known
  before dispatch — see `runSubtask` below). `escalation()` drops its `pr`
  parameter and field.

This task deletes `matchPr`, `prMatchesSubtask`, `normalizePr`,
`attachPullRequests` in full (roughly lines 300-460) — all four exist only to
reconcile GitHub's PR state against the branch geometry (catching a merged PR
under a changed `branchPrefix`, an unreported base, etc.). None of that
category of problem can happen once there is no external system whose state
can diverge from brd's own.

- [ ] **Step 1: Write the failing test for the simplified shape**

`orchestrator.test.mjs` imports every PURE-region name it tests through one
`loadPure(ORCHESTRATOR_PATH, [...])` call at the top of the file (see its
current header) — there is no separate mocked-dispatch harness in this file;
only names actually extractable from the PURE region can be tested here.
Deleting `matchPr`/`prMatchesSubtask`/`normalizePr`/`attachPullRequests` is
verified by Step 3 removing their names from that `loadPure(...)` call and
its destructuring assignment (if a stray reference to any of them survives
the deletion, evaluating the PURE region throws there, which fails the whole
file loudly — not a name worth a separate existence-check test).

Add to `orchestrator.test.mjs` (the PURE-region tests):

```javascript
test('isSubtaskDone reads brd status alone — no PR object involved', () => {
  assert.equal(isSubtaskDone({ status: 'done' }), true)
  assert.equal(isSubtaskDone({ status: 'todo' }), false)
  assert.equal(isSubtaskDone({ status: 'in_progress' }), false)
  assert.equal(isSubtaskDone({ status: 'blocked' }), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: FAIL — `isSubtaskDone` still checks `.pr`.

- [ ] **Step 3: Delete the PR-matching functions and simplify `isSubtaskDone`**

Delete `prMatchesSubtask`, `normalizePr`, `matchPr`, `attachPullRequests` in
full (the block from the `// ── which PR belongs to a subtask ──` comment
through the end of `attachPullRequests`, roughly lines 308-460 — confirm
exact bounds by locating the section header comment and the function's
closing brace).

In `orchestrator.test.mjs`, remove `prMatchesSubtask`, `normalizePr`,
`matchPr`, `attachPullRequests` from both the `loadPure(ORCHESTRATOR_PATH,
[...])` name-list argument and the destructuring assignment at the top of the
file — leaving a deleted name in either list makes `loadPure` fail to find it
in the sliced PURE region.

Replace `isSubtaskDone` (lines 94-97) with:

```javascript
function isSubtaskDone(subtask) {
  return String(subtask.status ?? '').toLowerCase() === 'done'
}
```

Update `escalation()` (around line 300) to drop the `pr` field:

```javascript
function escalation({ level, story, subtask, trigger, baseBranch, attempts }) {
  if (trigger !== 'tests' && trigger !== 'blocked') {
    throw new Error(`orchestrator: unknown escalation trigger "${trigger}" (expected "tests" or "blocked")`)
  }
  const message = `orchestrator STOPPED: story #${story} subtask #${subtask} (level ${level}) could not be dispatched/verified against ${baseBranch} — trigger: ${trigger}. Nothing was merged; work stays on local branches. ${(attempts ?? []).length} note(s) recorded.`
  return { escalated: true, level, story, subtask, trigger, baseBranch, attempts: attempts ?? [], message }
}
```

Remove the census PR-wiring block that fed `attachPullRequests` (the
`pullRequests`/`prLookupFailed`/`attachPullRequests` call/`unknownPrs` check,
roughly the block starting `const pullRequests = Array.isArray(census.pullRequests)...`
through the `throw new Error(...)` closing the `unknownPrs.length > 0` check —
locate via the comment `// An "unknown" pr means the API did not answer`).
What remains at that point in the file is just:

```javascript
const storiesById = new Map(census.stories.map(story => [story.id, story]))
assertNoBlockerCycles(census.stories)
```

- [ ] **Step 4: Simplify `runSubtask`'s result shape**

In `runSubtask` (the function starting `async function runSubtask(levelIndex,
story, subtask, stackBase)`):

Delete the "already has a PR" early-return block:

```javascript
  if (subtask.pr && typeof subtask.pr === 'object') {
    return { subtask: subtask.id, story: story.id, pr: subtask.pr.number, branch,
      base: stackBase, stacked: true, note: 'PR already open against its stack parent — nothing to redo' }
  }
```

(This is unreachable in practice now — `remainingSubtasks()` already filters
out anything `isSubtaskDone` before the level loop ever calls `runSubtask` —
but the field it read, `subtask.pr`, no longer exists, so it must go either
way.)

In the `thrown` branch, drop `pr: null` from the `escalation(...)` call
(the function no longer takes a `pr` parameter per Step 3).

In the "no PR came back" branch, replace:

```javascript
  if (!dispatched || dispatched.refused || dispatched.blocked || !dispatched.pr) {
```

with:

```javascript
  if (!dispatched || dispatched.refused || dispatched.blocked) {
```

(A successful `task.js` return, per Task 5, carries no PR-shaped field to
check truthiness against any more — `refused`/`blocked` already exhaustively
partition failure from success.)

In that same branch's `halt(escalation({...}))` call, drop `pr: dispatched &&
dispatched.pr`.

Delete the PR-number sanity-check block entirely:

```javascript
  const prNumber = Number(dispatched.pr)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    halt(escalation({ level: levelIndex, story: story.id, subtask: subtask.id, pr: null, baseBranch: stackBase, trigger: 'blocked',
      attempts: [{ attempt: 0, resolved: false, detail: `PR reference was not a number (${typeof dispatched.pr}) — refusing to stack the next subtask on it` }] }))
    return { subtask: subtask.id, escalated: true }
  }
```

(Stacking was always based on the deterministically-derived branch name, not
a PR number — nothing downstream needs this check once there is no PR
number to validate.)

Replace the final success return:

```javascript
  return { subtask: subtask.id, story: story.id, pr: prNumber,
    branch: dispatched.branch || branch, base: stackBase, stacked: true, plan: dispatched.plan,
    statusWritten: dispatched.statusWritten !== false,
    ...(dispatched.statusWriteError ? { statusWriteError: dispatched.statusWriteError } : {}) }
```

with:

```javascript
  return { subtask: subtask.id, story: story.id,
    branch: dispatched.branch || branch, base: stackBase, stacked: true, plan: dispatched.plan,
    statusWritten: dispatched.statusWritten !== false,
    ...(dispatched.statusWriteError ? { statusWriteError: dispatched.statusWriteError } : {}) }
```

- [ ] **Step 5: Rewrite the mapWithConcurrency escalation payload and the final report note**

In the `levelResults.some(result => result === null...)` block, drop `pr:
null` from the inline escalation object literal.

Replace the final success `note` text (the string ending "...done means the
PR is open, not that it is merged."):

```javascript
  note: 'Every completed subtask/story is a LOCAL branch only — nothing was pushed. '
    + 'Run this milestone\'s orchestrator again (or a follow-up Integrate step, see Task 7) '
    + 'to merge everything into one branch; a human merges that into main/master by hand.'
    + (unwrittenSubtasks.length > 0
```

(Task 7 replaces this whole return with the real Integrate-aware version —
this step's job is only to make the *existing* text stop lying about PRs
between Task 4 and Task 7 landing, so the suite is green at every commit.)

- [ ] **Step 6: Run the full orchestrator test file, fix any remaining
  references**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: some failures remain from tests written against the deleted
PR-matching functions and the old `pr`-shaped fields. Search the test file
for `.pr`, `matchPr`, `prMatchesSubtask`, `normalizePr`, `attachPullRequests`,
`pullRequests`, `prLookupFailed` and delete or rewrite each hit: a test
asserting PR-matching behavior is deleted outright (that behavior no longer
exists); a test asserting `runSubtask`'s or the final report's shape is
updated to the new field names per Steps 4-5.

Run again: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/leave-me-alone/workflows/orchestrator.js plugins/leave-me-alone/workflows/orchestrator.test.mjs
git commit -m "orchestrator: delete the PR-matching machinery — brd status is the only doneness signal"
```

---

### Task 5: `task.js` — Ship no longer carries a PR number

**Files:**
- Modify: `plugins/leave-me-alone/workflows/task.js`
- Test: `plugins/leave-me-alone/workflows/task.test.mjs`

**Interfaces:**
- Produces: task.js's success return drops `pr`; keeps `card`, `branch`,
  `worktree`, `plan`, `tests`, and the `statusWriteOutcome` spread. The
  `blocked: 'pr'` label (used for "could not read the card title" and "ship
  output wasn't JSON") is renamed to `blocked: 'ship'` — `'pr'` no longer
  describes anything Ship does. `orchestrator.js`'s `trigger = blocked ===
  'tests' ? 'tests' : 'blocked'` mapping (Task 4, unchanged by this task)
  already routes any non-`'tests'` label the same way, so this rename is
  safe without an orchestrator change.

**No new unit test for this task.** `task.test.mjs` only tests the named
PURE-region gate functions (`verificationGate`, `reviewGate`, `isPlanHash`,
`planHashMismatch`, `explorationOutputGate`, `shortId`, `stemOf`,
`shellQuote`, `statusWriteOutcome`, extracted via `loadPure` — see the file's
own header comment) — there is no mocked-dispatch harness in this file,
because the Ship-stage code this task changes calls `callAgent` and lives
outside the PURE region, exactly like `ship.mjs`'s push/PR logic did before
it got its own dependency-injected export (`ship()`, tested directly in
`ship.test.mjs`). None of the three `return {...}` statements this task
edits are separately exported or callable in isolation, so there is nothing
here to unit-test short of extracting them into new pure functions — which
would be new surface area the spec never asked for, not a faithful
implementation of it. This task's correctness is instead confirmed two ways:
the untouched PURE-region tests continuing to pass (Step 5) proves nothing
else in the file broke, and the Final Verification section's real dry run
exercises the actual Ship dispatch end to end.

- [ ] **Step 1: Locate the three return sites**

Read `task.js`'s Ship section in full (search for `phase('Ship')`) before
editing — the three sites below are described by their current content, not
by line numbers, since Task 2's changes may have shifted them.

- [ ] **Step 2: Update the three return sites**

Replace the "ship output wasn't JSON" return (in the `catch` around
`JSON.parse(printableOnly(...))`):

```javascript
  return { card, blocked: 'ship', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `ship.mjs returned output that is not JSON (${err.message}). Check the worktree's git status before re-running. First 200 characters: ${String(shipOut.stdout ?? '').slice(0, 200)}` }
```

Replace the "could not read this card's title" return (earlier in the same
region, in the `catch` around reading `brd show`'s title):

```javascript
  return { card, blocked: 'ship', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `could not read this card's title from \`brd show ${card}\` (${err.message}) — ship.mjs's log line uses it and there is nowhere else to get it. First 200 characters: ${String(titleOut.stdout ?? '').slice(0, 200)}` }
```

(Keep passing `cardTitle` to `ship.mjs`'s invocation for its own log output
if `ship.mjs` still accepts a title for logging — check Task 2's final
`parseArgs`: it was dropped there since nothing used it. If Task 2 dropped
`--title` from `ship.mjs`, drop the `cardTitle`-reading step and its `brd
show` call from `task.js` entirely here too, since nothing downstream needs
it any more — re-verify against Task 2's actual landed `parseArgs` before
writing this, not against the plan's description of it, in case Task 2's own
review changed the final shape.)

Remove the now-dead PR-number validation block:

```javascript
const prNumber = Number(ship.number)
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  return { card, blocked: 'pr', branch: BRANCH, worktree: WORKTREE, plan,
    detail: ship.detail || `verification passed but no usable PR number came back (url: ${String(ship.url ?? '').slice(0, 120)}). The branch ${ship.pushed ? 'WAS' : 'may not have been'} pushed — check before re-running.` }
}
```

Update the final success return:

```javascript
return { card, branch: BRANCH, worktree: WORKTREE, plan,
  tests: (ship.verified || []).map(v => `${v.ok ? 'PASS' : 'FAIL'} ${v.command}`).join('\n'),
  ...statusWriteOutcome(statusWriteErrors) }
```

- [ ] **Step 3: Update the `bun scripts/ship.mjs` invocation line**

Find the `callAgent` prompt containing `bun ${scriptsDir}/ship.mjs --repo
${repo} --card ${card} --title ${shellQuote(cardTitle)} ...` and drop
`--repo ${repo}` and `--title ${shellQuote(cardTitle)}`, matching Task 2's
final `parseArgs`.

- [ ] **Step 4: Run the existing test file to confirm nothing else broke**

Run: `node --test plugins/leave-me-alone/workflows/task.test.mjs`
Expected: PASS — every PURE-region gate test is untouched by this task and
must stay green.

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/workflows/task.js plugins/leave-me-alone/workflows/task.test.mjs
git commit -m "task: Ship no longer carries a PR number — branch is the completion identity"
```

---

### Task 6: `integrate.mjs` — one merge attempt, deterministically

**Files:**
- Create: `plugins/leave-me-alone/scripts/integrate.mjs`
- Test: `plugins/leave-me-alone/scripts/integrate.test.mjs`

**Interfaces:**
- Consumes: `gitRunner` from `./gh.mjs`; `worktreePaths`/`branchExists` from
  `./worktree.mjs` (import, do not duplicate — DRY, and Task 1 already tests
  these).
- Produces: `attempt(options, git = gitRunner)` →
  `{ created, conflict, files, merged, detail }`. Called once per story tip
  by Task 7's orchestrator wiring — the orchestrator, not this script, walks
  dependency levels and decides which tip to merge next.

```bash
bun scripts/integrate.mjs --repo-dir /abs/repo --worktree /abs/repo/.claude/worktrees/m12-integrate \
  --integration-branch m12-integrate --base-branch master --merge-tip m12/story-a/task-x-a1b2c3d4 --compact
```

Idempotent and create-or-reuse, mirroring `worktree.mjs`'s own style: the
integration branch/worktree is created off `origin/<base-branch>` only if it
does not already exist; a second call for the same milestone reuses it as-is,
carrying forward whatever earlier merges already landed on it. On a conflict,
the merge is left **in progress** — conflict markers in the working tree,
`MERGE_HEAD` set — rather than aborted, because that is the state Task 7's
conflict-resolution agent needs to work in directly (read the markers, edit
the files, `git add`, `git commit`). A call made while a previous conflict is
still unresolved is a caller error and fails loudly rather than doing
anything surprising to the in-progress merge.

- [ ] **Step 1: Write the failing tests**

```javascript
// plugins/leave-me-alone/scripts/integrate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attempt, parseArgs } from './integrate.mjs'

test('every argument is checked at the door', () => {
  assert.throws(() => parseArgs([]), /--repo-dir/)
  assert.throws(() => parseArgs(['--repo-dir', '/r']), /--worktree/)
  assert.throws(() => parseArgs(['--repo-dir', '/r', '--worktree', '/w']), /--integration-branch/)
})

test('a fresh integration branch is created off origin/<base-branch>', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args[0] === 'worktree' && args[1] === 'list') return ''
    if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    return ''
  }
  await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-a-tip' }, git)
  const addCall = calls.find(c => c[1] === 'worktree' && c[2] === 'add')
  assert.deepEqual(addCall, ['-C', '/r', 'worktree', 'add', '/w', '-b', 'm12-integrate', 'origin/master'])
})

test('an existing integration branch is reused, not recreated', async () => {
  const calls = []
  const git = async args => {
    calls.push(args)
    if (args[0] === 'worktree' && args[1] === 'list') return 'worktree /w\n'
    if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    return ''
  }
  await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-b-tip' }, git)
  assert.equal(calls.some(c => c[1] === 'worktree' && c[2] === 'add'), false, 'must not recreate an existing worktree')
})

test('a clean merge reports conflict: false and what was merged', async () => {
  const git = async args => {
    if (args[0] === 'worktree' && args[1] === 'list') return 'worktree /w\n'
    if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    if (args[2] === 'merge') return 'Merge made by the ort strategy.'
    return ''
  }
  const result = await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-a-tip' }, git)
  assert.equal(result.conflict, false)
  assert.equal(result.merged, 'm12/story-a-tip')
})

test('a conflicting merge reports the file list and leaves the merge in progress', async () => {
  const git = async args => {
    if (args[0] === 'worktree' && args[1] === 'list') return 'worktree /w\n'
    if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) { const e = new Error('not found'); e.code = 128; throw e }
    if (args[2] === 'merge') { const e = new Error('CONFLICT (content): Merge conflict in a.js'); e.code = 1; throw e }
    if (args[2] === 'diff' && args.includes('--diff-filter=U')) return 'a.js\n'
    return ''
  }
  const result = await attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-b-tip' }, git)
  assert.equal(result.conflict, true)
  assert.deepEqual(result.files, ['a.js'])
  // must NOT have run `merge --abort`
})

test('calling attempt while a previous conflict is unresolved fails loudly', async () => {
  const git = async args => {
    if (args[0] === 'worktree' && args[1] === 'list') return 'worktree /w\n'
    if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) return 'abc123\n'
    return ''
  }
  await assert.rejects(
    () => attempt({ repoDir: '/r', worktree: '/w', integrationBranch: 'm12-integrate', baseBranch: 'master', mergeTip: 'm12/story-c-tip' }, git),
    /already in progress/)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test plugins/leave-me-alone/scripts/integrate.test.mjs`
Expected: FAIL — `integrate.mjs` does not exist yet.

- [ ] **Step 3: Write `integrate.mjs`**

```javascript
#!/usr/bin/env node
// Deterministic, single-attempt merge of one story's tip into the
// milestone's integration branch. The orchestrator calls this once per
// story, in dependency-level order, and handles what happens on a conflict
// itself (dispatch a resolution agent) — this script only ever attempts one
// merge and reports what happened.
//
//   bun scripts/integrate.mjs --repo-dir /abs/repo --worktree /abs/repo/.claude/worktrees/m12-integrate \
//     --integration-branch m12-integrate --base-branch master --merge-tip m12/story-a/task-x-a1b2c3d4 --compact
//
// Idempotent like worktree.mjs: a fresh integration branch is cut from
// origin/<base-branch> only if it does not already exist; a later call for
// the same milestone reuses it, carrying forward whatever already merged.
//
// On conflict, the merge is left IN PROGRESS — conflict markers in the
// working tree, MERGE_HEAD set — never aborted. That is deliberate: it is
// the state a resolution agent needs to work in directly (read the markers,
// edit, `git add`, `git commit`). A call made while an earlier conflict is
// still unresolved is a caller error, not a condition this script guesses
// its way through.

import { gitRunner, readFlags } from './gh.mjs'
import { worktreePaths, branchExists } from './worktree.mjs'

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--repo-dir': 'value', '--worktree': 'value', '--integration-branch': 'value',
    '--base-branch': 'value', '--merge-tip': 'value', '--compact': 'boolean',
  })
  const out = {
    repoDir: flags['--repo-dir'], worktree: flags['--worktree'],
    integrationBranch: flags['--integration-branch'], baseBranch: flags['--base-branch'],
    mergeTip: flags['--merge-tip'], compact: flags['--compact'] === true,
  }
  for (const [key, ok, msg] of [
    ['repoDir', v => typeof v === 'string' && v.startsWith('/'), '--repo-dir <absolute path>'],
    ['worktree', v => typeof v === 'string' && v.startsWith('/'), '--worktree <absolute path>'],
    ['integrationBranch', v => typeof v === 'string' && v.length > 0, '--integration-branch <name>'],
    ['baseBranch', v => typeof v === 'string' && v.length > 0, '--base-branch <name>'],
    ['mergeTip', v => typeof v === 'string' && v.length > 0, '--merge-tip <branch>'],
  ]) if (!ok(out[key])) throw new Error(`integrate needs ${msg}`)
  return out
}

export async function attempt(options, git = gitRunner) {
  const { repoDir, worktree, integrationBranch, baseBranch, mergeTip } = options

  const worktreeExists = worktreePaths(
    await git(['-C', repoDir, 'worktree', 'list', '--porcelain'])).includes(worktree)

  const result = { created: false, conflict: false, files: [], merged: null, detail: '' }

  if (!worktreeExists) {
    await git(['-C', repoDir, 'worktree', 'add', worktree, '-b', integrationBranch, `origin/${baseBranch}`])
    result.created = true
  }

  // A merge already in progress means a prior conflict was never resolved —
  // never silently proceed on top of that.
  try {
    await git(['-C', worktree, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
    throw new Error(
      `integrate: a merge is already in progress in ${worktree} — resolve or handle it before calling integrate.mjs again`)
  } catch (err) {
    if (!(err && err.code === 128)) throw err   // 128 == "no MERGE_HEAD", the expected case
  }

  try {
    await git(['-C', worktree, 'merge', '--no-ff', mergeTip])
    result.merged = mergeTip
  } catch (err) {
    result.conflict = true
    const unmerged = await git(['-C', worktree, 'diff', '--name-only', '--diff-filter=U'])
    result.files = String(unmerged ?? '').split('\n').map(l => l.trim()).filter(Boolean)
    result.detail = String((err && err.message) || err).split('\n')[0]
  }
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await attempt(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (result.conflict) process.exitCode = 1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test plugins/leave-me-alone/scripts/integrate.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/leave-me-alone/scripts/integrate.mjs plugins/leave-me-alone/scripts/integrate.test.mjs
git commit -m "integrate: deterministic single-merge-attempt script for the orchestrator's terminal phase"
```

---

### Task 7: `orchestrator.js` — the Integrate phase

**Files:**
- Modify: `plugins/leave-me-alone/workflows/orchestrator.js`
- Test: `plugins/leave-me-alone/workflows/orchestrator.test.mjs`
- New integration test: `plugins/leave-me-alone/workflows/orchestrator.integration.test.mjs`

**Interfaces:**
- Consumes: `attempt` from `./scripts/integrate.mjs` — dispatched the same
  way `rollup.mjs` already is (`bun ${scriptsDir}/integrate.mjs ...` via a
  trigger-agent `callAgent`, since Workflow scripts cannot execute commands
  directly — mirror the existing `bun ${scriptsDir}/rollup.mjs` dispatch
  pattern in `runSubtask` exactly).
- Produces: the final success return gains `integrated: { branch, worktree }`
  on a clean Integrate, or the run returns an `escalated: true` shape with
  `phase: 'Integrate'` on an unresolvable conflict — same top-level shape
  family as the existing dispatch-time `halted` escalation, so a caller
  checking `result.escalated` handles both without a phase-specific branch.

Integrate runs only when every story in the milestone reports `done` and
`halted` was never set. This eligibility rule is enforced **structurally**,
not by a condition worth unit-testing separately: the existing
`if (halted) return {...halted early-return...}` (unchanged by this task)
already exits the function before Integrate's code is ever reached, so
placing Integrate's block after that existing return — and before today's
final success return — is what guarantees it. `orchestrator.test.mjs` has no
harness for a mocked full dispatch run (same reason noted in Task 5: this
logic calls `callAgent`, lives outside the PURE region `loadPure` slices out,
and nothing here is separately exported or callable in isolation). This
task's correctness is confirmed by the real-git integration test in Step 6
(which exercises `integrate.mjs`'s actual merge/conflict mechanics, the part
that can go wrong in a way worth pinning) and the Final Verification
section's real dry run (which exercises the orchestrator's own dispatch
sequencing end to end, escalation payload included).

- [ ] **Step 1: Add the Integrate phase**

Immediately before the final success `return` statement (after
`totalStatusWriteFailures` is computed, replacing Task 4 Step 5's
placeholder `note`), add:

```javascript
phase('Integrate')
const integrationBranch = `${branchPrefix}-integrate`
const integrationWorktree = `${repoDir}/.claude/worktrees/${integrationBranch}`

// Every story's tip, in dependency-level order — including a chained story
// whose tip already contains its blocker's commits via git ancestry. A merge
// of an already-merged-in ancestor is a safe no-op ("Already up to date."),
// so nothing here needs to distinguish "independent" from "chained": the
// uniform walk is simpler and no less correct.
let integrateConflict = null
for (const level of levels) {
  if (integrateConflict) break
  for (const story of level) {
    const tip = storyTip(story, storiesById, branchPrefix, baseBranch)
    const integrateOut = await callAgent(`Run this command and return its stdout EXACTLY as printed:
   bun ${scriptsDir}/integrate.mjs --repo-dir ${repoDir} --worktree ${integrationWorktree} --integration-branch ${integrationBranch} --base-branch ${baseBranch} --merge-tip ${tip} --compact

It prints one line of JSON that this pipeline parses itself — do not reformat, summarize, or truncate it.`,
      { label: `integrate:${story.id}`, phase: 'Integrate', model: 'haiku', ...triggerAgent, schema: {
        type: 'object', required: ['stdout'],
        properties: { stdout: { type: 'string' }, error: { type: 'string' } },
      } })
    if (!integrateOut) throw new Error('integrate agent died')
    let integrated
    try {
      integrated = JSON.parse(printableOnly(String(integrateOut.stdout ?? '')))
    } catch (err) {
      throw new Error(`integrate.mjs returned output that is not JSON (${err.message})`)
    }
    if (integrated.conflict) { integrateConflict = { story, tip, ...integrated }; break }
  }
}
```

On a conflict, dispatch a resolution agent that works directly in the
in-progress merge, then re-verify with a **separate** dispatch (the resolver
does not grade its own work — same discipline as Validate/Review being split
from Implement):

```javascript
if (integrateConflict) {
  const resolveOut = await callAgent(`A merge conflict is in progress at ${integrationWorktree}, merging ${integrateConflict.tip} — conflicting files: ${integrateConflict.files.join(', ')}.

Read the conflicting files (with their conflict markers) AND read both sides' real diffs — \`git -C ${integrationWorktree} diff HEAD...${integrateConflict.tip}\` and the equivalent against whatever is already merged into the integration branch — rather than resolving from the markers alone. Resolve every conflict so the result is correct for BOTH stories' intent, not just one that happens to win visually. Stage every resolved file with \`git -C ${integrationWorktree} add <file>\` and finish with \`git -C ${integrationWorktree} commit --no-edit\`. Do not run any other git command.`,
    { label: `integrate-resolve:${integrateConflict.story.id}`, phase: 'Integrate', model: 'opus', ...triggerAgent, schema: {
      type: 'object', required: ['resolved', 'summary'],
      properties: { resolved: { type: 'boolean' }, summary: { type: 'string' } },
    } })

  const verifyOut = resolveOut && resolveOut.resolved
    ? await callAgent(`Verify the merge resolution at ${integrationWorktree} — a DIFFERENT concern from whether it resolved: run this repo's full verification suite there and report pass/fail. Do not fix anything; report only.
${verification.fullSuite.map(cmd => `   ${cmd}`).join('\n')}`,
        { label: `integrate-verify:${integrateConflict.story.id}`, phase: 'Integrate', model: 'sonnet', ...triggerAgent, schema: {
          type: 'object', required: ['passed', 'detail'],
          properties: { passed: { type: 'boolean' }, detail: { type: 'string' } },
        } })
    : null

  if (!verifyOut || !verifyOut.passed) {
    return { repo, milestone, baseBranch, mode: 'stacked', escalated: true, phase: 'Integrate',
      trigger: 'conflict', completed: results,
      message: `orchestrator STOPPED at Integrate: a merge conflict between story #${integrateConflict.story.id}'s tip and the integration branch could not be resolved (${!resolveOut || !resolveOut.resolved ? 'resolution failed' : 'resolution did not verify'}). `
        + `Every original story branch is untouched. The attempted resolution, if any, is on ${integrationBranch} at ${integrationWorktree} for a human to inspect or finish.`,
      integrateConflict: { story: integrateConflict.story.id, tip: integrateConflict.tip, files: integrateConflict.files } }
  }
}
```

- [ ] **Step 2: Wire the success case into the final return**

Replace the placeholder `note` field from Task 4 Step 5 with the real
success return:

```javascript
return { repo, milestone, baseBranch, mode: 'stacked', done: true, levels: levels.length, completed: results,
  integrated: { branch: integrationBranch, worktree: integrationWorktree },
  ...(totalStatusWriteFailures > 0 ? { statusWriteFailures: totalStatusWriteFailures } : {}),
  note: `Milestone integrated onto local branch "${integrationBranch}" — nothing was pushed and main/master was not touched. `
    + `A human merges it: git merge ${integrationBranch}.`
    + (unwrittenSubtasks.length > 0
        ? ` WARNING: ${unwrittenSubtasks.length} subtask(s) shipped but the card status write failed — the board did not update for them; see each subtask's statusWriteError.`
        : '')
    + (staleRollupErrors.length > 0
        ? ` WARNING: ${staleRollupErrors.length} already-complete stor${staleRollupErrors.length === 1 ? 'y' : 'ies'} could not be rolled up — see the log for the rollup error(s).`
        : '') }
```

- [ ] **Step 3: Run the orchestrator test file to confirm nothing else broke**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.test.mjs`
Expected: PASS.

- [ ] **Step 4: Write the real-git integration test**

```javascript
// plugins/leave-me-alone/workflows/orchestrator.integration.test.mjs
//
// Builds a REAL local git history with two independent branches carrying a
// deliberate conflict on the same file, and drives integrate.mjs's attempt()
// against it directly (not through the full Workflow harness — that is
// covered by the PURE-region tests above; this proves the git mechanics).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attempt } from '../scripts/integrate.mjs'

function git(...args) { return execFileSync('git', args, { encoding: 'utf8' }) }
// integrate.mjs's own git(argsArray) signature already includes '-C', repoDir,
// ... in argsArray — this passes the full argv straight to execFileSync, no
// cwd needed since -C is always explicit.
const realGit = async args => execFileSync('git', args, { encoding: 'utf8' })

test('two independent branches with a real file conflict: detected correctly, originals untouched', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'lma-integrate-'))
  git('-C', repo, 'init', '-q')
  git('-C', repo, 'config', 'user.email', 'test@test')
  git('-C', repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'base')
  git('-C', repo, 'checkout', '-q', '-b', 'origin-stand-in')   // stand in for a remote

  git('-C', repo, 'checkout', '-q', '-b', 'story-a')
  writeFileSync(join(repo, 'shared.txt'), 'story A\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'story A change')
  const storyASha = git('-C', repo, 'rev-parse', 'story-a').trim()

  git('-C', repo, 'checkout', '-q', 'origin-stand-in')
  git('-C', repo, 'checkout', '-q', '-b', 'story-b')
  writeFileSync(join(repo, 'shared.txt'), 'story B\n')
  git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-q', '-m', 'story B change')
  const storyBSha = git('-C', repo, 'rev-parse', 'story-b').trim()

  // Fake an "origin" remote pointing at this same repo, so integrate.mjs's
  // `origin/<base>` resolution works without a real network remote.
  git('-C', repo, 'remote', 'add', 'origin', repo)
  git('-C', repo, 'fetch', '-q', 'origin')

  const wtDir = join(repo, '.claude', 'worktrees', 'm1-integrate')

  const first = await attempt({ repoDir: repo, worktree: wtDir, integrationBranch: 'm1-integrate', baseBranch: 'origin-stand-in', mergeTip: 'story-a' }, realGit)
  assert.equal(first.conflict, false)

  const second = await attempt({ repoDir: repo, worktree: wtDir, integrationBranch: 'm1-integrate', baseBranch: 'origin-stand-in', mergeTip: 'story-b' }, realGit)
  assert.equal(second.conflict, true)
  assert.deepEqual(second.files, ['shared.txt'])

  // Both original branches must be untouched by the conflicting attempt.
  assert.equal(git('-C', repo, 'rev-parse', 'story-a').trim(), storyASha)
  assert.equal(git('-C', repo, 'rev-parse', 'story-b').trim(), storyBSha)

  rmSync(repo, { recursive: true, force: true })
})
```

- [ ] **Step 5: Run the integration test**

Run: `node --test plugins/leave-me-alone/workflows/orchestrator.integration.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/leave-me-alone/workflows/orchestrator.js plugins/leave-me-alone/workflows/orchestrator.test.mjs plugins/leave-me-alone/workflows/orchestrator.integration.test.mjs
git commit -m "orchestrator: add the Integrate phase — merge a clean milestone into one local branch"
```

---

### Task 8: skills and docs — accuracy pass

**Files:**
- Modify: `plugins/leave-me-alone/skills/setup-project/SKILL.md`
- Modify: `plugins/leave-me-alone/skills/setup-milestone/SKILL.md`
- Modify: `README.md`
- Modify: `plugins/leave-me-alone/workflows/README.md`
- Test: `plugins/leave-me-alone/skills/skills.test.mjs` (extend the existing
  guard-test pattern from the brd migration's Task 8/skills.test.mjs)

No behavior changes — this task only makes prose match Tasks 1-7's already-
landed behavior. Read each file's current relevant passage before editing
(quoted content below is illustrative of the CHANGE, not a guarantee of the
current file's exact surrounding text — grep for the anchor phrase first).

- [ ] **Step 1: `setup-project/SKILL.md`** — find the `gh` precondition row
(search for `gh auth status`) and change it from a hard requirement to
"needed only if a human plans to push this work and open a PR themselves
afterward, or for `setup-report`'s CI check — DRIVE runs never call it."

- [ ] **Step 2: `setup-milestone/SKILL.md`** — find every occurrence of "done
means the PR is open" and replace with "done means verified and committed to
the subtask's local branch — nothing is pushed." Find any dry-run example or
"merge the stack bottom-up" instruction referencing PRs and replace with: the
orchestrator's own Integrate phase produces one local branch per clean
milestone; a human runs `git merge <that branch>` into `main`/`master`
themselves.

- [ ] **Step 3: `README.md`** — find the dependency table row for `gh`
(search for "opening/checking/merging PRs") and soften it the same way as
Step 1. Find and remove/update any prose describing PRs as DRIVE's output.

- [ ] **Step 4: `workflows/README.md`** — find the `orchestrator`
phase/argument documentation (search for `mode: 'stacked'` or the phases
list) and add the `Integrate` phase to it, describing eligibility (whole
milestone clean) and its output (a local branch, human merges).

- [ ] **Step 5: extend `skills.test.mjs`'s guard tests**

Add a test asserting the "done means PR" phrase is gone and a phrase tying
completion to a local branch is present, mirroring the existing guard-test
pattern in this file exactly (read the file first — it already has a
negative/positive pair for a prior wording change; copy that shape, do not
invent a new one):

```javascript
assert.doesNotMatch(source, /done means (the|that) (a |)PR is open/i, `${name} still promises PR-based done`)
assert.match(source, /verified and committed|local branch/i, `${name} does not describe local-only completion`)
```

- [ ] **Step 6: Run the skills test file**

Run: `node --test plugins/leave-me-alone/skills/skills.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add plugins/leave-me-alone/skills/setup-project/SKILL.md plugins/leave-me-alone/skills/setup-milestone/SKILL.md README.md plugins/leave-me-alone/workflows/README.md plugins/leave-me-alone/skills/skills.test.mjs
git commit -m "docs: local-only DRIVE — done means committed locally, a human merges the Integrate branch"
```

---

## Final Verification

- [ ] Run the full suite: `npm test`
- [ ] Confirm no remaining reference to `gh pr create`, `gh api .../pulls`,
  or `pushed`/`url`/`number` fields anywhere under `plugins/leave-me-alone/`:
  `grep -rn "pr create\|state=all\|state=open" plugins/leave-me-alone/scripts plugins/leave-me-alone/workflows`
  — expect zero hits outside `gh.mjs` itself and `setup-report`'s own
  unrelated `gh pr checks` usage.
- [ ] A real dry run (per the pattern established during this session's own
  end-to-end sweep) against a throwaway two-subtask, two-story milestone,
  confirming: both subtasks land as local branches with no PR opened, and
  Integrate produces one branch containing both stories' work with no
  conflict. A second throwaway run with a deliberately overlapping edit
  between two independent stories, confirming the conflict path escalates
  correctly and leaves both original branches untouched.
