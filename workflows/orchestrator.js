export const meta = {
  name: 'orchestrator',
  description: 'Drive a whole GitHub milestone on any repo: resolve the project board ids by name, compute the story dependency DAG from blockedBy, dispatch each level\'s stories in parallel — each story\'s own subtasks run SEQUENTIALLY, one worktree/branch/PR per subtask, merged through one lock before the next subtask starts — resolve conflicts and post-merge test failures with a capped Opus agent, and full-stop on escalation.',
  whenToUse: 'User asks to run a whole milestone end-to-end: "/orchestrator milestone 4", "run milestone 3 on refactor-nori". Preview first with dryRun.',
  phases: [
    { title: 'Configure', detail: 'project/field/option ids looked up BY NAME, plus the repo\'s own verification commands', model: 'haiku' },
    { title: 'Detect', detail: 'stories, blockedBy edges, sub-issues, existing per-subtask PRs', model: 'haiku' },
    { title: 'Dispatch', detail: 'per-level pipeline over stories; each story\'s subtasks sequential, task.js once per subtask', model: 'sonnet' },
    { title: 'Merge', detail: 'lock-serialized merge + full suite + close + board, once per subtask', model: 'haiku' },
    { title: 'Resolve', detail: 'conflict / post-merge test-failure resolution, capped', model: 'opus' },
  ],
}

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

// Done needs EITHER a merged PR, OR a closed issue with NO PR EVER FOUND —
// the latter covers a subtask closed as already-delivered/duplicate work
// (task.js's own Intake can determine this and close without opening a PR;
// #1145 on paulomtts/refactor-nori milestone 21, delivered incidentally by
// #1141). A closed issue whose PR was found but rejected for the WRONG base
// (the 'wrong-base' sentinel, not real null) must NOT read as done — that
// silently resurrects the #1133 bug this same file already fixed once.
function isSubtaskDone(subtask) {
  if (String(subtask.state ?? '').toUpperCase() !== 'CLOSED') return false
  if (subtask.pr && subtask.pr.merged === true) return true
  return subtask.pr === null
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

// In-script mutex, not a distributed lock. `.catch(() => {})` on the stored
// tail is essential: a failed merge must not jam every subsequent merge.
function makeMergeLock() {
  let queue = Promise.resolve()
  return function withMergeLock(fn) {
    const next = queue.then(fn, fn)
    queue = next.catch(() => {})
    return next
  }
}

function escalation({ level, story, subtask, pr, trigger, baseBranch, attempts }) {
  if (trigger !== 'conflict' && trigger !== 'tests' && trigger !== 'blocked') {
    throw new Error(`orchestrator: unknown escalation trigger "${trigger}" (expected "conflict", "tests", or "blocked")`)
  }
  const message = trigger === 'blocked'
    ? `orchestrator STOPPED: story #${story} subtask #${subtask} (level ${level}) could not be dispatched/verified against ${baseBranch} — no merge was attempted. ${(attempts ?? []).length} note(s) recorded.`
    : `orchestrator STOPPED: story #${story} subtask #${subtask} (level ${level}) could not be merged into ${baseBranch} — trigger: ${trigger}. ${(attempts ?? []).length} resolution attempt(s) failed.`
  return { escalated: true, level, story, subtask, pr, trigger, baseBranch, attempts: attempts ?? [], message }
}

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
  throw new Error('orchestrator needs args.baseBranch (what every subtask PR targets)')
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
// autoMerge:false stops after each subtask's PR opens; since subtask N+1
// builds on N's merged code, a story then advances only ONE subtask per run —
// by design (see README).
const autoMerge = opts.autoMerge !== false
const labels = { story: 'story', subtask: 'subtask', ...(opts.labels || {}) }
const branchPrefix = typeof opts.branchPrefix === 'string' ? opts.branchPrefix : 'task-'
const ordinalPattern = typeof opts.ordinalPattern === 'string' ? opts.ordinalPattern : DEFAULT_ORDINAL
const coauthor = typeof opts.coauthor === 'string' ? opts.coauthor : 'Claude <noreply@anthropic.com>'
const MAX_RESOLVE_ATTEMPTS = Number.isInteger(opts.maxResolveAttempts) ? opts.maxResolveAttempts : 3
const [owner, repoName] = repo.split('/')

// Merge + full-suite verification never run in repoDir: concurrent task.js
// pipelines are actively mutating its git state. This worktree is only touched
// inside the merge lock, so one path reused across merges is safe.
const MERGE_WORKTREE = `${repoDir}/.claude/worktrees/orchestrator-merge`

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
// Suffix matching is base-blind: a PR opened by mistake against another
// branch still matches by head ref, and "merged" then meant merged into the
// WRONG branch — that closed #1133 repeatedly across many runs on
// paulomtts/refactor-nori (PR #1150, head task-1133, base main) despite the
// work never reaching analysis-milestone-dev. Only work merged into THIS
// run's baseBranch counts as done.
for (const story of detected.stories) {
  for (const subtask of story.subtasks ?? []) {
    if (subtask.pr && typeof subtask.pr === 'object' && subtask.pr.state) {
      subtask.pr.state = String(subtask.pr.state).toUpperCase()
    }
    if (subtask.pr && typeof subtask.pr === 'object') {
      const prBase = String(subtask.pr.base ?? '')
      if (!prBase) {
        subtask.pr = 'unknown'   // base unreported → doneness unverifiable, abort below
      } else if (prBase !== baseBranch) {
        log(`detect: ignoring PR #${subtask.pr.number} for subtask #${subtask.number} — base "${prBase}" is not "${baseBranch}"`)
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
      stories: levelStories.map(story => ({
        story: story.number, title: story.title,
        subtasks: remainingSubtasks(story, ordinalPattern).map(subtask => ({
          number: subtask.number, title: subtask.title, state: subtask.state,
          branch: `${branchPrefix}${subtask.number}`, prExisting: subtask.pr || null,
        })),
      })),
    })),
    alreadyDone: detected.stories.filter(story => remainingSubtasks(story, ordinalPattern).length === 0).map(story => story.number),
    note: 'dryRun: nothing was dispatched, no board or GitHub write happened. One worktree/branch/PR per SUBTASK listed above, dispatched sequentially within each story.',
  }
}

if (levels.length === 0) {
  return { repo, milestone: milestoneNumber, baseBranch, done: true, reason: 'every story on this milestone has zero remaining subtasks' }
}

// ── merge lock + halt flag ──────────────────────────────────────────────────
const withMergeLock = makeMergeLock()
let halted = null   // escalation payload; stops all NEW dispatch

// Stories run concurrently, so two can escalate in the same tick — the FIRST
// payload is the root cause and must not be overwritten.
function halt(payload) {
  if (!halted) halted = payload
}

// ── per-subtask stage ────────────────────────────────────────────────────────
async function runSubtask(levelIndex, story, subtask) {
  if (halted) return { subtask: subtask.number, skipped: 'halted' }

  // Detect matches PRs by number-suffix, so a resumed PR's real head ref can
  // carry an older prefix — prefer it over the freshly-derived name.
  const branch = (subtask.pr && typeof subtask.pr === 'object' && subtask.pr.ref)
    ? subtask.pr.ref
    : `${branchPrefix}${subtask.number}`

  const boardBlock = board ? `
   a. Find the card: \`ITEM_ID=$(gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:10){nodes{id project{id}}}}}}' -f o="${owner}" -f r="${repoName}" -F n=${subtask.number} --jq '.data.repository.issue.projectItems.nodes[] | select(.project.id=="${board.id}") | .id')\`
   b. Set its Status to "${optionNames.done}": \`gh api graphql -f query='mutation($i:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:"${board.id}",itemId:$i,fieldId:"${board.fieldId}",value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' -f i="$ITEM_ID" -f o="${board.optionIds.done}"\` (pass -f, not -F, for the option id).
   c. Mirror the parent story #${story.number}: fetch its sub-issues' Status via \`gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){subIssues(first:50){nodes{number projectItems(first:10){nodes{project{id} fieldValueByName(name:"${statusField}"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}}}' -f o="${owner}" -f r="${repoName}" -F n=${story.number}\` (missing value counts as "${optionNames.backlog}"). If EVERY sub-issue is "${optionNames.done}", set the story's own card to "${optionNames.done}" too (same mutation, story's item id) and, if the story issue is still OPEN, close it with \`gh issue close ${story.number} --repo ${repo} --comment "All sub-issues merged into ${baseBranch}. Story complete."\`. Otherwise leave the story's card as-is.` : '   (this run is boardless — skip all card moves)'

  // PR already merged but the issue is still open (a prior run died between
  // merge and close): only bookkeeping remains. Re-dispatching task.js here
  // would re-implement merged work — same failure class as the prefix orphan.
  if (subtask.pr && typeof subtask.pr === 'object' && subtask.pr.merged === true) {
    const bookkeeping = await callAgent(`PR #${subtask.pr.number} for ${repo} subtask #${subtask.number} is already MERGED into ${baseBranch} (verify with \`gh pr view ${subtask.pr.number} --repo ${repo} --json state,mergeCommit\` — if it is NOT merged, stop and return closed=false saying so), but the issue is still open. Finish ONLY the bookkeeping: close subtask #${subtask.number} (\`gh issue close ${subtask.number} --repo ${repo} --comment "Merged via PR #${subtask.pr.number} into ${baseBranch}."\`, skip if already closed), then the card move to "${optionNames.done}" and the story mirror:
${boardBlock}
Do NOT touch git, code, or CI. Return closed=true/false and detail.`,
      { label: `close-orphan:subtask#${subtask.number}`, phase: 'Merge', model: 'haiku', effort: 'low', schema: {
        type: 'object', required: ['closed', 'detail'],
        properties: { closed: { type: 'boolean' }, detail: { type: 'string' } },
      } })
    if (bookkeeping && bookkeeping.closed) {
      return { subtask: subtask.number, merged: true, pr: subtask.pr.number, note: 'was already merged; closed the orphaned issue + board' }
    }
    halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: subtask.pr.number, baseBranch, trigger: 'blocked',
      attempts: [{ attempt: 0, resolved: false, detail: `PR already merged but close/board bookkeeping failed: ${bookkeeping ? bookkeeping.detail : 'bookkeeping agent died'}` }] }))
    return { subtask: subtask.number, escalated: true }
  }

  let taskOutput

  if (subtask.pr && typeof subtask.pr === 'object' && subtask.pr.number && subtask.pr.state === 'OPEN') {
    // A prior run opened this PR and died before merge. Re-invoking task.js
    // would collide with the live branch/PR — skip straight to merge.
    taskOutput = { pr: subtask.pr.number, branch, plan: '(resumed subtask: the PR already existed; original plan file is not available here)' }
  } else {
    let dispatched = null
    let thrown = null
    try {
      // {scriptPath}, not the bare name 'task': Workflow-by-name resolves
      // through a cache that can replay a stale script after an edit (see
      // README) — nested calls are just as exposed.
      dispatched = await workflow({ scriptPath: taskScript }, {
        repo, repoDir, issue: subtask.number, baseBranch, branchPrefix, coauthor, verification,
        project: board ? { id: board.id, fieldId: board.fieldId, optionIds: board.optionIds, optionNames, statusField } : undefined,
      })
    } catch (err) {
      thrown = err
    }
    if (thrown) {
      // An unreadable scriptPath surfaces here, one subtask in, and reads like
      // a task failure unless the path is named.
      const message = String((thrown && thrown.message) || thrown)
      const hint = message.includes(taskScript)
        ? ` — task.js was not readable at ${taskScript}; pass args.taskScript if these workflows live elsewhere on this machine`
        : ''
      halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: null, baseBranch, trigger: 'blocked',
        attempts: [{ attempt: 0, resolved: false, detail: `task workflow threw: ${message}${hint}` }] }))
      return { subtask: subtask.number, escalated: true }
    }
    if (!dispatched || dispatched.refused || dispatched.blocked || !dispatched.pr) {
      // Only `blocked: 'tests'` is a real test failure; a validation blocker
      // or refusal never attempted anything mergeable.
      const trigger = dispatched && dispatched.blocked === 'tests' ? 'tests' : 'blocked'
      halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: dispatched && dispatched.pr, baseBranch, trigger,
        attempts: [{ attempt: 0, resolved: false, detail: `task workflow did not produce a PR: ${JSON.stringify(dispatched)}` }] }))
      return { subtask: subtask.number, escalated: true }
    }
    taskOutput = dispatched
  }

  // Belt and braces with task.js's own check: this value is interpolated into
  // the merge agent's prompt, and a poisoned prompt gets classifier-blocked,
  // which halts the milestone.
  const prNumber = Number(taskOutput.pr)
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: null, baseBranch, trigger: 'blocked',
      attempts: [{ attempt: 0, resolved: false, detail: `PR reference was not a number (${typeof taskOutput.pr}, ${String(taskOutput.pr).length} chars) — refusing to build a merge prompt from it` }] }))
    return { subtask: subtask.number, escalated: true }
  }
  taskOutput = { ...taskOutput, pr: prNumber }

  if (!autoMerge) {
    return { subtask: subtask.number, story: story.number, pr: taskOutput.pr, branch: taskOutput.branch, opened: true, merged: false,
      note: 'autoMerge disabled — PR opened, awaiting manual merge (this story cannot advance past this subtask until it merges)' }
  }

  // Merge, full-suite verification, and up to MAX_RESOLVE_ATTEMPTS resolve
  // attempts all inside ONE lock acquisition — a nested withMergeLock here
  // would self-deadlock, so the resolve loop calls the agent directly.
  // (No phase() inside: stories run concurrently and phase() mutates global
  // transcript-grouping state.)
  let settlement
  try {
    settlement = await withMergeLock(async () => {
      const mergeReport = await callAgent(`Merge PR #${taskOutput.pr} (branch ${taskOutput.branch}) into ${baseBranch} for ${repo} subtask #${subtask.number} (story #${story.number}). You hold an exclusive merge lock — no other merge runs concurrently. IMPORTANT: do all of this in the dedicated merge worktree below, NOT in ${repoDir} directly — other subtasks' task.js runs may have that checkout on an unrelated branch at any moment.

0. Set up the merge worktree DETACHED at origin/${baseBranch} — detached, so it can never hit "branch already checked out" when ${baseBranch} is checked out in ${repoDir} or another worktree: from ${repoDir} run \`git fetch origin\`, then \`git worktree add --detach ${MERGE_WORKTREE} origin/${baseBranch} 2>/dev/null || true\` (the worktree may exist from an earlier merge); then \`cd ${MERGE_WORKTREE} && git fetch origin && git checkout --detach origin/${baseBranch}\`. All remaining steps run from ${MERGE_WORKTREE} (gh commands are location-independent).
1. Wait for CI: \`gh pr checks ${taskOutput.pr} --repo ${repo} --watch\` (or poll \`gh pr checks ${taskOutput.pr} --repo ${repo}\` every ~30s). If the repo has no checks configured, continue.
2. If any check fails: do NOT merge, do NOT close anything — return merged=false, conflict=false, detail=<failing check names + output>.
3. \`gh pr merge ${taskOutput.pr} --repo ${repo} --squash --delete-branch\`. If it reports a conflict, return merged=false, conflict=true, detail=<the conflicting paths>.
4. \`gh pr merge\`'s exit code is NOT proof of a merge. Verify independently: \`gh pr view ${taskOutput.pr} --repo ${repo} --json state,mergeCommit\` must show state exactly "MERGED" and a non-null mergeCommit. If not, return merged=false with what gh actually showed, and do NOT close anything.
5. Only after that verification: in ${MERGE_WORKTREE}, \`git fetch origin && git reset --hard origin/${baseBranch}\` and run the FULL suite:
${suiteBlock}
   If it is red, return merged=true, suiteGreen=false, detail=<failures>. Do NOT close anything.
6. If green: close the subtask (\`gh issue close ${subtask.number} --repo ${repo} --comment "Merged via PR #${taskOutput.pr} into ${baseBranch}."\`, skip if already closed — the PR's "Closes #${subtask.number}" line may have done it already, verify with \`gh issue view ${subtask.number} --repo ${repo} --json state\`), then move its card to "${optionNames.done}" and mirror the parent story:
${boardBlock}
7. Still only if green: clear this subtask's local debris — the remote branch is gone (--delete-branch), and a leftover local worktree/branch is exactly what collides with future runs: \`git -C ${repoDir} worktree remove --force ${repoDir}/.claude/worktrees/${taskOutput.branch}\` then \`git -C ${repoDir} branch -D ${taskOutput.branch}\` (each may legitimately fail if already gone — ignore that). NEVER touch any other worktree or branch.

Do NOT close anything unless steps 4 and 5 both verified success. Return merged, conflict, suiteGreen, closed, carded, detail. Report carded honestly: true only if you actually set the card's Status to "${optionNames.done}" and saw the mutation succeed${board ? '' : ' (this run is boardless, so report carded: false)'}.`,
        { label: `merge:subtask#${subtask.number}`, phase: 'Merge', model: 'haiku', schema: {
          type: 'object', required: ['merged', 'conflict', 'suiteGreen', 'closed', 'detail'],
          properties: { merged: { type: 'boolean' }, conflict: { type: 'boolean' },
            suiteGreen: { type: 'boolean' }, closed: { type: 'boolean' },
            carded: { type: 'boolean' }, detail: { type: 'string' } },
        } })
      if (!mergeReport) throw new Error(`merge agent died on subtask #${subtask.number}`)

      // A missed card move does not fail the merge, but must not pass
      // silently — that is how 25 merged subtasks accumulated in Backlog.
      if (board && mergeReport.merged && mergeReport.suiteGreen && mergeReport.carded !== true) {
        log(`board WARNING: #${subtask.number} merged but its card did not reach "${optionNames.done}" — ${mergeReport.detail || 'no detail'}`)
      }

      if (mergeReport.merged && mergeReport.suiteGreen && mergeReport.closed) {
        return { done: true, subtask: subtask.number, merged: true, pr: taskOutput.pr }
      }

      // Merge + suite green but close/board failed — bookkeeping, not a test
      // failure: one cheap retry, no Opus (nothing to diagnose).
      if (mergeReport.merged && mergeReport.suiteGreen && !mergeReport.closed) {
        const closeRetry = await callAgent(`PR #${taskOutput.pr} for ${repo} subtask #${subtask.number} merged into ${baseBranch} and the full suite was green, but closing the issue / moving the board cards failed: ${mergeReport.detail}. Retry ONLY that bookkeeping: verify-and-close subtask #${subtask.number}, then the card move to "${optionNames.done}" and the story-mirror:
${boardBlock}
Do NOT touch git, code, or CI. Return closed=true/false and detail.`,
          { label: `close-retry:subtask#${subtask.number}`, phase: 'Merge', model: 'haiku', effort: 'low', schema: {
            type: 'object', required: ['closed', 'detail'],
            properties: { closed: { type: 'boolean' }, detail: { type: 'string' } },
          } })
        if (closeRetry && closeRetry.closed) return { done: true, subtask: subtask.number, merged: true, pr: taskOutput.pr }
        return { done: false, trigger: 'blocked', outcome: mergeReport, attempts: [{ attempt: 0, resolved: false, detail: `merge+suite succeeded but close/board bookkeeping failed twice: ${closeRetry ? closeRetry.detail : 'close-retry agent died'}` }] }
      }

      const trigger = mergeReport.conflict ? 'conflict' : 'tests'
      const attempts = []
      for (let attempt = 1; attempt <= MAX_RESOLVE_ATTEMPTS; attempt++) {
        if (halted) break
        const resolveReport = await callAgent(`Resolve a ${trigger === 'conflict' ? 'merge conflict' : 'post-merge test failure'} for ${repo} subtask #${subtask.number} (story #${story.number}, PR #${taskOutput.pr}, branch ${taskOutput.branch}) against ${baseBranch}. Attempt ${attempt} of ${MAX_RESOLVE_ATTEMPTS}. You hold the exclusive merge lock.

What happened: ${mergeReport.detail}
${attempts.length ? `Previous attempts:\n${attempts.map(priorAttempt => `- attempt ${priorAttempt.attempt}: ${priorAttempt.detail}`).join('\n')}` : ''}
Plan for this subtask: ${taskOutput.plan || '(none recorded)'}

You have FULL autonomy in a scratch worktree at ${repoDir}/.claude/worktrees/resolve-${subtask.number} (a previous attempt may have left it behind — \`git -C ${repoDir} worktree remove --force\` it first, then \`git worktree add\` it fresh on whatever ref you need):
- Read BOTH sides' intent — this subtask's plan/spec and the code the other branch landed — do not just diff and pick a side. Two branches can each be individually correct and still need a synthesized third design.
- Edit code freely; you are NOT limited to deleting conflict markers. Change signatures, unify plumbing, update BOTH sides' call sites and tests if that is what the merged design needs.
- Re-run this repo's verification until green:
${suiteBlock}
${verification.typecheck ? `  - ${verification.typecheck}\n` : ''}${(verification.lint || []).filter(Boolean).map(command => `  - ${command}`).join('\n')}
- Commit granularly, ending each message with:
Co-Authored-By: ${coauthor}
- Then complete the merge into ${baseBranch}, verify it the same way (\`gh pr view ${taskOutput.pr} --repo ${repo} --json state,mergeCommit\` must show MERGED + non-null mergeCommit, OR ${baseBranch} must contain your merge commit), re-run the full suite on ${baseBranch}, and only then close subtask #${subtask.number} and move its card + the story mirror:
${boardBlock}
- On success, remove your scratch worktree (\`git -C ${repoDir} worktree remove --force ${repoDir}/.claude/worktrees/resolve-${subtask.number}\`); on failure leave it for the next attempt.

Never weaken, skip, xfail, or delete a test to make the suite green — that is an automatic failure of this attempt. Return resolved=true only if the merge is verified, the full suite is green, and the issue is closed. Otherwise resolved=false with exactly what you tried and why it failed.`,
          { label: `resolve:subtask#${subtask.number}:${attempt}`, phase: 'Resolve', model: 'opus', schema: {
            type: 'object', required: ['resolved', 'detail'],
            properties: { resolved: { type: 'boolean' }, detail: { type: 'string' } },
          } })
        attempts.push({ attempt, resolved: Boolean(resolveReport && resolveReport.resolved), detail: resolveReport ? resolveReport.detail : 'resolve agent died' })
        if (resolveReport && resolveReport.resolved) return { done: true, subtask: subtask.number, merged: true, resolvedIn: attempt, pr: taskOutput.pr }
      }

      return { done: false, trigger, outcome: mergeReport, attempts }
    })
  } catch (err) {
    halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: taskOutput.pr, baseBranch, trigger: 'blocked',
      attempts: [{ attempt: 0, resolved: false, detail: `merge lock callback threw: ${err && err.message ? err.message : err}` }] }))
    return { subtask: subtask.number, escalated: true }
  }

  if (settlement.done) {
    const { done, ...result } = settlement
    return result
  }
  if (halted) return { subtask: subtask.number, skipped: 'halted' }
  halt(escalation({ level: levelIndex, story: story.number, subtask: subtask.number, pr: taskOutput.pr, trigger: settlement.trigger, baseBranch, attempts: settlement.attempts ?? [] }))
  return { subtask: subtask.number, escalated: true }
}

// ── level loop + pipeline() barrier ─────────────────────────────────────────
const results = []
for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
  if (halted) break
  phase('Dispatch')
  const level = levels[levelIndex]
  log(`level ${levelIndex}: dispatching ${level.length} story/stories in parallel — ${level.map(story => `#${story.number}`).join(', ')}`)
  // pipeline(items, ...stages) — the harness global — takes the items array
  // first and one stage function per remaining arg; it is NOT
  // pipeline(arrayOfRunnables). One story per item; that story's subtasks run
  // SEQUENTIALLY inside its stage function.
  const levelResults = await pipeline(level, async story => {
    const out = []
    for (const subtask of remainingSubtasks(story, ordinalPattern)) {
      if (halted) { out.push({ subtask: subtask.number, skipped: 'halted' }); continue }
      const subtaskResult = await runSubtask(levelIndex, story, subtask)
      out.push(subtaskResult)
      // Subtask N+1 must not dispatch until N is actually merged into
      // baseBranch — it branches fresh off that base. Escalated/skipped/
      // opened-only results also stop the story here.
      if (!subtaskResult || subtaskResult.merged !== true) break
    }
    return { story: story.number, subtasks: out }
  })
  // pipeline() maps a rejected/dead stage to null (Promise.allSettled inside)
  // rather than propagating — treat that as a halt, or level N+1 would
  // dispatch on top of a level that never finished.
  if (levelResults.some(result => result === null || result === undefined) && !halted) {
    halt({
      escalated: true, level: levelIndex, story: null, subtask: null, pr: null, trigger: 'blocked', baseBranch, attempts: [],
      message: `orchestrator STOPPED: level ${levelIndex} had a story pipeline stage die (returned null from pipeline()) with no escalation payload set — treating as a hard halt.`,
    })
  }
  results.push({ level: levelIndex, stories: levelResults })
}

// Escalation is returned, not thrown, so the payload reaches the top-level
// session structurally intact. `halted` only stops NEW dispatch — in-flight
// stages in the current level finish naturally.
if (halted) return { repo, milestone: milestoneNumber, baseBranch, ...halted, completed: results }
return { repo, milestone: milestoneNumber, baseBranch, done: true, levels: levels.length, completed: results }
