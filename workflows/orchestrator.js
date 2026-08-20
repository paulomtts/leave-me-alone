export const meta = {
  name: 'orchestrator',
  description: 'Drive a whole GitHub milestone on any repo as STACKED PULL REQUESTS: resolve the project board ids by name, compute the story dependency DAG from blockedBy, dispatch each level\'s stories in parallel — each story\'s subtasks run SEQUENTIALLY, one worktree/branch/PR per subtask, each PR targeting the previous subtask\'s branch — and full-stop on escalation. NEVER merges anything: a story lands as a reviewable stack for a human to merge bottom-up.',
  whenToUse: 'User asks to run a whole milestone end-to-end: "/orchestrator milestone 4", "run milestone 3 on refactor-nori". Preview first with dryRun and check the prTargets column.',
  phases: [
    { title: 'Configure', detail: 'project/field/option ids looked up BY NAME, plus the repo\'s own verification commands', model: 'haiku' },
    { title: 'Detect', detail: 'stories, blockedBy edges, sub-issues, existing per-subtask PRs and their bases', model: 'haiku' },
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

// ── ordering (task.js drives one already-chosen subtask; only this script orders) ──

const DEFAULT_ORDINAL = '^[A-Za-z]?\\d+(?:\\.\\d+)*\\.(\\d+)\\b'

function makeParseOrdinal(pattern) {
  const ordinalRe = new RegExp(pattern)
  return function parseOrdinal(title) {
    const match = ordinalRe.exec(String(title ?? ''))
    return match && match[1] !== undefined ? Number(match[1]) : null
  }
}

// With no ordinal-tagged title, the `sub_issues` endpoint's order (creation
// order) IS the intended order — never re-sort by issue number. With at least
// one tag, tagged subtasks sort by ordinal; untagged ones keep relative order
// and sink to the end.
function orderSubtasks(subtasks, pattern) {
  const parseOrdinal = makeParseOrdinal(pattern || DEFAULT_ORDINAL)
  const list = [...(subtasks ?? [])]
  if (!list.some(subtask => parseOrdinal(subtask.title) !== null)) return list
  return list
    .map((subtask, index) => ({ subtask, index, ordinal: parseOrdinal(subtask.title) }))
    .sort((a, b) => {
      if (a.ordinal === null && b.ordinal === null) return a.index - b.index
      if (a.ordinal === null) return 1
      if (b.ordinal === null) return -1
      return a.ordinal - b.ordinal || a.index - b.index
    })
    .map(entry => entry.subtask)
}

// ── DAG / lock / escalation core ─────────────────────────────────────────────

// STACKED MODE: nothing merges during a run, so "done" cannot mean "merged".
// A subtask this run has finished has an OPEN PR against its own stack parent,
// and its issue is still open — the old rule (CLOSED issue AND merged PR) would
// call every finished subtask unfinished and re-dispatch the whole stack.
//
// So: a subtask is done when a PR for it EXISTS against the correct base. The
// base check is what makes this safe, and it happens in Detect (see the
// 'wrong-base' sentinel) — a PR targeting the wrong branch is not evidence of
// anything and must not read as done. That is the #1133 bug, and inverting this
// rule without the base check would resurrect it immediately.
//
// A CLOSED issue with NO PR ever found still counts: that is work closed as
// already-delivered or duplicate (#1145 on refactor-nori m21, delivered
// incidentally by #1141), which must not be re-dispatched.
function isSubtaskDone(subtask) {
  if (subtask.pr && typeof subtask.pr === 'object') return true
  return String(subtask.state ?? '').toUpperCase() === 'CLOSED' && subtask.pr === null
}

// A CLOSED story is finished, full stop — never re-dispatch its subtasks.
// Per-subtask doneness leans on 30-odd PR lookups; during the 2026-08-17
// GitHub outage those returned null and closed stories were re-implemented.
// The story's single state field can't be corrupted piecemeal, so it is the
// safer gate; a story closed by mistake is reopened by hand.
function isStoryClosed(story) {
  return String(story.state ?? '').toUpperCase() === 'CLOSED'
}

function remainingSubtasks(story, ordinalPattern) {
  if (isStoryClosed(story)) return []
  return orderSubtasks((story.subtasks ?? []).filter(subtask => !isSubtaskDone(subtask)), ordinalPattern)
}

function computeLevels(stories, ordinalPattern) {
  const doneNumbers = new Set(
    stories.filter(story => isStoryClosed(story) || remainingSubtasks(story, ordinalPattern).length === 0)
      .map(story => story.number),
  )
  const pending = stories
    .filter(story => !doneNumbers.has(story.number))
    .sort((a, b) => a.number - b.number)
  const pendingNumbers = new Set(pending.map(story => story.number))

  const levels = []
  const placed = new Set()
  let rest = pending
  while (rest.length > 0) {
    // A dep is satisfied when the upstream story is fully done (not pending)
    // or placed in an earlier level.
    const ready = rest.filter(story => (story.blockedBy ?? [])
      .every(dep => !pendingNumbers.has(dep) || placed.has(dep)))
    if (ready.length === 0) {
      throw new Error(`orchestrator: dependency cycle among stories ${rest.map(story => `#${story.number}`).join(', ')}`)
    }
    levels.push(ready)
    for (const story of ready) placed.add(story.number)
    rest = rest.filter(story => !placed.has(story.number))
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
  const byNumber = new Map(stories.map(story => [story.number, story]))
  const state = new Map()   // number -> 'visiting' | 'done'
  const walk = (number, trail) => {
    if (state.get(number) === 'done') return
    if (state.get(number) === 'visiting') {
      const cycle = [...trail.slice(trail.indexOf(number)), number].map(n => `#${n}`).join(' -> ')
      throw new Error(`orchestrator: dependency cycle among stories ${cycle} — no stack can be rooted until it is broken`)
    }
    state.set(number, 'visiting')
    for (const dep of byNumber.get(number)?.blockedBy ?? []) {
      if (byNumber.has(dep)) walk(dep, [...trail, number])
    }
    state.set(number, 'done')
  }
  for (const story of stories) walk(story.number, [])
}

function subtaskBranch(subtask, branchPrefix) {
  // Prefer a PR's real head ref: a resumed stack may carry an older prefix, and
  // the branch that actually exists is the one the next subtask must target.
  if (subtask.pr && typeof subtask.pr === 'object' && subtask.pr.ref) return subtask.pr.ref
  return `${branchPrefix}${subtask.number}`
}

// The branch a story's stack ends on — what a dependent story roots from.
function storyTip(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch, seen = new Set()) {
  const ordered = orderSubtasks(story.subtasks ?? [], ordinalPattern)
  if (ordered.length > 0) return subtaskBranch(ordered[ordered.length - 1], branchPrefix)
  // A story with no subtasks contributes no branch; fall through to its own root.
  return storyRoot(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch, seen)
}

// Where a story's stack starts. Returns a branch name, or throws with a message
// meant for a human when the shape is one this cannot decide.
function storyRoot(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch, seen = new Set()) {
  if (seen.has(story.number)) {
    throw new Error(`orchestrator: dependency cycle reached story #${story.number} while computing its stack root`)
  }
  seen.add(story.number)
  // Only blockers inside this milestone can be stacked on; anything else is
  // external work whose branch this run knows nothing about.
  const blockers = (story.blockedBy ?? []).filter(dep => storiesByNumber.has(dep))
  if (blockers.length === 0) return baseBranch
  if (blockers.length > 1) {
    // Deliberately not guessing. Rooting on one blocker silently builds this
    // story without the others' code; an octopus base would need a merge, which
    // is exactly what this mode does not do. A human picks: merge the blockers
    // first, or split the story.
    throw new Error(
      `orchestrator: story #${story.number} is blocked by ${blockers.length} stories (${blockers.map(n => `#${n}`).join(', ')}), `
      + 'and stacked mode can only root a stack on ONE parent branch. Merge those blockers into '
      + `${baseBranch} first, or restructure the dependencies so this story has a single blocker.`)
  }
  return storyTip(storiesByNumber.get(blockers[0]), storiesByNumber, branchPrefix, ordinalPattern, baseBranch, seen)
}

// The base each remaining subtask's PR targets: the previous subtask in the
// story's FULL order, or the story's root for the first one.
function stackBases(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch) {
  const ordered = orderSubtasks(story.subtasks ?? [], ordinalPattern)
  const root = storyRoot(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch)
  const bases = new Map()
  ordered.forEach((subtask, index) => {
    bases.set(subtask.number, index === 0 ? root : subtaskBranch(ordered[index - 1], branchPrefix))
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

function escalation({ level, story, subtask, pr, trigger, baseBranch, attempts }) {
  if (trigger !== 'tests' && trigger !== 'blocked') {
    throw new Error(`orchestrator: unknown escalation trigger "${trigger}" (expected "tests" or "blocked")`)
  }
  const message = `orchestrator STOPPED: story #${story} subtask #${subtask} (level ${level}) could not be dispatched/verified against ${baseBranch} — trigger: ${trigger}. Nothing was merged; this run opens stacked PRs only. ${(attempts ?? []).length} note(s) recorded.`
  return { escalated: true, level, story, subtask, pr, trigger, baseBranch, attempts: attempts ?? [], message }
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
const milestoneNumber = Number(opts.milestone ?? opts.milestoneNumber)
if (!Number.isInteger(milestoneNumber) || milestoneNumber <= 0) {
  throw new Error('orchestrator needs a milestone NUMBER, e.g. args: {"repo":"owner/name","repoDir":"/abs/path","milestone":4,"baseBranch":"main","nonce":"<now>"}')
}
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
if (opts.autoMerge !== undefined || opts.maxResolveAttempts !== undefined) {
  throw new Error(
    'orchestrator: args.autoMerge / args.maxResolveAttempts are no longer supported — this workflow opens '
    + 'stacked PRs and never merges, so there is nothing to auto-merge and no conflicts to resolve mid-run.')
}
const labels = { story: 'story', subtask: 'subtask', ...(opts.labels || {}) }
const branchPrefix = typeof opts.branchPrefix === 'string' ? opts.branchPrefix : 'task-'
const ordinalPattern = typeof opts.ordinalPattern === 'string' ? opts.ordinalPattern : DEFAULT_ORDINAL
const coauthor = typeof opts.coauthor === 'string' ? opts.coauthor : 'Claude <noreply@anthropic.com>'
// Caps how many stories within one DAG level are in flight at once — separate
// from the harness's own global agent() concurrency cap, which throttles
// individual agent calls but not story lanes (each lane makes many calls across
// its subtasks' Intake/Spec/.../Ship phases). A wide level (e.g. 10 independent
// level-0 stories) once spun up 10 worktrees simultaneously, which is what this
// option exists to bound. Default 4.
const maxConcurrentStories = Number.isInteger(opts.maxConcurrentStories) && opts.maxConcurrentStories > 0
  ? opts.maxConcurrentStories
  : 4
const [owner, repoName] = repo.split('/')

// Workflow scripts cannot locate their own directory, so the sibling script
// must be named explicitly — no default: this repo can be checked out at any
// path by anyone, so a baked-in absolute path here would be exactly the kind
// of machine-specific hardcoding this plugin avoids everywhere else. Wrong or
// missing path fails at launch, not mid-milestone.
const taskScript = typeof opts.taskScript === 'string' && opts.taskScript.startsWith('/')
  ? opts.taskScript
  : (() => { throw new Error(
      'orchestrator needs args.taskScript as an absolute path to this checkout\'s workflows/task.js '
      + '(e.g. "<repo>/workflows/task.js") — there is no default, since this repo can be checked out anywhere.') })()

// Board support is required unless waived: a forgotten args.project once
// skipped every card move without a single failure, and merged subtasks sat in
// Backlog for weeks. Pass boardless: true to run issues-and-PRs-only on purpose.
const projectArg = opts.project && typeof opts.project === 'object' ? opts.project : null
if (!projectArg && opts.boardless !== true) {
  throw new Error(
    'orchestrator needs args.project (e.g. {"number":13}) so subtask cards move ' +
    'Backlog -> In progress -> In review -> Done. Pass boardless: true to skip the board deliberately.')
}
const statusField = (projectArg && projectArg.statusField) || 'Status'
const optionNames = {
  backlog: 'Backlog', inProgress: 'In progress', inReview: 'In review', done: 'Done',
  ...((projectArg && projectArg.options) || {}),
}

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

// ── 1. Configure — board ids BY NAME ────────────────────────────────────────
phase('Configure')
let board = null
if (projectArg && Number.isInteger(Number(projectArg.number))) {
  const resolved = await callAgent(`Resolve GitHub Projects v2 ids for project number ${projectArg.number} owned by "${owner}" (repo ${repo}). Read only — do NOT create, edit, or delete anything, and do NOT create a missing field or option.

1. Try the user-owned query first; if its data is null, try the org-owned one:
gh api graphql -f query='query($o:String!,$n:Int!){user(login:$o){projectV2(number:$n){id title fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}' -f o="${owner}" -F n=${projectArg.number}
gh api graphql -f query='query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){id title fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}' -f o="${owner}" -F n=${projectArg.number}
2. Find the single-select field named exactly "${statusField}" and inside it the options named exactly: ${Object.entries(optionNames).map(([key, value]) => `${key}="${value}"`).join(', ')}.
3. Return the project id, field id, and the four option ids. If the field or ANY option is missing, return found=false naming exactly what is missing.

[cache-buster, ignore: ${nonce}]`,
    { label: `resolve-project:${projectArg.number}`, phase: 'Configure', model: 'haiku', effort: 'low', schema: {
      type: 'object', required: ['found'],
      properties: {
        found: { type: 'boolean' }, missing: { type: 'string' }, title: { type: 'string' },
        id: { type: 'string' }, fieldId: { type: 'string' },
        optionIds: { type: 'object', properties: {
          backlog: { type: 'string' }, inProgress: { type: 'string' },
          inReview: { type: 'string' }, done: { type: 'string' } } },
      },
    } })
  if (!resolved || !resolved.found) {
    // Board bookkeeping is not worth failing a milestone over, but a silent
    // downgrade is worse than a loud one.
    log(`board DISABLED for this run: ${resolved ? resolved.missing : 'project resolver died'} (see the github-project-setup skill)`)
  } else {
    board = { id: resolved.id, fieldId: resolved.fieldId, optionIds: resolved.optionIds, optionNames, statusField, number: projectArg.number }
    log(`board resolved: project ${projectArg.number} "${resolved.title || ''}" → ${resolved.id}`)
  }
} else {
  log('boardless: true — running issues and PRs only, no card moves')
}

// ── 2. Detect — raw GitHub state + verification commands; no judgement ──────
phase('Detect')
const detected = await callAgent(`Detect the remaining work on ${repo} milestone #${milestoneNumber}, checkout at ${repoDir}. Read state only — do NOT create, close, edit, comment on, or merge anything.

1. Resolve the milestone title: \`gh api repos/${repo}/milestones/${milestoneNumber} --jq .title\`. Then list its story issues:
   \`gh issue list --repo ${repo} --milestone "<title>" --label ${labels.story} --state all --json number,title,state\`
2. For each story, get its blockedBy edges via GraphQL (\`issue { blockedBy(first:50) { nodes { number } } }\`). Report ONLY the numbers — do NOT compute levels or interpret them; that happens in-script. If the repo uses no blockedBy relations, report empty arrays (that is normal, not an error).
3. For each story, list its sub-issues via \`gh api repos/${repo}/issues/<story number>/sub_issues --jq '.[] | {number, title, state}'\` (the native sub-issue relation). Do NOT substitute \`gh issue list --label ${labels.subtask}\`, which returns every subtask in the milestone with no link back to its parent. Preserve the ORDER THE ENDPOINT RETURNS and report titles VERBATIM — ordering depends on both.
4. For EACH SUBTASK, find its pull request by head branch, matching on the SUBTASK NUMBER and NOT on the branch prefix. Use the REST endpoint, NOT \`gh pr list\`:
   \`gh api "repos/${repo}/pulls?state=all&per_page=100" --paginate --jq '.[] | {number, url: .html_url, state, merged_at, ref: .head.ref, base: .base.ref}'\`
   Accept a PR for subtask N only if its \`ref\` ENDS WITH N and the character immediately before N is a non-digit — so \`aq-1050\`, \`task-1050\` and \`wip/1050\` all match subtask 1050, while \`task-11050\` does NOT. If several qualify, prefer one whose \`base\` is exactly \`${baseBranch}\`, then the merged one, then the most recent.
   MATCH ON THE NUMBER, NOT THE PREFIX — deliberate: prefix-exact matching once orphaned every PR merged under an earlier prefix, so finished work was re-dispatched and died on an empty diff (2026-08-18, #1050). Suffix matching makes doneness survive a prefix change; for the same reason NEVER randomise or timestamp \`branchPrefix\`.
   \`gh pr list\` goes through GraphQL, which returned empty results for genuinely-merged PRs during the 2026-08-17 GitHub incident; REST kept answering. Do NOT use free-text search (\`--search "<n> in:body"\` matches unrelated PRs). Set that subtask's pr to {number, url, state, merged, ref, base} where merged is true ONLY if merged_at is non-null and ref is the head branch verbatim. Always report \`base\` VERBATIM (never blank, never guessed) — the script, not you, decides what a wrong base means. Never infer merged from the issue being closed.

   **If that command ERRORS or times out** (non-zero exit, 5xx, "no server is currently available"), retry it up to 3 times with a short pause. If it still fails, set that subtask's pr to the string "unknown" — NOT null. null means "this subtask has no PR and is unstarted work"; an API failure is not evidence of that (reporting failures as null re-implemented merged subtasks, 2026-08-17). Report an empty result as null only when the command actually SUCCEEDED and returned nothing.
5. Discover this repo's OWN verification commands — do not assume a toolchain. Read whichever exist: ${repoDir}/CLAUDE.md, the testing/standards doc it points to, .github/workflows/*, and the project manifest (pyproject.toml / package.json / Makefile / justfile). Return the exact full-suite command(s) (each separate invocation listed separately if the repo requires tiers to run apart), the typecheck command (empty if none), the lint/format commands (empty array if none), and which file(s) you took them from.

Return the raw structure. No summarizing, no judging what is "done". [cache-buster, ignore: ${nonce}]`,
  { label: `detect:m${milestoneNumber}`, phase: 'Detect', model: 'haiku', schema: {
    type: 'object', required: ['stories', 'verification'],
    properties: {
      milestoneTitle: { type: 'string' },
      stories: { type: 'array', items: {
        type: 'object', required: ['number', 'title', 'blockedBy', 'subtasks'],
        properties: {
          number: { type: 'integer' }, title: { type: 'string' }, state: { type: 'string' },
          blockedBy: { type: 'array', items: { type: 'integer' } },
          subtasks: { type: 'array', items: {
            type: 'object', required: ['number', 'title', 'state'],
            properties: {
              number: { type: 'integer' }, title: { type: 'string' }, state: { type: 'string' },
              // string is the "unknown" sentinel: the lookup itself failed,
              // which is NOT the same as "there is no PR" (null).
              pr: { type: ['object', 'null', 'string'], properties: {
                number: { type: 'integer' }, url: { type: 'string' },
                state: { type: 'string' }, merged: { type: 'boolean' },
                ref: { type: 'string' }, base: { type: 'string' } } },
            } } },
        } } },
      verification: {
        type: 'object', required: ['fullSuite'],
        properties: {
          fullSuite: { type: 'array', items: { type: 'string' } },
          typecheck: { type: 'string' },
          lint: { type: 'array', items: { type: 'string' } },
          verificationSource: { type: 'string' },
        } },
    },
  } })
if (!detected) throw new Error('detect agent died')

// The REST pulls API reports state lowercase ("open"); GitHub's GraphQL and
// gh's --json report it uppercase. Normalize once so no comparison downstream
// depends on which path the Detect agent took.
//
// Suffix matching is base-blind: a PR opened by mistake against another branch
// still matches by head ref, and treating it as this subtask's own work is the
// #1133 bug (PR #1150, head task-1133, base main, rediscovered as done across
// many runs on paulomtts/refactor-nori). The base check is what makes doneness
// trustworthy — and in stacked mode it carries even more weight, because
// isSubtaskDone now accepts an OPEN PR as done.
//
// The expected base is per-subtask, not the milestone base: subtask N stacks on
// N-1, and only a story's FIRST subtask targets the story root. Computed from
// the full ordered list, so an already-done predecessor still supplies the base.
const storiesByNumber = new Map(detected.stories.map(story => [story.number, story]))
assertNoBlockerCycles(detected.stories)
for (const story of detected.stories) {
  let expectedBases
  try {
    expectedBases = stackBases(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch)
  } catch (err) {
    // Multi-blocker or cyclic shapes are a human decision; surface the message
    // as-is rather than dispatching against a guessed base.
    throw err
  }
  for (const subtask of story.subtasks ?? []) {
    if (subtask.pr && typeof subtask.pr === 'object' && subtask.pr.state) {
      subtask.pr.state = String(subtask.pr.state).toUpperCase()
    }
    if (subtask.pr && typeof subtask.pr === 'object') {
      const prBase = String(subtask.pr.base ?? '')
      const wanted = expectedBases.get(subtask.number) || baseBranch
      if (!prBase) {
        subtask.pr = 'unknown'   // base unreported → doneness unverifiable, abort below
      } else if (prBase !== wanted) {
        log(`detect: ignoring PR #${subtask.pr.number} for subtask #${subtask.number} — base "${prBase}" is not its stack parent "${wanted}"`)
        subtask.pr = 'wrong-base'   // rejected, NOT the same as "no PR ever existed" — see isSubtaskDone
      }
    }
  }
}

// An "unknown" pr means the API did not answer, so doneness is genuinely
// unknown — guessing either way is wrong (guess "pending" re-implemented
// merged work twice on 2026-08-17). Stopping costs one re-run.
const unknownPrs = detected.stories.flatMap(story =>
  (story.subtasks ?? []).filter(subtask => subtask.pr === 'unknown')
    .map(subtask => `#${subtask.number} (story #${story.number})`))
if (unknownPrs.length > 0) {
  throw new Error(
    `orchestrator: PR lookup failed for ${unknownPrs.length} subtask(s) — ${unknownPrs.join(', ')}. `
    + 'Detect could not determine whether these are merged, so no dispatch is safe. '
    + 'Re-run once the GitHub API is answering reliably.')
}

const verification = detected.verification
const suiteCmds = (verification.fullSuite || []).filter(Boolean)
const suiteBlock = suiteCmds.length
  ? suiteCmds.map(command => `  - ${command}`).join('\n')
  : '  (NOT DOCUMENTED — find this repo\'s real full-suite command before claiming anything passes)'

const levels = computeLevels(detected.stories, ordinalPattern)
log(`milestone #${milestoneNumber} "${detected.milestoneTitle || ''}": ${detected.stories.length} stories, ${levels.length} dependency level(s)`)

if (DRY) {
  return {
    repo, milestone: milestoneNumber, milestoneTitle: detected.milestoneTitle, baseBranch,
    mode: 'dryRun',
    board: board ? { id: board.id, fieldId: board.fieldId, optionIds: board.optionIds } : null,
    verification,
    plan: levels.map((levelStories, levelIndex) => ({
      level: levelIndex,
      stories: levelStories.map(story => {
        const bases = stackBases(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch)
        return {
          story: story.number, title: story.title,
          root: storyRoot(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch),
          subtasks: remainingSubtasks(story, ordinalPattern).map(subtask => ({
            number: subtask.number, title: subtask.title, state: subtask.state,
            branch: `${branchPrefix}${subtask.number}`,
            // The whole point of a dry run in stacked mode: check this column.
            prTargets: bases.get(subtask.number) || baseBranch,
            prExisting: subtask.pr || null,
          })),
        }
      }),
    })),
    alreadyDone: detected.stories.filter(story => remainingSubtasks(story, ordinalPattern).length === 0).map(story => story.number),
    note: 'dryRun: nothing was dispatched, no board or GitHub write happened. One worktree/branch/PR per SUBTASK, '
      + 'dispatched sequentially within each story. Each PR targets its stack parent (prTargets), NOT the milestone base — '
      + 'verify that column before a real run. Nothing is ever merged.',
  }
}

if (levels.length === 0) {
  return { repo, milestone: milestoneNumber, baseBranch, done: true, reason: 'every story on this milestone has zero remaining subtasks' }
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
  if (halted) return { subtask: subtask.number, skipped: 'halted' }

  // Detect matches PRs by number-suffix, so a resumed PR's real head ref can
  // carry an older prefix — prefer it over the freshly-derived name.
  const branch = (subtask.pr && typeof subtask.pr === 'object' && subtask.pr.ref)
    ? subtask.pr.ref
    : `${branchPrefix}${subtask.number}`

  // A PR already exists against the right base, so this subtask is done for this
  // run — Detect verified the base, and isSubtaskDone accepts it. Nothing to
  // merge, nothing to close: the issue stays open and the card stays wherever
  // task.js left it, until a human merges the stack.
  if (subtask.pr && typeof subtask.pr === 'object') {
    return { subtask: subtask.number, story: story.number, pr: subtask.pr.number, branch,
      base: stackBase, stacked: true, note: 'PR already open against its stack parent — nothing to redo' }
  }

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
    dispatched = await workflow({ scriptPath: taskScript }, {
      repo, repoDir, issue: subtask.number, baseBranch: stackBase, branchPrefix, coauthor, verification,
      project: board ? { id: board.id, fieldId: board.fieldId, optionIds: board.optionIds, optionNames, statusField } : undefined,
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
    halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: null, baseBranch: stackBase, trigger: 'blocked',
      attempts: [{ attempt: 0, resolved: false, detail: `task workflow threw: ${message}${hint}` }] }))
    return { subtask: subtask.number, escalated: true }
  }

  if (!dispatched || dispatched.refused || dispatched.blocked || !dispatched.pr) {
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
          : blocked
            ? `task.js stopped at ${blocked}: ${dispatched.detail || dispatched.reason || 'no detail given'}`
            : `task.js returned no PR: ${JSON.stringify(dispatched)}`)
      : 'task.js returned nothing'
    const attempts = [{ attempt: 0, resolved: false, detail: why }]
    if (dispatched && dispatched.existingPr) {
      attempts.push({ attempt: 0, resolved: false, detail: `a PR (#${dispatched.existingPr}) already exists on branch ${branch} and is being driven by something other than this run` })
    }
    halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: dispatched && dispatched.pr, baseBranch: stackBase, trigger, attempts }))
    return { subtask: subtask.number, escalated: true }
  }

  // Belt and braces with task.js's own check: a non-numeric PR reference would
  // corrupt the stack geometry every later subtask is computed from.
  const prNumber = Number(dispatched.pr)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: null, baseBranch: stackBase, trigger: 'blocked',
      attempts: [{ attempt: 0, resolved: false, detail: `PR reference was not a number (${typeof dispatched.pr}) — refusing to stack the next subtask on it` }] }))
    return { subtask: subtask.number, escalated: true }
  }

  return { subtask: subtask.number, story: story.number, pr: prNumber,
    branch: dispatched.branch || branch, base: stackBase, stacked: true, plan: dispatched.plan }
}

// ── level loop + pipeline() barrier ─────────────────────────────────────────
const results = []
for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
  if (halted) break
  phase('Dispatch')
  const level = levels[levelIndex]
  log(`level ${levelIndex}: dispatching ${level.length} story/stories, up to ${maxConcurrentStories} at once — ${level.map(story => `#${story.number}`).join(', ')}`)
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
    const bases = stackBases(story, storiesByNumber, branchPrefix, ordinalPattern, baseBranch)
    for (const subtask of remainingSubtasks(story, ordinalPattern)) {
      if (halted) { out.push({ subtask: subtask.number, skipped: 'halted' }); continue }
      const stackBase = bases.get(subtask.number) || baseBranch
      const subtaskResult = await runSubtask(levelIndex, story, subtask, stackBase)
      out.push(subtaskResult)
      // Subtask N+1 branches off N's PUSHED branch, so N must have produced one.
      // Nothing is merged — `stacked` is the success signal now, not `merged`.
      if (!subtaskResult || subtaskResult.stacked !== true) break
    }
    return { story: story.number, root: bases.size ? [...bases.values()][0] : baseBranch, subtasks: out }
  })
  // mapWithConcurrency maps a thrown/dead story callback to null
  // rather than propagating — treat that as a halt, or level N+1 would
  // dispatch on top of a level that never finished.
  if (levelResults.some(result => result === null || result === undefined) && !halted) {
    halt({
      escalated: true, level: levelIndex, story: null, subtask: null, pr: null, trigger: 'blocked', baseBranch, attempts: [],
      message: `orchestrator STOPPED: level ${levelIndex} had a story lane die (returned null from mapWithConcurrency) with no escalation payload set — treating as a hard halt.`,
    })
  }
  results.push({ level: levelIndex, stories: levelResults })
}

// Escalation is returned, not thrown, so the payload reaches the top-level
// session structurally intact. `halted` only stops NEW dispatch — in-flight
// stages in the current level finish naturally.
if (halted) return { repo, milestone: milestoneNumber, baseBranch, mode: 'stacked', ...halted, completed: results }
return { repo, milestone: milestoneNumber, baseBranch, mode: 'stacked', done: true, levels: levels.length, completed: results,
  note: 'Nothing was merged. Each story is a stack of open PRs, each targeting the previous subtask\'s branch; '
    + 'merge each stack bottom-up. Subtask issues are still OPEN and their cards sit at "In review" until you do.' }
