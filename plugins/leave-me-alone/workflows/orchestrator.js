export const meta = {
  name: 'orchestrator',
  description: 'Drive a whole brd milestone on any repo as STACKED PULL REQUESTS (PRs stay on GitHub): compute the story dependency DAG from blockedBy, dispatch each level\'s stories in parallel — each story\'s subtasks run SEQUENTIALLY, one worktree/branch/PR per subtask, each PR targeting the previous subtask\'s branch — and full-stop on escalation. NEVER merges anything: a story lands as a reviewable stack for a human to merge bottom-up.',
  whenToUse: 'User asks to run a whole milestone end-to-end: "/orchestrator milestone 4", "run milestone 3 on refactor-nori". Preview first with dryRun and check the base column.',
  phases: [
    { title: 'Configure', detail: 'nothing to resolve; there is no board. Detect is already dispatched by this point', model: 'haiku' },
    { title: 'Detect', detail: 'stories and blockedBy edges from brd, existing per-subtask PRs and their bases', model: 'haiku' },
    { title: 'Dispatch', detail: 'per-level pipeline over stories; each story\'s subtasks sequential, task.js once per subtask, stacked', model: 'sonnet' },
  ],
}

// PURE:BEGIN
// Everything between these markers is a pure function of its arguments: no
// agent() calls, no globals from the Workflow harness, no I/O. workflows/
// orchestrator.test.mjs slices this region out of THIS FILE and runs it under
// `node --test`, so these are the one part of the pipeline covered by real
// tests rather than by a live run.
//
// It is extracted rather than imported because a Workflow script executes in a
// sandbox with no module resolution — an `import` here would break the
// orchestrator at launch. Slicing keeps one source of truth and costs the
// runtime nothing.
//
// Two rules for anything added between the markers: it must not reference
// `args`, `agent`, `log`, `phase`, `pipeline`, or `workflow`, and it must not
// depend on anything declared below PURE:END.

// ── card identity (branch naming) ────────────────────────────────────────────
// Mirrors scripts/naming.mjs exactly. Duplicated rather than imported: a
// Workflow script executes in a sandbox with no module resolution (see the
// file-level comment above), so an `import` here would break the orchestrator
// at launch — the same reason printableOnly() below is a second copy rather
// than a shared one. Keep this in lockstep with naming.mjs; naming.test.mjs is
// the source of truth for its behavior.

function shortId(cardId) {
  if (typeof cardId !== 'string') throw new Error(`not a card id: ${JSON.stringify(cardId)}`)
  const hex = cardId.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a card id: ${JSON.stringify(cardId)}`)
  return hex.slice(0, 8).toLowerCase()
}

function slugify(title, max = 24) {
  const flat = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastDash = cut.lastIndexOf('-')
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '')
}

function taskStem(card) {
  const slug = slugify(card && card.title)
  const id = shortId(card && card.id)
  return slug ? `${slug}-${id}` : id
}

function taskBranch(branchPrefix, card) {
  return `${branchPrefix}/task-${taskStem(card)}`
}

// A script's JSON round-trips through an agent's structured output, and that
// DECODES escapes: a \u001b the script wrote arrives here as a raw ESC byte,
// which JSON.parse rejects as an invalid control character. Node's test runner
// colours its output, and one captured line of it failed a milestone at the
// last step -- after the PRs were already open. The scripts strip this at
// source now; this is the second line of defence.
function printableOnly(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

// ── DAG / lock / escalation core ─────────────────────────────────────────────

// LOCAL-ONLY MODE: there is no external system (no PR, no GitHub) whose state
// can diverge from brd's own. brd's `status` field is the single source of
// truth for doneness — reads it directly, no reconciliation needed.
//
// Reads `status` — the field flattenMilestone() (census.mjs) actually emits.
// There is no `state` anywhere in the census; a field nothing emits is worse
// than no check at all.
function isSubtaskDone(subtask) {
  return String(subtask.status ?? '').toLowerCase() === 'done'
}

// A story marked done is finished, full stop — never re-dispatch its subtasks.
// Per-subtask doneness leans on 30-odd PR lookups; during the 2026-08-17
// GitHub outage those returned null and closed stories were re-implemented.
// The story's single status field can't be corrupted piecemeal, so it is the
// safer gate; a story closed by mistake is reopened by hand.
function isStoryClosed(story) {
  return String(story.status ?? '').toLowerCase() === 'done'
}

// The census arrives already ordered by its blocked_by chain — no re-sorting
// by title here, ever. A title carries no ordinal any more.
function remainingSubtasks(story) {
  if (isStoryClosed(story)) return []
  return (story.subtasks ?? []).filter(subtask => !isSubtaskDone(subtask))
}

// A story with zero remaining subtasks (every subtask already has an open PR
// from a prior run, or the story itself is closed) never enters a dispatch
// level — computeLevels drops it — so task.js never runs for it this run, and
// nothing ever triggers rollup.mjs on its behalf. Its card, and the
// milestone's, would keep whatever status they had, permanently.
//
// The fix is not a second status-writing path: it is triggering the one that
// already exists. This picks WHICH subtask anchors that trigger — one
// isSubtaskDone() already considers done (an open PR regardless of the
// card's own status, or a card explicitly marked done with no PR), so
// rollup.mjs re-asserting THAT subtask's own field is at worst a no-op and
// only the walk up to its ancestors does real work. It is not a guarantee
// the anchor's status field itself reads "done" — an open-PR subtask can
// still show `todo` there; rollup.mjs recomputes every ancestor from the
// story's REAL children regardless, so the ancestor writes stay correct
// either way. Returns null when the story has nothing safe to anchor on (no
// subtasks, or none individually done) — there is then nothing to reassert.
// A story marked done itself (isStoryClosed) but whose subtasks are not
// individually done still returns null here rather than anchoring on an
// arbitrary one: reasserting a subtask's status the card does not actually
// have would be a wrong write, not a safe no-op — skipping it is deliberate,
// not an oversight.
function storyRollupAnchor(story) {
  return (story.subtasks ?? []).find(isSubtaskDone) || null
}

function computeLevels(stories) {
  const doneIds = new Set(
    stories.filter(story => isStoryClosed(story) || remainingSubtasks(story).length === 0)
      .map(story => story.id),
  )
  // Card ids are opaque strings with no inherent order, unlike issue numbers —
  // the census's own array order is the only stable order available, so
  // pending stories keep it rather than being re-sorted.
  const pending = stories.filter(story => !doneIds.has(story.id))
  const pendingIds = new Set(pending.map(story => story.id))

  const levels = []
  const placed = new Set()
  let rest = pending
  while (rest.length > 0) {
    // A dep is satisfied when the upstream story is fully done (not pending)
    // or placed in an earlier level.
    const ready = rest.filter(story => (story.blockedBy ?? [])
      .every(dep => !pendingIds.has(dep) || placed.has(dep)))
    if (ready.length === 0) {
      throw new Error(`orchestrator: dependency cycle among stories ${rest.map(story => `#${story.id}`).join(', ')}`)
    }
    levels.push(ready)
    for (const story of ready) placed.add(story.id)
    rest = rest.filter(story => !placed.has(story.id))
  }
  return levels
}

// ── stack geometry ──────────────────────────────────────────────────────────
// Nothing merges, so the milestone base never advances. Every subtask therefore
// has to branch from the work it depends on, not from the base:
//
//   main ── A1 ← A2 ← A3            story A (no blockers)
//                 └── B1 ← B2       story B (blockedBy A) roots on A's TIP
//   main ── C1 ← C2                 story C (no blockers), parallel to A
//
// Two consequences that are easy to get wrong:
//  - Predecessors come from the FULL ordered subtask list, never the remaining
//    one. If A1 is already done and A2 is not, A2 still stacks on A1's branch.
//  - A blocker being "done" does NOT mean its code landed anywhere. A story
//    blocked by a finished story must STILL root on that story's tip, or it is
//    built against a base that has never seen the code it depends on.

// Cycle detection over blockedBy, standing on its own.
//
// computeLevels also refuses to run on a cycle, but it cannot run first: its
// doneness check reads each subtask's PR, and those are only trustworthy AFTER
// Detect's normalization has rejected wrong-base ones — and that normalization
// needs the stack geometry, which is what a cycle breaks. So the check lives
// here, ahead of both.
//
// storyRoot's own `seen` guard is NOT sufficient: storyTip returns a branch
// immediately when a story has subtasks, so a cycle between two populated
// stories never recurses back and never trips it. That guard only covers the
// no-subtask fallthrough path.
function assertNoBlockerCycles(stories) {
  const byId = new Map(stories.map(story => [story.id, story]))
  const state = new Map()   // id -> 'visiting' | 'done'
  const walk = (id, trail) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      const cycle = [...trail.slice(trail.indexOf(id)), id].map(n => `#${n}`).join(' -> ')
      throw new Error(`orchestrator: dependency cycle among stories ${cycle} — no stack can be rooted until it is broken`)
    }
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.blockedBy ?? []) {
      if (byId.has(dep)) walk(dep, [...trail, id])
    }
    state.set(id, 'done')
  }
  for (const story of stories) walk(story.id, [])
}

// A subtask's branch is DERIVED, never discovered. The card id is immutable,
// unique, and already the identity everything else uses, so branch =
// taskBranch(prefix, card) is reproducible from the graph alone and needs no
// lookup.
//
// An earlier version preferred a PR's real head ref, to survive a run whose
// branchPrefix had changed. That made the geometry depend on the PRs and the
// PR matching depend on the geometry — a circularity that produced two separate
// bugs in one afternoon. Determinism is worth more than that resilience, so the
// prefix is treated as part of the milestone's identity, full stop — no
// reconciliation against an external system, because there is no longer one.
function subtaskBranch(subtask, branchPrefix) {
  return taskBranch(branchPrefix, subtask)
}

// The branch a story's stack ends on — what a dependent story roots from.
function storyTip(story, storiesById, branchPrefix, baseBranch, seen = new Set()) {
  const ordered = story.subtasks ?? []
  if (ordered.length > 0) return subtaskBranch(ordered[ordered.length - 1], branchPrefix)
  // A story with no subtasks contributes no branch; fall through to its own root.
  return storyRoot(story, storiesById, branchPrefix, baseBranch, seen)
}

// Where a story's stack starts. Returns a branch name, or throws with a message
// meant for a human when the shape is one this cannot decide.
function storyRoot(story, storiesById, branchPrefix, baseBranch, seen = new Set()) {
  if (seen.has(story.id)) {
    throw new Error(`orchestrator: dependency cycle reached story #${story.id} while computing its stack root`)
  }
  seen.add(story.id)
  // Only blockers inside this milestone can be stacked on; anything else is
  // external work whose branch this run knows nothing about.
  const blockers = (story.blockedBy ?? []).filter(dep => storiesById.has(dep))
  if (blockers.length === 0) return baseBranch
  if (blockers.length > 1) {
    // Deliberately not guessing. Rooting on one blocker silently builds this
    // story without the others' code; an octopus base would need a merge, which
    // is exactly what this mode does not do. A human picks: merge the blockers
    // first, or split the story.
    throw new Error(
      `orchestrator: story #${story.id} is blocked by ${blockers.length} stories (${blockers.map(n => `#${n}`).join(', ')}), `
      + 'and stacked mode can only root a stack on ONE parent branch. Merge those blockers into '
      + `${baseBranch} first, or restructure the dependencies so this story has a single blocker.`)
  }
  return storyTip(storiesById.get(blockers[0]), storiesById, branchPrefix, baseBranch, seen)
}

// The base each remaining subtask's PR targets: the previous subtask in the
// story's FULL order, or the story's root for the first one.
function stackBases(story, storiesById, branchPrefix, baseBranch) {
  const ordered = story.subtasks ?? []
  const root = storyRoot(story, storiesById, branchPrefix, baseBranch)
  const bases = new Map()
  ordered.forEach((subtask, index) => {
    bases.set(subtask.id, index === 0 ? root : subtaskBranch(ordered[index - 1], branchPrefix))
  })
  return bases
}

// pipeline()/parallel() have no per-call concurrency limit of their own — the
// harness caps individual agent() calls globally, but not story LANES. A level
// with ten independent stories therefore opened ten worktrees at once, each
// running its own task.js pipeline. This bounds the lanes.
//
// A thrown or dead story callback becomes null rather than rejecting, matching
// what pipeline() did before it: the level loop treats a null result as a hard
// halt, so a dying lane still stops the run instead of silently vanishing.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch {
        results[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()))
  return results
}

function escalation({ level, story, subtask, trigger, baseBranch, attempts }) {
  if (trigger !== 'tests' && trigger !== 'blocked') {
    throw new Error(`orchestrator: unknown escalation trigger "${trigger}" (expected "tests" or "blocked")`)
  }
  const message = `orchestrator STOPPED: story #${story} subtask #${subtask} (level ${level}) could not be dispatched/verified against ${baseBranch} — trigger: ${trigger}. Nothing was merged; work stays on local branches. ${(attempts ?? []).length} note(s) recorded.`
  return { escalated: true, level, story, subtask, trigger, baseBranch, attempts: attempts ?? [], message }
}

// ── dropping verification commands that cannot run at the base ref ──────────
// Bugs two and three both lived in this one judgement. Reading commands from
// the working tree named a test file absent from origin/<base>, which every
// worktree is cut from (crash mid-milestone). The fix -- drop commands naming
// absent paths -- was then handed to the agent as prose, and it dropped ALL of
// them, leaving an empty suite that made every downstream gate vacuous while
// reporting green.
//
// So the agent now REPORTS what it saw and decides nothing: which commands it
// found, and which paths those commands name that are not present at the ref.
// The drop happens here, where it is visible, testable, and cannot quietly
// empty a suite.
function dropCommandsNamingMissingPaths(commands, missingPaths) {
  const missing = (missingPaths ?? [])
    .map(path => String(path ?? '').trim())
    .filter(path => path.length > 0)
  const kept = []
  const dropped = []
  for (const command of commands ?? []) {
    const text = String(command ?? '').trim()
    if (text.length === 0) continue
    // findIndex, not find: find returns the matched string, and an empty-string
    // path would match every command while reading as falsy — the suite would
    // be wiped and the guard would look like it had held.
    const hit = missing.findIndex(path => text.includes(path))
    if (hit >= 0) dropped.push({ command: text, path: missing[hit] })
    else kept.push(text)
  }
  return { kept, dropped }
}

// ── milestone addressing ─────────────────────────────────────────────────────
// `milestone` may be a positive integer (a legacy numeric milestone), a brd
// card id, or a title substring — census.mjs's findMilestone() accepts all
// three and fails loudly on ambiguity. Only the numeric form has an
// unambiguous branch-prefix default (`m<milestone>`); naively deriving one
// from a title would produce an invalid git ref (`mMilestone 12: CSV
// export`), so that default is numeric-only. resolveBranchPrefix() below
// requires an explicit branchPrefix for anything else, rather than guessing.
function resolveMilestone(milestoneArg) {
  if (milestoneArg === undefined || milestoneArg === null || String(milestoneArg).trim().length === 0) {
    throw new Error(
      'orchestrator needs args.milestone as a positive integer, a brd card id, or a title substring, '
      + 'e.g. args: {"repo":"owner/name","repoDir":"/abs/path","milestone":4,"baseBranch":"main","nonce":"<now>"}')
  }
  const asNumber = Number(milestoneArg)
  const isNumeric = Number.isInteger(asNumber) && asNumber > 0
  return { milestone: isNumeric ? asNumber : String(milestoneArg).trim(), isNumeric }
}

function resolveBranchPrefix(branchPrefixArg, milestone, isNumeric) {
  if (typeof branchPrefixArg === 'string' && branchPrefixArg.length > 0) return branchPrefixArg
  if (isNumeric) return `m${milestone}`
  throw new Error(
    `orchestrator needs args.branchPrefix — milestone ${JSON.stringify(milestone)} is not a positive integer, `
    + 'so there is no safe default to derive a branch prefix from it (a title or card id would produce an '
    + 'invalid git ref). Pass branchPrefix explicitly, e.g. "m12".')
}

// A milestone title/id can contain spaces or shell metacharacters; the trigger
// step below hands this straight to a shell, so it must be quoted rather than
// interpolated bare the way the numeric form always was.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// PURE:END

// ── args ─────────────────────────────────────────────────────────────────────
let raw = args
if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = { milestone: Number(raw) } } }
const opts = raw && typeof raw === 'object' ? raw : {}

const repo = opts.repo
if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  throw new Error('orchestrator needs args.repo as "owner/name"')
}
const repoDir = opts.repoDir
if (typeof repoDir !== 'string' || !repoDir.startsWith('/')) {
  throw new Error('orchestrator needs args.repoDir as an absolute path to the checkout')
}
const { milestone, isNumeric: milestoneIsNumeric } = resolveMilestone(opts.milestone ?? opts.milestoneNumber)
// Never defaulted: nothing maps a milestone to a branch, and guessing would
// target the wrong integration branch.
const baseBranch = opts.baseBranch
if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
  throw new Error('orchestrator needs args.baseBranch (the branch each story\'s stack ultimately roots on)')
}
// agent() caches on (prompt, opts) across a resumeFromRunId, so a resumed run
// would replay Detect's stale GitHub snapshot. The nonce (caller-supplied —
// Date.now()/Math.random() are unavailable in workflow scripts) busts that key;
// pass a fresh value each (re)launch.
const nonce = opts.nonce
if (typeof nonce !== 'string' || nonce.length === 0) {
  throw new Error('orchestrator needs args.nonce to defeat Detect\'s resume cache (e.g. the current timestamp)')
}

const DRY = opts.dryRun === true
// This run NEVER merges. Each subtask gets a PR targeting the previous
// subtask's branch, so a story lands as a reviewable stack that a human (or a
// merge queue) merges bottom-up afterwards. `autoMerge` is gone: there is no
// merge to opt out of, and accepting it silently would let an old invocation
// believe merging still happens.
if (opts.state !== undefined) {
  throw new Error(
    'orchestrator: args.state is no longer supported. It let a caller hand over a census taken '
    + 'earlier, which is a SNAPSHOT of what is merged and what is open — reuse it minutes later and '
    + 'the run re-dispatches work that has since landed. Pass args.detectScript instead: the same '
    + 'script produces the same deterministic census, but freshly, on every run.')
}

if (opts.autoMerge !== undefined || opts.maxResolveAttempts !== undefined) {
  throw new Error(
    'orchestrator: args.autoMerge / args.maxResolveAttempts are no longer supported — this workflow opens '
    + 'stacked PRs and never merges, so there is nothing to auto-merge and no conflicts to resolve mid-run.')
}
// Branch names carry their milestone: a subtask card of milestone 12 lives on
// `m12/task-<slug>-<shortid>` (taskBranch()), worktree
// `.claude/worktrees/m12/task-<slug>-<shortid>`.
//
// This is NOT collision avoidance — card ids are already unique, and two runs
// of the SAME milestone would share this prefix anyway. It buys legibility and
// bulk cleanup: `git branch --list "m12/*"` and `rm -rf .claude/worktrees/m12`
// each address exactly one milestone, which matters once a repo has several in
// flight.
//
// An explicit branchPrefix is used verbatim, milestone and all — explicit means
// explicit. Whatever it is, it must stay CONSTANT for the life of a milestone:
// names are derived from it, so changing it points the run at addresses where
// nothing exists — a subtask done under the old prefix would read as unstarted
// and get re-dispatched onto a fresh branch.
const branchPrefix = resolveBranchPrefix(opts.branchPrefix, milestone, milestoneIsNumeric)
const coauthor = typeof opts.coauthor === 'string' ? opts.coauthor : 'Claude <noreply@anthropic.com>'
// Caps how many stories within one DAG level are in flight at once — separate
// from the harness's own global agent() concurrency cap, which throttles
// individual agent calls but not story lanes (each lane makes many calls across
// its subtasks' Explore/Spec/.../Ship phases). A wide level (e.g. 10 independent
// level-0 stories) once spun up 10 worktrees simultaneously, which is what this
// option exists to bound. Default 4.
const maxConcurrentStories = Number.isInteger(opts.maxConcurrentStories) && opts.maxConcurrentStories > 0
  ? opts.maxConcurrentStories
  : 4

// Workflow scripts cannot locate their own directory, so the sibling script
// must be named explicitly — no default: this repo can be checked out at any
// path by anyone, so a baked-in absolute path here would be exactly the kind
// of machine-specific hardcoding this plugin avoids everywhere else. Wrong or
// missing path fails at launch, not mid-milestone.
// Detect is a trigger, not a shell with opinions: it runs ONE command and
// hands back its stdout. Same wiring as taskScript — an absolute path, no
// default, because this repo can be checked out anywhere.
//
// There is no agent-census fallback. There used to be, and it was four
// commands, a loop and a filter carried out by a model that could substitute a
// tool, drop a result or tidy a branch name in transit — three of the four bugs
// this pipeline has ever had came from that latitude. A fallback nobody
// exercises is not a safety net; it is untested code waiting for the worst
// possible moment. One path, and it is the deterministic one.
const detectScript = typeof opts.detectScript === 'string' && opts.detectScript.startsWith('/')
  ? opts.detectScript
  : (() => { throw new Error(
      'orchestrator needs args.detectScript as an absolute path to this checkout\'s '
      + 'scripts/detect.mjs (e.g. "<repo>/scripts/detect.mjs") — there is no default, since this '
      + 'repo can be checked out anywhere, and no fallback: the census is deterministic or it does '
      + 'not happen. It is run with `bun`.') })()

// Same checkout's scripts/, derived from detectScript so there is one path to
// get wrong instead of several — runSubtask forwards this to task.js, and the
// already-complete-story rollup pass below dispatches rollup.mjs from it
// directly.
const scriptsDir = detectScript.slice(0, detectScript.lastIndexOf('/'))

// Namespaced, because these types ship WITH this workflow in the same plugin:
// an installed plugin registers its agents as `<plugin>:<name>`, and the bare
// name only resolves if a copy also happens to sit in ~/.claude/agents/. Relying
// on that meant the workflows worked for the wrong reason — deleting the local
// copies would have turned a passing run into a hard error mid-milestone.
// Both setup agents run one command and read nothing else. The DEFAULT
// subagent hands them 16,424 characters of context anyway — 5.8KB listing every
// deferred tool name, 10.7KB describing every skill — measured, for a 451-char
// prompt about `bun`. A custom agent type carries neither: the same run with a
// restricted-tool type attached ZERO attachments.
//
// So both triggers use `command-runner`: `tools: Bash`, a one-line body, and
// nothing else to read. Its definition is version-controlled at
// agents/command-runner.md and must be installed at ~/.claude/agents/ — the
// registry is read when a session STARTS, so installing it mid-session is not
// enough, and a missing type is a hard error rather than a silent fallback.
// Override with args.triggerAgentType, or pass '' to use the default subagent.
const triggerAgentType = typeof opts.triggerAgentType === 'string'
  ? opts.triggerAgentType
  : 'leave-me-alone:command-runner'
const triggerAgent = triggerAgentType ? { agentType: triggerAgentType } : {}

const taskScript = typeof opts.taskScript === 'string' && opts.taskScript.startsWith('/')
  ? opts.taskScript
  : (() => { throw new Error(
      'orchestrator needs args.taskScript as an absolute path to this checkout\'s workflows/task.js '
      + '(e.g. "<repo>/workflows/task.js") — there is no default, since this repo can be checked out anywhere.') })()

// agent() can throw when the model returns without calling StructuredOutput —
// a transient harness fault, not a real blocker (halted a full run,
// 2026-08-18). Retry exactly once with an amended prompt (distinct cache key);
// a second failure falls through to the caller's own failure path.
async function callAgent(prompt, agentOpts) {
  try {
    return await agent(prompt, agentOpts)
  } catch (err) {
    const reason = err && err.message ? err.message : String(err)
    log(`agent ${agentOpts.label} threw (${reason}) — retrying once`)
    return agent(`${prompt}

[RETRY: a previous attempt returned no structured output and may have already performed some steps — verify current state before repeating any write. You MUST finish by returning the structured result.]`,
      { ...agentOpts, label: `${agentOpts.label}:retry` })
  }
}

// ── Detect — raw GitHub state + verification commands; no judgement ─────────
// Dispatched before phase('Configure') is even reached and awaited after it —
// there is no longer anything for Configure to do first, so this is simply
// started as early as possible.
//
// Each call passes its phase explicitly, so the progress grouping does not
// depend on which one happens to be running when phase() was last called.
// The census is ALWAYS taken fresh — see the args.state rejection above. What a
// caller can skip is `verification`: the answer to "how does this repo run its
// tests" changes about twice a year, and it is the one genuinely model-shaped
// step in this stage.
const providedVerification = opts.verification && typeof opts.verification === 'object'
  && Array.isArray(opts.verification.fullSuite)
  ? opts.verification
  : null

const detectVerificationStep = index => `${index}. Discover this repo's OWN verification commands — do not assume a toolchain.

   **Read them as they exist on \`origin/${baseBranch}\`, NOT from ${repoDir}'s working tree.** That checkout can sit on an unrelated branch, and every subtask worktree is cut from \`origin/${baseBranch}\` — so a command discovered from the working tree can name a test file that does not exist where it will actually run. That failure looks exactly like a broken test and stops the whole milestone (observed: a suite command naming a test file added on another branch).
   \`\`\`
   git -C ${repoDir} fetch origin
   git -C ${repoDir} ls-tree -r --name-only origin/${baseBranch}          # what actually exists there
   git -C ${repoDir} show origin/${baseBranch}:CLAUDE.md                  # read a file at that ref
   \`\`\`
   Read whichever exist AT THAT REF: CLAUDE.md, the testing/standards doc it points to, .github/workflows/*, and the project manifest (pyproject.toml / package.json / Makefile / justfile).

   Return the exact full-suite command(s) (each separate invocation listed separately if the repo requires tiers to run apart), the typecheck command (empty if none), the lint/format commands (empty array if none), and which file(s) you took them from.

   **Report what exists; decide nothing.** Do NOT drop, edit, or substitute any command. Instead, for every path named by any command you are returning, check it against the \`ls-tree\` listing and return \`missingPaths\`: the paths that are NOT present at \`origin/${baseBranch}\`, verbatim as the command spells them. The script drops the affected commands itself. An earlier version asked you to do the dropping and it dropped every command, leaving an empty suite that made every later check pass while testing nothing.`

// One command, returned byte for byte. Everything the long version guards
// against — substituting a tool, dropping a result, tidying a branch name in
// transit — stops being possible when there is nothing to do but run it.
// One command. Everything the long census prompt guarded against — choosing a
// tool, looping over results, filtering, transcribing many values — stops being
// possible when there is nothing to do but run it, so the guards went with it.
// What remains is the one instruction a model still needs against its own
// reflexes: hand the bytes back untouched rather than tidying them.
const DETECT_TRIGGER_STEP = `Run this command and return its stdout EXACTLY as printed:
   bun ${detectScript} --repo ${repo} --milestone ${shellQuote(milestone)} --repo-dir ${repoDir} --compact

It prints one line of JSON that the pipeline parses itself, so reformatting, pretty-printing, summarizing or truncating it breaks a deterministic step. A non-zero exit is a normal answer — report it, do not retry or work around it.`

const detectSteps = [DETECT_TRIGGER_STEP]
if (!providedVerification) detectSteps.push(detectVerificationStep(2))

// The generic header ("read state only, do NOT create…") is inherited from the
// census prompt and says nothing to an agent whose entire job is one read-only
// command. It comes back only when the verification step does.
const detectPrompt = detectSteps.length === 1
  ? `${DETECT_TRIGGER_STEP}

[cache-buster, ignore: ${nonce}]`
  : `Detect the remaining work on ${repo} milestone ${JSON.stringify(milestone)}, checkout at ${repoDir}. Read state only — do NOT create, close, edit, comment on, or merge anything.

${detectSteps.join('\n\n')}

Return the raw structure. No summarizing, no judging what is "done". [cache-buster, ignore: ${nonce}]`

const detectPromise = callAgent(detectPrompt,
  { label: `detect:${milestone}`, phase: 'Detect', model: 'haiku', ...triggerAgent, schema: {
    type: 'object',
    required: ['ok', 'stdout', ...(providedVerification ? [] : ['verification'])],
    properties: {
      // The census is a string here on purpose: it is parsed by this script, so
      // a mangled or truncated transcription fails at the boundary instead of
      // arriving as a plausible-looking half-census.
      ok: { type: 'boolean', description: 'true if the command exited zero' },
      stdout: { type: 'string', description: 'the command\'s stdout, byte for byte, unmodified' },
      error: { type: 'string', description: 'the command\'s stderr, when it failed' },
      verification: {
        type: 'object', required: ['fullSuite'],
        properties: {
          fullSuite: { type: 'array', items: { type: 'string' } },
          typecheck: { type: 'string' },
          lint: { type: 'array', items: { type: 'string' } },
          verificationSource: { type: 'string' },
          missingPaths: { type: 'array', items: { type: 'string' } },
        } },
    },
  } })
  .then(value => ({ value }), error => ({ error }))

phase('Configure')

// Detect was already dispatched (see above); collect it now. A rejection is
// rethrown with its original error — a failed census means nothing can be
// dispatched safely.
const detectOutcome = await detectPromise
if (detectOutcome.error) throw detectOutcome.error
if (!detectOutcome.value) throw new Error('detect agent died')
const detected = detectOutcome.value

// One name for each half, whoever produced it. Everything below reads these.
// On the trigger path the agent hands back a string; parsing it HERE means a
// mangled or truncated transcription fails loudly at the boundary instead of
// arriving as a plausible-looking half-census.
function parseTriggerOutput(result) {
  if (!result || result.ok !== true) {
    throw new Error(`orchestrator: ${detectScript} failed: ${(result && result.error) || 'no error reported'}`)
  }
  try {
    return JSON.parse(printableOnly(String(result.stdout ?? '')))
  } catch (err) {
    throw new Error(`orchestrator: ${detectScript} returned output that is not JSON (${err.message}). `
      + `First 200 characters: ${String(result.stdout ?? '').slice(0, 200)}`)
  }
}

const census = parseTriggerOutput(detected)
log(`detect: census produced deterministically by ${detectScript} (${(census.stories || []).length} stories)`)
if (!Array.isArray(census.stories)) {
  throw new Error('orchestrator: the census came back with no stories array — nothing can be dispatched')
}


const storiesById = new Map(census.stories.map(story => [story.id, story]))
assertNoBlockerCycles(census.stories)

// Detect reports which paths are absent at origin/<base>; the dropping happens
// here, out loud. Silence is what made the empty-suite bug survive a whole run.
const rawVerification = providedVerification || detected.verification || { fullSuite: [] }
const missingPaths = rawVerification.missingPaths || []
const suite = dropCommandsNamingMissingPaths(rawVerification.fullSuite, missingPaths)
const typecheck = dropCommandsNamingMissingPaths(
  rawVerification.typecheck ? [rawVerification.typecheck] : [], missingPaths)
const lint = dropCommandsNamingMissingPaths(rawVerification.lint, missingPaths)
for (const { command, path } of [...suite.dropped, ...typecheck.dropped, ...lint.dropped]) {
  log(`detect: dropped verification command "${command}" — it names "${path}", which is not on origin/${baseBranch}`)
}
if (suite.kept.length === 0 && suite.dropped.length > 0) {
  // Not fatal here: task.js refuses to run a subtask with no suite, and that is
  // the right place to stop. Saying so here makes the cause legible instead of
  // leaving someone to wonder why every subtask blocked at once.
  log(`detect: WARNING — every full-suite command was dropped as unrunnable at origin/${baseBranch}. `
    + 'Subtasks will refuse to run rather than verify nothing. Fix the base branch\'s documented test command.')
}
const verification = {
  fullSuite: suite.kept,
  typecheck: typecheck.kept[0] || '',
  lint: lint.kept,
  verificationSource: rawVerification.verificationSource,
}
const suiteCmds = verification.fullSuite
const suiteBlock = suiteCmds.length
  ? suiteCmds.map(command => `  - ${command}`).join('\n')
  : '  (NOT DOCUMENTED — find this repo\'s real full-suite command before claiming anything passes)'

const levels = computeLevels(census.stories)
log(`milestone ${JSON.stringify(milestone)} "${census.milestoneTitle || ''}": ${census.stories.length} stories, ${levels.length} dependency level(s)`)

if (DRY) {
  return {
    repo, milestone, milestoneTitle: census.milestoneTitle, baseBranch,
    mode: 'dryRun',
    verification,
    plan: levels.map((levelStories, levelIndex) => ({
      level: levelIndex,
      stories: levelStories.map(story => {
        const bases = stackBases(story, storiesById, branchPrefix, baseBranch)
        return {
          story: story.id, title: story.title,
          root: storyRoot(story, storiesById, branchPrefix, baseBranch),
          subtasks: remainingSubtasks(story).map(subtask => ({
            id: subtask.id, title: subtask.title, status: subtask.status,
            branch: subtaskBranch(subtask, branchPrefix),
            // The whole point of a dry run: check this column — the local
            // branch this subtask stacks on (another subtask's branch, a
            // story's root, or the milestone base).
            base: bases.get(subtask.id) || baseBranch,
          })),
        }
      }),
    })),
    alreadyDone: census.stories.filter(story => remainingSubtasks(story).length === 0).map(story => story.id),
    note: 'dryRun: nothing was dispatched, nothing was pushed. One worktree/branch per SUBTASK, '
      + 'dispatched sequentially within each story. Each subtask stacks on its parent (the `base` column), NOT the milestone base directly — '
      + 'verify that column before a real run. A clean milestone\'s stories are merged into one local branch by the Integrate phase; '
      + 'nothing ever touches main/master automatically.',
  }
}

// ── the story-completion gap ─────────────────────────────────────────────────
// A story with zero remaining subtasks never enters `levels` — computeLevels
// drops it — so task.js never runs for it THIS run, and nothing ever triggers
// rollup.mjs on its behalf. That story's card, and the milestone's, would
// keep whatever status they had, permanently: dispatch is unaffected (this
// run correctly does no work on it), but the board a human reads goes stale.
//
// The fix reuses rollup.mjs's own tested ancestry walk rather than writing a
// second status path: for each such story, dispatch one rollup against an
// already-done subtask (storyRollupAnchor), re-asserting that subtask's own
// current status. rollup.mjs writes the card, then reads each ancestor fresh
// and recomputes it from its REAL children — so this is safe even when the
// anchor is not the only reason the story is done, and the walk still reaches
// the milestone regardless.
//
// Same best-effort-but-visible contract as every other rollup dispatch: a
// failure here must not sink a run whose PRs are all open and green, but must
// not vanish either — it folds into statusWriteFailures below, exactly like a
// per-subtask statusWriteError does.
const alreadyCompleteStories = census.stories.filter(story => remainingSubtasks(story).length === 0)
const staleRollupErrors = []
for (const story of alreadyCompleteStories) {
  const anchor = storyRollupAnchor(story)
  if (!anchor) continue // nothing on this story is individually marked done — nothing safe to reassert
  const rollupOut = await callAgent(`Run this command and return its stdout EXACTLY as printed:
   bun ${scriptsDir}/rollup.mjs --card ${anchor.id} --status ${anchor.status} --repo-dir ${repoDir} --compact

It prints one line of JSON that the pipeline parses itself, so reformatting, pretty-printing, summarizing or truncating it breaks a deterministic step. This step is best-effort: report a failure via the schema's error field, do not retry it yourself, and do not let it change anything else.`,
    { label: `rollup:story-${story.id}:already-complete`, phase: 'Dispatch', model: 'haiku', effort: 'low', ...triggerAgent, schema: {
      type: 'object', required: ['stdout'],
      properties: {
        stdout: { type: 'string', description: 'the command\'s stdout, byte for byte, unmodified' },
        error: { type: 'string', description: 'the command\'s stderr, when it failed' },
      },
    } })
  if (!rollupOut) {
    const msg = `rollup (already-complete story ${story.id}) agent died — card status was not rolled up`
    log(msg)
    staleRollupErrors.push(msg)
  } else if (rollupOut.error) {
    const msg = `rollup (already-complete story ${story.id}) failed: ${rollupOut.error}`
    log(msg)
    staleRollupErrors.push(msg)
  }
}

if (levels.length === 0) {
  return { repo, milestone, baseBranch, done: true, reason: 'every story on this milestone has zero remaining subtasks',
    ...(staleRollupErrors.length > 0 ? { statusWriteFailures: staleRollupErrors.length } : {}) }
}

// ── halt flag ────────────────────────────────────────────────────────────────
// The merge lock that used to live here is gone with merging itself. It existed
// to serialize `gh pr merge` across concurrently-running stories; stacked PRs
// touch nothing shared, so there is nothing left to serialize. Sequencing WITHIN
// a story still matters — subtask N+1 branches off N — and that is the plain
// `for` loop in the level stage, not a lock.
let halted = null   // escalation payload; stops all NEW dispatch

// Stories run concurrently, so two can escalate in the same tick — the FIRST
// payload is the root cause and must not be overwritten.
function halt(payload) {
  if (!halted) halted = payload
}

// ── per-subtask stage ────────────────────────────────────────────────────────
// One dispatch, one PR, no merge. `stackBase` is this subtask's parent branch —
// the previous subtask's, or the story's root for the first one.
async function runSubtask(levelIndex, story, subtask, stackBase) {
  if (halted) return { subtask: subtask.id, skipped: 'halted' }

  // Branch is always the freshly-derived name, never a resumed PR's real head
  // ref — see subtaskBranch's comment for why that was deliberately dropped.
  const branch = subtaskBranch(subtask, branchPrefix)

  let dispatched = null
  let thrown = null
  try {
    // {scriptPath}, not the bare name 'task': Workflow-by-name resolves through
    // a cache that can replay a stale script after an edit (see README) —
    // nested calls are just as exposed.
    //
    // baseBranch here is the STACK PARENT, not the milestone base. task.js uses
    // it for all three of: the worktree cut point, Review's diff base, and the
    // PR target — which is exactly what stacking needs, and why task.js required
    // no change for this mode.
    //
    // task.js now takes a brd card id (`card`) and the branch this run already
    // derived (`branch`), rather than a GitHub issue number and its own
    // board-move config — it moves the card itself via rollup.mjs.
    dispatched = await workflow({ scriptPath: taskScript }, {
      repo, repoDir, card: subtask.id, branch, baseBranch: stackBase, coauthor, verification,
      scriptsDir,
      triggerAgentType,
    })
  } catch (err) {
    thrown = err
  }

  if (thrown) {
    // An unreadable scriptPath surfaces here, one subtask in, and reads like a
    // task failure unless the path is named.
    const message = String((thrown && thrown.message) || thrown)
    const hint = message.includes(taskScript)
      ? ` — task.js was not readable at ${taskScript}; pass args.taskScript if these workflows live elsewhere on this machine`
      : ''
    halt(escalation({ level: levelIndex, story: story.id, subtask: subtask.id, baseBranch: stackBase, trigger: 'blocked',
      attempts: [{ attempt: 0, resolved: false, detail: `task workflow threw: ${message}${hint}` }] }))
    return { subtask: subtask.id, escalated: true }
  }

  if (!dispatched || dispatched.refused || dispatched.blocked) {
    // task.js's `blocked` values are distinct failures and the detail differs in
    // what a human must do about it — `implement` from the Plan-Hash gate in
    // particular carries a do-NOT-re-run warning, because a re-run would
    // hard-reset real commits. Keep the specific reason in the escalation
    // instead of flattening everything to a JSON blob.
    const blocked = dispatched && dispatched.blocked
    const trigger = blocked === 'tests' ? 'tests' : 'blocked'
    const why = dispatched
      ? (dispatched.refused
          ? `task.js refused the issue: ${dispatched.reason || 'no reason given'}`
          : `task.js stopped at ${blocked}: ${dispatched.detail || dispatched.reason || 'no detail given'}`)
      : 'task.js returned nothing'
    const attempts = [{ attempt: 0, resolved: false, detail: why }]
    halt(escalation({ level: levelIndex, story: story.id, subtask: subtask.id, baseBranch: stackBase, trigger, attempts }))
    return { subtask: subtask.id, escalated: true }
  }

  // task.js's own status write is best-effort so a card that already closed
  // clean is never sunk by it — but that failure must not vanish into a `done:
  // true` run whose board never actually moved. Carry it through verbatim.
  if (dispatched.statusWritten === false) {
    log(`subtask ${subtask.id}: done, but the card's status was NOT written — ${dispatched.statusWriteError || '(no detail)'}`)
  }

  return { subtask: subtask.id, story: story.id,
    branch: dispatched.branch || branch, base: stackBase, stacked: true, plan: dispatched.plan,
    statusWritten: dispatched.statusWritten !== false,
    ...(dispatched.statusWriteError ? { statusWriteError: dispatched.statusWriteError } : {}) }
}

// ── level loop + pipeline() barrier ─────────────────────────────────────────
const results = []
for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
  if (halted) break
  phase('Dispatch')
  const level = levels[levelIndex]
  log(`level ${levelIndex}: dispatching ${level.length} story/stories, up to ${maxConcurrentStories} at once — ${level.map(story => `#${story.id}`).join(', ')}`)
  // mapWithConcurrency, not pipeline(): the harness caps agent() calls but not
  // story lanes, and each lane opens a worktree and runs a whole task.js
  // pipeline. One story per item; that story's subtasks run SEQUENTIALLY inside
  // its callback.
  const levelResults = await mapWithConcurrency(level, maxConcurrentStories, async story => {
    const out = []
    // Bases come from the FULL ordered list, so an already-done predecessor
    // still supplies the branch its successor stacks on. Computed once per
    // story; a shape this cannot decide (multi-blocker, cycle) throws here and
    // pipeline() turns it into a null result, caught as a halt below.
    const bases = stackBases(story, storiesById, branchPrefix, baseBranch)
    for (const subtask of remainingSubtasks(story)) {
      if (halted) { out.push({ subtask: subtask.id, skipped: 'halted' }); continue }
      const stackBase = bases.get(subtask.id) || baseBranch
      const subtaskResult = await runSubtask(levelIndex, story, subtask, stackBase)
      out.push(subtaskResult)
      // Subtask N+1 branches off N's PUSHED branch, so N must have produced one.
      // Nothing is merged — `stacked` is the success signal now, not `merged`.
      if (!subtaskResult || subtaskResult.stacked !== true) break
    }
    return { story: story.id, root: bases.size ? [...bases.values()][0] : baseBranch, subtasks: out }
  })
  // mapWithConcurrency maps a thrown/dead story callback to null
  // rather than propagating — treat that as a halt, or level N+1 would
  // dispatch on top of a level that never finished.
  if (levelResults.some(result => result === null || result === undefined) && !halted) {
    halt({
      escalated: true, level: levelIndex, story: null, subtask: null, trigger: 'blocked', baseBranch, attempts: [],
      message: `orchestrator STOPPED: level ${levelIndex} had a story lane die (returned null from mapWithConcurrency) with no escalation payload set — treating as a hard halt.`,
    })
  }
  results.push({ level: levelIndex, stories: levelResults })
}

// Escalation is returned, not thrown, so the payload reaches the top-level
// session structurally intact. `halted` only stops NEW dispatch — in-flight
// stages in the current level finish naturally.
if (halted) return { repo, milestone, baseBranch, mode: 'stacked', ...halted, completed: results,
  ...(staleRollupErrors.length > 0 ? { statusWriteFailures: staleRollupErrors.length } : {}) }

// A status write is best-effort per subtask (see runSubtask) so it never sinks
// an open, green PR — but `done: true` must not read as "the board updated"
// when it didn't. Count what silently failed and say so, rather than letting
// a clean-looking run hide a board still at `todo`.
const unwrittenSubtasks = results.flatMap(level => (level.stories ?? []))
  .flatMap(story => (story && story.subtasks) || [])
  .filter(subtask => subtask && subtask.statusWritten === false)

// Both kinds of status-write failure — a dispatched subtask's, and an
// already-complete story's stale-rollup pass above — fold into the same
// count, so a run whose board never updated says so regardless of which path
// the failure came from.
const totalStatusWriteFailures = unwrittenSubtasks.length + staleRollupErrors.length

// ── Integrate — merge every story's tip into one local branch ───────────────
// Reached only when `halted` was never set (the check above already returned
// otherwise) — i.e. every level finished dispatch without an escalation.
// That structural placement, not a separate condition, is the eligibility
// gate: see the brief's note on why this is not unit-tested in isolation.
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

// On a conflict, dispatch a resolution agent that works directly in the
// in-progress merge, then re-verify with a SEPARATE dispatch — the resolver
// does not grade its own work, same discipline as Validate/Review being split
// from Implement.
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
