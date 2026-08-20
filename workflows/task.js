export const meta = {
  name: 'task',
  description: 'Drive ONE subtask issue end-to-end in its own worktree/branch: intake, spec, TDD implementation plan, adversarial validation, strict-TDD implementation, review, full verification, and a PR. Repo-agnostic: repo, board, and verification commands are arguments or discovered at runtime. Stops at PR — never merges.',
  whenToUse: 'User asks to work a subtask card: "/task 251", "pick up #252", "run the task workflow on 253". Also invoked per subtask, sequentially within a story, by the orchestrator workflow.',
  phases: [
    { title: 'Intake', detail: 'issue + parent story + repo docs; discover this repo\'s test/lint/typecheck commands; card -> In progress', model: 'sonnet' },
    { title: 'Spec', detail: 'scope, behavior, error paths, test list', model: 'opus' },
    { title: 'Plan', detail: 'TDD implementation plan from the spec', model: 'opus' },
    { title: 'Validate', detail: 'adversarial plan review, fixes folded in', model: 'sonnet' },
    { title: 'Implement', detail: 'worktree + strict TDD, granular commits', model: 'sonnet' },
    { title: 'Review', detail: 'branch diff review, test-integrity gate, lint; fixes committed here; unresolved blockers stop the run', model: 'opus' },
    { title: 'Ship', detail: 'clean-tree check + full verification, then push and open the PR (no merge); card -> In review', model: 'haiku' },
  ],
}

// ── pure decision logic ──────────────────────────────────────────────────────
// Everything between the PURE markers is a pure function of its arguments: no
// harness globals, no module-level state, no logging. workflows/task.test.mjs
// slices this region out of THIS file and imports it, so the gates are tested
// against the same bytes the workflow runs.
//
// These two gates are the run's hard stops, and both live here rather than
// inline because they are decisions about numbers and strings — deterministic,
// and worth being able to prove without a live dispatch. A gate that reaches
// for BRANCH or calls log() stops being testable, and load-pure.mjs will refuse
// the whole region rather than let that pass quietly.
// PURE:BEGIN

// An empty suite makes every downstream gate vacuous: Ship runs nothing and
// reports passed=true, Review has no red/green to work against, and the PR
// opens unverified. Observed on a run whose base branch documented no commands
// — the Ship agents happened to improvise and find the tests themselves, which
// is luck, not design, and their prompt explicitly tells them NOT to substitute
// commands. Fail loudly instead, with a deliberate opt-out for repos that
// genuinely have no suite yet.
function verificationGate(suiteCmds, allowNoVerification, callerProvided) {
  if (suiteCmds.length > 0) return null
  if (allowNoVerification === true) return null
  return {
    blocked: 'verification',
    detail: 'no full-suite command is available for this repo, so nothing downstream could verify this subtask — '
      + 'Ship would run zero commands and still report success. '
      + (callerProvided
          ? 'The caller passed an empty verification.fullSuite; the orchestrator discovers these from origin/<baseBranch>, so check that the base branch actually documents its test commands.'
          : 'Intake found none in CLAUDE.md, the CI workflows, or the manifest.')
      + ' Document the command, pass verification.fullSuite explicitly, or set allowNoVerification: true to proceed unverified on purpose.',
  }
}

// Number() is too eager to be a validator here: Number(null) and Number('')
// are both 0, so a Review that reported no count at all would be judged as
// having found ZERO COMMITS and the run would stop claiming the implementation
// produced nothing. That is a fabricated fact pinned on the wrong stage. An
// absent count is unusable, not zero — only a real number, or a string holding
// one, counts.
function countOf(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return NaN
}

// A Plan-Hash is the first 8 hex characters of sha256sum(<plan file>).
function isPlanHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value)
}

// Implement writes the trailers; Review recomputes the hash from the plan file
// independently, which is deliberate — Review is the ground truth a FUTURE run
// will reproduce, so it must never just echo what Implement claimed. Comparing
// the two costs no command and catches the one thing neither stage can see on
// its own: the plan file changing mid-run (ticked checkboxes are the usual
// culprit), which silently invalidates every trailer already written.
function planHashMismatch(implHash, reviewHash) {
  if (!isPlanHash(implHash) || !isPlanHash(reviewHash)) return null
  if (implHash === reviewHash) return null
  return `plan hash CHANGED mid-run: implement committed trailers as ${implHash}, review recomputed ${reviewHash} from the same plan file. `
    + 'The plan\'s bytes were modified after implementation, so every trailer on this branch is now stale and a future resume would hard-reset the work. '
    + 'The Plan-Hash gate below will stop the run; this is why.'
}

// The Review -> Ship boundary. Review is asked to REPORT three facts and never
// to interpret or act on them: an agent that both measures and judges can talk
// itself out of the judgement. Review is also the last stage that writes, so
// this is the earliest boundary at which the facts can be judged — and judging
// here costs no dispatch, because Ship simply never boots.
//
// Returns null to proceed, {blocked, detail} to stop, or {warn} when Review's
// numbers are unusable and the Plan-Hash half of the gate has to be skipped.
function reviewGate(review, branch, baseBranch) {
  const porcelain = String((review && review.porcelain) || '').trim()
  if (porcelain.length > 0) {
    return {
      blocked: 'tests',
      detail: `worktree still dirty after review, so the PR would not contain this work (nothing was pushed):\n${porcelain}`,
    }
  }

  // Implement decides RESUME vs RESET by grepping for exactly this trailer, so
  // an untagged commit reads as stale debris and a later run would
  // `reset --hard` it away. Catching that here, before anything is pushed, is
  // the whole point.
  const commitCount = countOf(review && review.commitCount)
  const taggedCount = countOf(review && review.taggedCount)
  if (!Number.isInteger(commitCount) || !Number.isInteger(taggedCount)) {
    return { warn: `review did not report usable commit/trailer counts (${review && review.commitCount}/${review && review.taggedCount}) — Plan-Hash gate skipped` }
  }
  if (commitCount === 0) {
    return {
      blocked: 'implement',
      detail: `branch ${branch} has no commits on top of ${baseBranch} — implementation produced nothing to ship.`,
    }
  }
  if (taggedCount < commitCount) {
    return {
      blocked: 'implement',
      detail: `only ${taggedCount} of ${commitCount} commits on ${branch} carry their Plan-Hash trailer, so a future run would read this branch as stale and hard-reset it. Nothing was pushed. Do NOT re-run this subtask until the trailers are added (interactively, by a human) or the work is otherwise preserved.`,
    }
  }
  return null
}
// PURE:END

// ── args ─────────────────────────────────────────────────────────────────────
let raw = args
if (typeof raw === 'string') {
  try { raw = JSON.parse(raw) } catch { raw = { issue: Number(raw) } }
}
const opts = raw && typeof raw === 'object' ? raw : {}

const issue = Number(opts.issue)
if (!Number.isInteger(issue) || issue <= 0) {
  throw new Error('task workflow needs a subtask issue number, e.g. args: {"repo":"owner/name","repoDir":"/abs/path","issue":251,"baseBranch":"main"}')
}
const repo = opts.repo
if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  throw new Error('task workflow needs args.repo as "owner/name"')
}
const repoDir = opts.repoDir
if (typeof repoDir !== 'string' || !repoDir.startsWith('/')) {
  throw new Error('task workflow needs args.repoDir as an absolute path to the checkout')
}
// Never defaulted: nothing maps a milestone to a branch, and guessing "main"
// would silently target the wrong integration branch.
const baseBranch = opts.baseBranch
if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
  throw new Error('task workflow needs args.baseBranch (the branch this subtask\'s PR will target)')
}

// Where the deterministic helpers live. Same wiring as the orchestrator's
// detectScript: an absolute path, no default, because this repo can be checked
// out anywhere. The orchestrator forwards it.
const scriptsDir = typeof opts.scriptsDir === 'string' && opts.scriptsDir.startsWith('/')
  ? opts.scriptsDir.replace(/\/+$/, '')
  : (() => { throw new Error(
      'task workflow needs args.scriptsDir as an absolute path to this checkout\'s scripts/ '
      + '(e.g. "<repo>/scripts") — plan-check and ship are run from there with `bun`.') })()

// The stages that only run a command get a lean agent type: tools: Bash and a
// one-line body, which drops ~16KB of tool and skill catalogue per dispatch.
// Measured on the orchestrator's triggers: 35,097 tokens -> 11,702 for the same
// work, byte-identical output. Pass '' to use the default subagent.
const triggerAgentType = typeof opts.triggerAgentType === 'string'
  ? opts.triggerAgentType
  : 'command-runner'
const triggerAgent = triggerAgentType ? { agentType: triggerAgentType } : {}

const branchPrefix = typeof opts.branchPrefix === 'string' ? opts.branchPrefix : 'task-'
const BRANCH = `${branchPrefix}${issue}`
const WORKTREE = `${repoDir}/.claude/worktrees/${BRANCH}`
const coauthor = typeof opts.coauthor === 'string' ? opts.coauthor : 'Claude <noreply@anthropic.com>'
const DRY = opts.dryRun === true

// ── doneness is the CALLER's question, not this workflow's ──────────────────
// This file assumes it was handed work that still needs doing, and it does not
// check. Deciding whether #${issue} is already merged, already has an open PR,
// or targets the wrong base is orchestrator.js's job: its Detect step
// suffix-matches every subtask's PR, drops any whose base is not this run's
// baseBranch, and aborts outright when the API will not answer; runSubtask then
// routes merged subtasks to bookkeeping and open-PR subtasks straight to merge,
// so task.js is only ever invoked for work with no live PR.
//
// An earlier version re-asked that same question here, as its own dispatch. It
// could only ever answer "nothing found" under the orchestrator, and having two
// files decide doneness meant two places to keep the base-branch rule correct —
// the #1133 bug (PR #1150, head task-1133, base main, rediscovered as done for
// many runs) had to be fixed in both. One owner, one rule.
//
// The time gap between Detect and this run is covered where it actually
// matters: Implement re-checks for a live PR on the branch before touching it.

// project: fully resolved ids, passed down by the orchestrator. REQUIRED —
// there is no boardless mode. A subtask that ships a PR while its card silently
// stays in Backlog is indistinguishable from one that never ran.
const project = opts.project && typeof opts.project === 'object' ? { ...opts.project } : null

// agent() can throw when the model returns without calling StructuredOutput —
// a transient harness fault, not a real blocker. Retry exactly once with an
// amended prompt (distinct cache key); a second failure falls through to the
// caller's own failure path.
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

// Free-text stage returns get pasted verbatim into the NEXT stage's prompt. A
// stage that goes off the rails returns pages of prose instead of a summary,
// and an oversized/garbled prompt built from it is exactly what got
// classifier-blocked and halted a milestone once (see the PR stage's own guard
// at the bottom of this file). Cap every such interpolation — the untruncated
// text is still in the journal, so nothing is actually lost for debugging.
function clip(text, max, what) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  log(`${what} returned ${value.length} chars — clipped to ${max} for the next prompt`)
  return `${value.slice(0, max)}

[TRUNCATED: ${what} returned ${value.length} characters, capped at ${max}. If this reads as cut off mid-thought, treat the truncation ITSELF as evidence the upstream stage over-ran its brief — say so in your output rather than guessing what the missing text said.]`
}

// ── board — orchestrator-resolved ids only ───────────────────────────────────
// Ids are NOT looked up here. The orchestrator resolves them once per milestone
// in its Configure phase and forwards the resolved block to every subtask, so
// this workflow only ever receives them ready-made — no dispatch, no GraphQL.
//
// An earlier version could also resolve them itself from a bare project.number,
// for the standalone `/task 251` case. That path cost an agent dispatch on every
// run and was never taken under the orchestrator, which is how this workflow is
// actually driven. Pass the resolved block; there is no boardless mode.
// (orchestrator.js still accepts a plain {number: N} — resolving by name is its
// job, not this file's.)
const DEFAULT_OPTION_NAMES = { backlog: 'Backlog', inProgress: 'In progress', inReview: 'In review', done: 'Done' }

function resolveProject() {
  if (!project) {
    throw new Error(
      'task workflow needs args.project with resolved ids {id, fieldId, optionIds} — the '
      + 'orchestrator resolves them once per milestone and forwards them. There is no boardless mode.')
  }
  if (!(project.id && project.fieldId && project.optionIds)) {
    throw new Error(
      'task workflow was passed `project` without resolved ids (id/fieldId/optionIds). Let the '
      + 'orchestrator resolve and forward them, or resolve them once yourself (see the '
      + 'setup-project skill) and pass the whole block.')
  }
  return {
    id: project.id, fieldId: project.fieldId, optionIds: project.optionIds,
    statusField: project.statusField || 'Status',
    optionNames: { ...DEFAULT_OPTION_NAMES, ...(project.optionNames || project.options || {}) },
  }
}
const board = resolveProject()
const optionNames = board.optionNames

// This workflow only ever makes TWO card moves: "In progress" when Intake
// accepts the subtask, and "In review" when its PR opens. An earlier version
// also moved the card at spec->implement, but both of those stages map to the
// SAME "In progress" option — the second mutation always wrote the value the
// first had just written. "Backlog" belongs to milestone setup and "Done" to
// the orchestrator's post-merge step; neither is this workflow's to write.
//
// Reusable prompt fragment for the board mutation — embeddable as the TAIL of
// another stage's own agent call (Intake/PR) instead of a separate dispatch,
// since that agent already has tool access and full context. Every call site
// must frame this as best-effort and instruct the model not to let its failure
// affect the stage's real return value.
const [repoOwner, repoShortName] = repo.split('/')

function boardMoveInstructions(optionKey, cached) {
  const known = cached && typeof cached === 'object' ? cached : {}
  const id = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)
  const itemId = id(known.itemId)
  const parentItemId = id(known.parentItemId)

  const findCard = number => `gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:10){nodes{id project{id}}}}}}' -f o="${repoOwner}" -f r="${repoShortName}" -F n=${number} --jq '.data.repository.issue.projectItems.nodes[] | select(.project.id=="${board.id}") | .id'`
  const setStatus = (idRef, optionId) => `gh api graphql -f query='mutation($i:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:"${board.id}",itemId:$i,fieldId:"${board.fieldId}",value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' -f i="${idRef}" -f o="${optionId}"`

  // A project item id is stable for the life of the card, so re-resolving it in
  // a later stage is a round trip that buys nothing. Intake resolves both ids
  // and reports them; every stage after it is handed them. The only way a
  // cached id goes bad is a card removed and re-added mid-run, which the
  // stale-id fallback below covers.
  const step1 = itemId
    ? `1. This card's id was already resolved during intake — use it as-is, do NOT look it up again:
ITEM_ID="${itemId}"`
    : `1. Find the card:
ITEM_ID=$(${findCard(issue)})`

  // The siblings' statuses are NOT cacheable: they are exactly what changes as
  // the run progresses, which is the whole reason the parent gets re-mirrored.
  const step3 = parentItemId
    ? `3. Mirror the parent story. Its card id was also resolved during intake:
PARENT_ITEM_ID="${parentItemId}"
You still need the siblings' CURRENT statuses, which change as the run progresses:
${`gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){parent{number subIssues(first:50){nodes{projectItems(first:10){nodes{project{id} fieldValueByName(name:"${board.statusField}"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}}}' -f o="${repoOwner}" -f r="${repoShortName}" -F n=${issue}`}
Among the sub-issues' Status names on this project (missing value counts as "${optionNames.backlog}"), decide the parent's target by PROGRESS, not by the least-advanced sibling: if EVERY sub-issue is "${optionNames.backlog}", target "${optionNames.backlog}"; if EVERY sub-issue is "${optionNames.done}", target "${optionNames.done}"; otherwise (a mix) target "${optionNames.inProgress}". Then run the step-2 mutation against $PARENT_ITEM_ID with the matching option id from this map: ${optionNames.backlog}=${board.optionIds.backlog} ${optionNames.inProgress}=${board.optionIds.inProgress} ${optionNames.inReview}=${board.optionIds.inReview} ${optionNames.done}=${board.optionIds.done}.
If a mutation fails with a not-found/invalid-id error the cached id is stale (card removed and re-added): look that card up by its issue number with the same projectItems query, then retry once.`
    : `3. Mirror the parent story. Fetch:
${`gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){parent{number subIssues(first:50){nodes{projectItems(first:10){nodes{project{id} fieldValueByName(name:"${board.statusField}"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}}}' -f o="${repoOwner}" -f r="${repoShortName}" -F n=${issue}`}
If there is no parent, stop here. Otherwise, among the sub-issues' Status names on this project (missing value counts as "${optionNames.backlog}"), decide the parent's target status by PROGRESS, not by the least-advanced sibling: if EVERY sub-issue is "${optionNames.backlog}", target is "${optionNames.backlog}"; if EVERY sub-issue is "${optionNames.done}", target is "${optionNames.done}"; otherwise (a mix) target is "${optionNames.inProgress}". Then find the parent's card with the step-1-style query (its issue number) and set its Status with the step-2-style mutation using this option-id map: ${optionNames.backlog}=${board.optionIds.backlog} ${optionNames.inProgress}=${board.optionIds.inProgress} ${optionNames.inReview}=${board.optionIds.inReview} ${optionNames.done}=${board.optionIds.done}.`

  const report = known.report === true
    ? `

Finally, return board.itemId, board.parentItemId (empty if no parent) and board.parentNumber (0 if none) — later stages reuse these instead of re-querying. Report them even if a mutation failed.`
    : ''

  return `
Move the board card for ${repo} issue #${issue} to Status "${optionNames[optionKey]}", then mirror its parent story. Use ONLY the Status-setting mutation below — never create, close, edit, or delete anything.

${step1}

2. Set its Status (pass the option id with -f, NOT -F — -F coerces numeric-looking strings to int and the mutation rejects it):
${setStatus('$ITEM_ID', board.optionIds[optionKey])}

${step3}${report}`
}

// ── 1. intake ────────────────────────────────────────────────────────────────
phase('Intake')
const providedVerification = opts.verification && typeof opts.verification === 'object' ? opts.verification : null
const verificationStep = providedVerification
  ? `5. Verification commands are already known for this run (discovered by the caller) — return them EXACTLY as given, do not re-discover them: ${JSON.stringify(providedVerification)}. Still locate this repo's testing standards doc (via CLAUDE.md) — step 6 needs it.`
  : `5. Discover this repo's own verification commands — do NOT assume a stack. Check CLAUDE.md, its testing standards doc, CI workflow files (.github/workflows/), and the manifest (pyproject.toml/package.json/etc.) for how tests, typecheck, and lint actually run. If the repo documents multiple SEPARATE invocations for different test tiers (e.g. one tier must run in its own process), report them as separate items in fullSuite, not concatenated with &&.`

const intake = await callAgent(`Intake for ${repo} subtask #${issue} in ${repoDir}.

1. \`gh issue view ${issue} --repo ${repo} --json title,body,labels,milestone\` — if the labels do NOT include "subtask" (e.g. it is a story), set refused=true with the reason and stop (skip everything below, including the board step).
2. Read the parent story (\`gh api graphql\` on issue.parent, or the "Subtask of #N" line in the body) and list its sibling sub-issues with states.
3. Read this repo's own architecture/standards docs (check CLAUDE.md for an index) and any specs/ADRs the story or subtask cites.
4. Locate the code the subtask touches: existing modules and sibling tests.
${verificationStep}
6. Find this repo's own test-tier PLACEMENT rules — do NOT assume a taxonomy. Its testing standards doc usually says which tier owns what kind of test (e.g. "unit owns pure combinations, integration owns paths, e2e owns wiring, conformance owns real-vs-fake equivalence" is one repo's version — another repo's tiers and rules will differ). Cite the doc path and summarize its placement rule in one or two lines inside your summary — every later stage that writes a test needs this to place it correctly, not default to a habitual tier out of habit.
${DRY ? '' : `
7. Only if you did NOT refuse above, as a final best-effort step (do NOT let its failure change refused/summary/verification above — note it in summary instead): ${boardMoveInstructions('inProgress', { report: true })}`}

Return: what #${issue} must deliver, exact constraints from the docs (invariants, types, conventions the subtask must obey) INCLUDING the test-placement rule from step 6, relevant file:line references, what sibling subtasks own (so this one doesn't drift into them), and the verification commands.`,
  { label: `intake:#${issue}`, phase: 'Intake', model: 'sonnet', schema: {
    type: 'object', required: ['refused', 'summary', 'verification'],
    properties: {
      refused: { type: 'boolean' }, reason: { type: 'string' }, summary: { type: 'string' },
      // Resolved once here so Ship does not re-query for ids that cannot change.
      board: { type: 'object', properties: {
        itemId: { type: 'string' }, parentItemId: { type: 'string' },
        parentNumber: { type: 'integer' } } },
      verification: { type: 'object', required: ['fullSuite'], properties: {
        fullSuite: { type: 'array', items: { type: 'string' } },
        typecheck: { type: 'string' }, lint: { type: 'array', items: { type: 'string' } },
      } },
    },
  } })
if (!intake || intake.refused) return { issue, refused: true, reason: intake ? intake.reason : 'intake agent died' }

// Card ids are stable for the life of the card, so this is resolved once and
// handed to every later stage instead of being looked up again per board move.
const boardIds = (intake.board && typeof intake.board === 'object') ? intake.board : {}
if (!boardIds.itemId) {
  log('intake did not report a board item id — later card moves will resolve it themselves (one extra query per move)')
}

const verification = providedVerification || intake.verification
const suiteCmds = (verification.fullSuite || []).filter(Boolean)

const noSuite = verificationGate(suiteCmds, opts.allowNoVerification, Boolean(providedVerification))
if (noSuite) {
  return { issue, blocked: noSuite.blocked, branch: BRANCH, worktree: WORKTREE, detail: noSuite.detail }
}

const verifyBlock = [
  ...suiteCmds.map((command, index) => `   - ${suiteCmds.length > 1 ? `(tier ${index + 1}, own invocation, do NOT combine with &&) ` : ''}${command}`),
  verification.typecheck ? `   - ${verification.typecheck}` : null,
  ...(verification.lint || []).filter(Boolean).map(command => `   - ${command}`),
].filter(Boolean).join('\n')

if (DRY) {
  return { issue, mode: 'dryRun', branch: BRANCH, worktree: WORKTREE, verification,
    note: 'dryRun: Intake only. No worktree, no writes.' }
}

// ── plan-check — is there already a VALIDATED plan for this issue? ──────────
// Filename is deterministic per issue (no date), so it survives across days
// and reruns. A validated plan is the durable checkpoint for the three most
// expensive upstream stages (Sonnet Spec, Opus Plan, Sonnet Validate) — skip
// all three when one already exists, same durable-state pattern orchestrator
// uses for subtask doneness (see orchestrator.js's isSubtaskDone).
phase('Spec')
const planCheck = await (async () => {
  // Find `*issue-<n>.md` and grep it for one marker: `ls` and `grep`, no
  // judgement. It cost a dispatch every run only because a Workflow script
  // cannot touch a disk, so the agent is now a trigger and the rules live in
  // scripts/plan-check.mjs, where they are tested.
  const out = await callAgent(`Run this command and return its stdout EXACTLY as printed:
   bun ${scriptsDir}/plan-check.mjs --repo-dir ${repoDir} --issue ${issue} --compact

It prints one line of JSON that the pipeline parses itself, so reformatting, pretty-printing, summarizing or truncating it breaks a deterministic step.`,
    { label: `plan-check:#${issue}`, phase: 'Spec', model: 'haiku', effort: 'low', ...triggerAgent, schema: {
      type: 'object', required: ['stdout'],
      properties: {
        stdout: { type: 'string', description: 'the command\'s stdout, byte for byte, unmodified' },
        error: { type: 'string', description: 'the command\'s stderr, when it failed' },
      },
    } })
  if (!out) return null
  try {
    return JSON.parse(String(out.stdout ?? ''))
  } catch (err) {
    // Not fatal: an unreadable answer means "no reusable plan", which costs a
    // re-plan rather than the run.
    log(`plan-check returned output that is not JSON (${err.message}) — treating as no saved plan`)
    return { found: false }
  }
})()

let plan
if (planCheck && planCheck.found && planCheck.validated === true &&
    typeof planCheck.path === 'string' && planCheck.path.trim().startsWith('/')) {
  plan = planCheck.path.trim()
  log(`resumed: validated plan already exists at ${plan} — skipping Spec/Plan/Validate`)
} else {
  // ── 2a. spec (Sonnet) ──────────────────────────────────────────────────────
  const spec = await callAgent(`Write the spec for ${repo} subtask #${issue} in ${repoDir}.

Intake findings:
${clip(intake.summary, 8000, 'intake summary')}

Rules:
- Scope, observable behavior, error paths, test list — half a page for most subtasks. Scale to subtask size: one subtask = usually one module/function + its tests.
- For every test in the list, name which tier it belongs in per the test-placement rule cited in the intake findings above — never default to a habitual tier without checking that rule.
- No hard-wrapped prose. No implementation plan yet — that's the next stage.

Return the spec as plain text (not saved to a file yet).`,
    { label: `spec:#${issue}`, phase: 'Spec', model: 'opus' })
  if (!spec) throw new Error('spec agent died')

  // ── 2b. plan (Opus) ────────────────────────────────────────────────────────
  phase('Plan')
  const planPath = await callAgent(`Write the TDD implementation plan for ${repo} subtask #${issue} in ${repoDir}, from the spec below.

Spec:
${clip(spec, 16000, 'spec')}

Intake findings:
${clip(intake.summary, 8000, 'intake summary')}

Rules:
- superpowers:writing-plans format: bite-sized tasks, each step one action with real code blocks, RED before GREEN, no placeholders.
- Every test step must land in the tier its spec entry named (per the test-placement rule in the intake findings) — the file path in each RED step should already reflect that tier's own directory convention (check sibling files in that tier first, don't invent one).
- Prepend the spec verbatim to the top of the saved file, then the plan.
- Branch will be ${BRANCH}, worktree ${WORKTREE} (fresh, cut from origin/${baseBranch} — the plan must NOT assume any other subtask's code already exists on this branch).
- Verification commands for this repo:
${verifyBlock}
- Save the plan under whatever plans directory this repo already uses (check ${repoDir}/CLAUDE.md and existing plan files; fall back to ${repoDir}/.claude/plans/). Filename MUST be exactly issue-${issue}.md — no date prefix, so a resumed run can find the same file. If ${planCheck && planCheck.path ? planCheck.path : 'such a file'} already exists, OVERWRITE it. No hard-wrapped prose.

Return ONLY the absolute path of the saved plan file.`,
    { label: `plan:#${issue}`, phase: 'Plan', model: 'opus' })
  if (!planPath) throw new Error('plan agent died')
  plan = String(planPath).trim()

  // ── 3. adversarial validation ──────────────────────────────────────────────
  phase('Validate')
  const verdict = await callAgent(`Adversarial review (kind:spec) of ${plan} — spec+plan for ${repo} subtask #${issue} in ${repoDir}.

Try to BREAK it before implementation: contradictions with this repo's architecture/standards docs (read them; the intake cites them), decisions that bite sibling subtasks, dishonest or tautological tests, config side-effects, steps not executable verbatim. Verify every suspicion against the actual files/tools before reporting (run commands if needed).

Fold every CONFIRMED fix directly into the plan file (edit it), keeping its structure. On success (blockers=false), also prepend the exact line \`<!-- task-pipeline: validated -->\` as the very first line of the plan file, before anything else — this marks the plan as a durable checkpoint a resumed run can trust.

Then, as a final best-effort step, comment on ${repo} issue #${issue} via \`gh issue comment ${issue} --repo ${repo} --body "..."\` (concise, one line) — if blockers=false, that the plan validated and implementation is next; if blockers=true, that the /task workflow stopped at validation, with your reason. Do NOT let this comment's outcome change blockers/reason/summary above — note any failure in summary instead. Intake moves the card to "${optionNames.inProgress}" on a best-effort basis; do not touch the board here either way.

Return blockers=true only if something unresolvable remains (spec contradiction needing a human decision) with the reason.`,
    { label: `validate:#${issue}`, phase: 'Validate', model: 'sonnet', schema: {
      type: 'object', required: ['blockers', 'summary'],
      properties: { blockers: { type: 'boolean' }, reason: { type: 'string' }, summary: { type: 'string' } },
    } })
  if (!verdict || verdict.blockers) {
    // Validate posts its own blocked-comment as its last step — but a DEAD
    // validator (null after callAgent's retry) never got that far, so the
    // issue would go silent. Only that case needs the fallback dispatch.
    if (!verdict) {
      try {
        // Fully formed here rather than described: there is nothing for the
        // agent to compose, so there is nothing for it to get wrong.
        await agent(`Run this command exactly as written and report nothing else:
gh issue comment ${issue} --repo ${repo} --body ${JSON.stringify('The /task workflow stopped at validation: the validator agent died without returning a verdict. No plan was accepted and nothing was implemented. Re-run the task to retry.')}`,
          { label: `blocked-comment:#${issue}`, phase: 'Validate', model: 'haiku', effort: 'low', ...triggerAgent })
      } catch (err) {
        log(`blocked-comment agent threw (${err && err.message ? err.message : err}) — returning the blocker anyway`)
      }
    }
    return { issue, blocked: 'validation', reason: verdict ? verdict.reason : 'validator died' }
  }
}

// ── 4. implement (Sonnet, TDD) ───────────────────────────────────────────────
phase('Implement')
const impl = await callAgent(`Implement ${repo} subtask #${issue} from the validated plan at ${plan}.

First, compute the resume key ONCE and reuse that exact value everywhere below — both paths need it, and every commit must carry it:
\`PLAN_HASH=$(sha256sum "${plan}" | cut -c1-8)\`
If that command fails or \`$PLAN_HASH\` comes back empty, STOP and report it; never proceed with an empty hash. Do NOT modify \`${plan}\`'s content at any point in this workflow — its exact bytes are what the hash is derived from, for this run and for every future resume. If ticking off plan checkboxes as you go is a habit, resist it here: it changes the hash and orphans every commit you already made.

Setup: from ${repoDir}, run \`git fetch origin && git worktree prune\` (prune clears stale worktree registrations whose directories are gone), then create the worktree IDEMPOTENTLY. The branch name is STABLE across runs, so a stopped or killed earlier run can leave \`${BRANCH}\` and/or \`${WORKTREE}\` behind and a plain \`-b\` would fail:
  a. If branch \`${BRANCH}\` does NOT exist: \`git worktree add ${WORKTREE} -b ${BRANCH} origin/${baseBranch}\`. Skip straight to the TDD steps below.
  b. Else the branch (and possibly its worktree) already exists. First rule out live work on it — this is the ONLY place that check happens, so do not skip it: \`gh api "repos/${repo}/pulls?state=open&per_page=100" --jq '.[] | select(.head.ref=="${BRANCH}") | .number'\`. An OPEN PR here means STOP: report the PR number and change NOTHING — never reset, delete, or commit over it. (The caller established there was no live PR when it queued this subtask; one appearing since means something else is driving this branch, and that is a human's call, not yours.)
     No open PR: ensure the worktree exists (\`git worktree add ${WORKTREE} ${BRANCH}\` if ${WORKTREE} is missing), then decide RESUME vs RESET by whether the branch's own commits implement the CURRENT plan:
     - Check for a matching trailer, scoped to this branch's own commits (not inherited history from origin/${baseBranch}): \`git -C ${WORKTREE} log origin/${baseBranch}..HEAD --grep="^Plan-Hash: $PLAN_HASH" --format=%H\`.
     - If that returns any commit: RESUME. These commits genuinely implement the plan you were just given (a killed earlier run, not stale debris). Do NOT reset. Run \`git -C ${WORKTREE} log --oneline origin/${baseBranch}..HEAD\` and read the plan's step list to see which steps are already committed, then continue STRICT TDD from the next uncompleted step — do not re-do committed steps.
     - If it returns nothing (empty, or the branch predates this convention): RESET. This branch is stale relative to the current plan (an earlier attempt under a different/no plan). \`git -C ${WORKTREE} reset --hard origin/${baseBranch}\` and start the TDD steps below from scratch. A hard reset over genuinely stale debris is deliberate: this plan-driven run re-derives the work deterministically, while building on unrelated partial state does not.
  This keeps the branch prefix STABLE — which is what lets already-merged subtasks stay detectable — while making leftovers self-healing instead of either a hard stop or blind data loss. NEVER work around a collision by inventing a different branch name: the caller decides whether a subtask is already done by finding the PR whose head ref carries this issue's number, and a name you invented is invisible to that lookup.
Work ONLY inside ${WORKTREE}. Sync dependencies per this repo's own convention, then a baseline full-suite run (skip this if you just RESUMED and the suite was already green as of the last commit — re-run it anyway if unsure):
${verifyBlock}
If baseline is ALREADY red before you change anything (and you are not resuming known-green work), stop and report it — do not fix someone else's failure inside this subtask.

Then STRICT TDD per the plan (continuing from the next uncompleted step if you RESUMED): write the failing test, RUN it and confirm it fails for the right reason, minimal code to green, re-run, refactor, commit granularly (conventional commits, reference #${issue}). Never write production code without having watched its test fail. Every new test must land in the tier the plan assigned it (per this repo's own test-placement rule) — if a test you're about to write doesn't fit its assigned tier once you're looking at the real code, stop and say so rather than dropping it into whatever tier is convenient. Mutation-check any meta/guard tests (make them fail once on purpose). End EVERY commit message with both trailers:
Co-Authored-By: ${coauthor}
Plan-Hash: $PLAN_HASH

(compute \`PLAN_HASH\` once at the start, as above, and reuse it — every commit on this branch must carry the SAME hash so a later resume can find them all with one \`git log --grep\`.)

Do NOT push, do NOT open a PR.

As a final best-effort step (do NOT let its failure change anything above): comment on ${repo} issue #${issue} (concise, one line, via \`gh issue comment ${issue} --repo ${repo} --body "..."\`) that implementation finished on branch ${BRANCH} and review/verify/PR is next.

Return a structured result. This stage has THREE stop conditions, all above: an OPEN PR on \`${BRANCH}\`; a \`sha256sum\` that failed or gave an empty PLAN_HASH; a baseline suite already red before you changed anything. Reporting one of those in prose while claiming success is the single worst outcome here — the pipeline would review, verify and open a PR on top of a stop you were told to make.

- blocked: true if ANY stop condition fired, or anything else made implementation impossible. false only if you completed the TDD work.
- blockedReason: when blocked, ONE line naming which condition fired plus the concrete detail (the PR number, the command that failed, the tests already red). Empty when blocked=false.
- existingPr: ONLY when an open PR on \`${BRANCH}\` is what stopped you — its number. Omit otherwise.
- planHash: the exact 8-character lowercase-hex PLAN_HASH you computed above and used in every commit trailer.
- resumed: true if you continued from existing Plan-Hash commits; false if you started fresh (path (a), or after a RESET).
- report: the normal implementation report — commits made (oneline), test count added, deviations from the plan with reasons. The reviewer reads this next, so keep it factual and scoped to what you changed. Empty when blocked=true.

Do not set blocked=true for a difficulty you worked through and solved.`,
  { label: `implement:#${issue}`, phase: 'Implement', model: 'sonnet', schema: {
    type: 'object', required: ['blocked', 'report'],
    properties: {
      blocked: { type: 'boolean' }, blockedReason: { type: 'string' },
      existingPr: { type: 'integer' }, resumed: { type: 'boolean' },
      planHash: { type: 'string' },
      report: { type: 'string' },
    },
  } })
if (!impl) throw new Error('implement agent died')

// Implement's stop conditions used to be prose in a free-text return, so
// nothing downstream could see them: the pipeline went on to review, verify and
// open a PR on top of a stop it had been explicitly told about. `existingPr` is
// deliberately NOT called `pr` — a blocking PR belongs to whatever else is
// driving this branch, and putting it in the field the orchestrator reads as
// "this subtask's PR" is exactly the kind of confusion that costs a milestone.
if (impl.blocked) {
  const stoppedOnPr = Number.isInteger(impl.existingPr) && impl.existingPr > 0
  return { issue, blocked: 'implement', branch: BRANCH, worktree: WORKTREE, plan,
    ...(stoppedOnPr ? { existingPr: impl.existingPr } : {}),
    detail: impl.blockedReason || 'implement stopped without naming a reason' }
}

// ── 5. review + fixes ────────────────────────────────────────────────────────
phase('Review')
const review = await callAgent(`Review the branch diff in ${WORKTREE}: \`git diff origin/${baseBranch}...HEAD\`. Context: ${repo} subtask #${issue}; plan at ${plan}; this repo's own architecture/standards docs (cited in the plan). Implementer's report:
${clip(impl.report, 12000, 'implementer report')}

Check every new test file's path against this repo's own test-placement rule (cited in the plan/intake findings) — a test sitting in the wrong tier is a finding, same severity class as a wrong-tier test would earn in this repo's own review discipline. One line per finding, severity-tagged (blocker/major/minor), no praise, no scope creep. Verify each finding against the actual code before reporting.

Then the test-integrity gate, on the test portion of that same diff: no weakened or deleted assertions, no tautologies, no tests that merely mirror the implementation, and every new behavior has a test that would fail without its code. A violation here is a finding like any other — raise it, fix it, and if it genuinely cannot be fixed it is blocker-severity. Never weaken, skip, xfail, or delete a test to make anything pass.

You are the only stage that reads this diff and the only one that writes: the stage after you runs the suite and reports, and is forbidden to fix anything. So everything that needs changing must be changed HERE, and everything you change must be COMMITTED here — uncommitted work is invisible to \`git push\`, would be absent from the PR, and will stop the run.

If you find any real findings, fix them yourself in the same pass: in ${WORKTREE}, on branch ${BRANCH} (TDD where behavior changes: failing test first), commit granularly, end commits with:
Co-Authored-By: ${coauthor}
Also run this repo's own lint/format commands and commit any fixes they require, so the tree is clean when you finish. Skip any finding that turns out to be wrong on closer inspection — note why in fixSummary instead of "fixing" it.

FINALLY, once you have finished committing, run these three commands and report their output verbatim. Do not interpret them, do not act on them, and do not change anything in response to them — they are read by the pipeline itself, which decides what they mean:
\`\`\`
git -C ${WORKTREE} status --porcelain
git -C ${WORKTREE} rev-list --count origin/${baseBranch}..HEAD
PLAN_HASH=$(sha256sum "${plan}" | cut -c1-8); git -C ${WORKTREE} log origin/${baseBranch}..HEAD --format=%B | grep -c "^Plan-Hash: $PLAN_HASH"
\`\`\`

Return:
- findings: every finding you raised, severity-tagged, whether or not you went on to fix it (findings=[] if the diff was clean).
- unresolvedBlockers: ONLY the blocker-severity findings still standing after your fix pass — a blocker you actually fixed, or correctly determined was wrong, does NOT belong here. This list stops the pipeline before the PR opens, so an empty list is a claim that nothing blocker-severity is left in the code.
- fixSummary: what you fixed vs skipped and why (empty string if findings was empty).
- porcelain: the FIRST command's output exactly as printed — empty string if it printed nothing.
- commitCount: the SECOND command's number.
- taggedCount: the THIRD command's number.
- planHash: the value \`$PLAN_HASH\` held when you ran that third command — the 8 characters, not the command.`,
  { label: `review:#${issue}`, phase: 'Review', model: 'opus', schema: {
    type: 'object', required: ['findings'],
    properties: {
      findings: { type: 'array', items: { type: 'string' } },
      unresolvedBlockers: { type: 'array', items: { type: 'string' } },
      fixSummary: { type: 'string' },
      porcelain: { type: 'string' },
      commitCount: { type: 'integer' },
      taggedCount: { type: 'integer' },
      planHash: { type: 'string' },
    },
  } })
// agent() returns null when a stage dies terminally. Every other stage stops on
// that; Review had no such check, so a dead reviewer read as "no unresolved
// blockers" and the run walked on with nothing actually reviewed.
if (!review) {
  return { issue, blocked: 'review', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `the review stage returned nothing, so this branch has not been reviewed and its worktree state is unknown. Nothing was pushed. ${WORKTREE} is intact — re-run this subtask to review it.` }
}

// Review both raises AND fixes, so a blocker in `findings` may well have been
// resolved in the same pass — only what the reviewer says is STILL standing
// gates the PR. Previously nothing read this at all: a blocker-severity
// finding was reported and the PR opened anyway.
const unresolvedBlockers = (review && review.unresolvedBlockers) || []
if (unresolvedBlockers.length > 0) {
  return { issue, blocked: 'review', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `review left ${unresolvedBlockers.length} unresolved blocker(s): ${unresolvedBlockers.join('; ')}` }
}

// Two gates that used to be prose in Ship's prompt — "if it is dirty, STOP",
// "if TAGGED is less than COMMITS, STOP". Both are decisions about numbers and
// an empty string, so they belong here, in code, where they are deterministic
// and visible. Review is the last stage that writes, so this is the earliest
// boundary at which they can be judged, and gating here costs no dispatch:
// Ship simply never boots.
//
// Diagnosis before the verdict: the gate can tell that trailers are missing,
// but only this comparison can say WHY.
const hashDrift = planHashMismatch(impl.planHash, review.planHash)
if (hashDrift) log(hashDrift)

// The gate itself is reviewGate(), up in the PURE region, where it can be
// tested without a dispatch. All that is left here is doing what it says.
const gate = reviewGate(review, BRANCH, baseBranch)
if (gate && gate.warn) log(gate.warn)
if (gate && gate.blocked) {
  return { issue, blocked: gate.blocked, branch: BRANCH, worktree: WORKTREE, plan, detail: gate.detail }
}

// ── 6. ship — verify, then push and open the PR (never merge) ───────────────
// Verify and PR used to be separate dispatches with only a pass/fail gate
// between them. Both are mechanical and adjacent, so they are one stage now.
// The line this must not cross: this stage may PUBLISH what it measured, but
// never REPAIR it — a stage that fixes what it is certifying cannot report on
// it. Everything that needs changing is Review's job, upstream.
//
// The cost of the merge, stated plainly: `if (!passed) return` used to make a
// red suite STRUCTURALLY unable to reach the PR. That guarantee is now a prompt
// instruction. A run that ever reports passed=false alongside a non-empty url
// means this merge was wrong and the stages should be split back apart.
phase('Ship')
const verifyFlags = suiteCmds
  .concat(verification.typecheck ? [verification.typecheck] : [])
  .concat((verification.lint || []).filter(Boolean))
  .map(command => `--verify ${JSON.stringify(command)}`)
  .join(' ')

// Ship used to be five-plus commands fenced in by prose: run every verification
// command, judge whether they were green, push, open the PR with --head passed
// explicitly, move the card. Only the last of those needed a model, and even
// that only because a Workflow script cannot run `gh`.
//
// The PR title and body are DERIVED inside the script, never passed on the
// command line. Long text an agent has to type is a quoting accident waiting to
// happen, and it was the last place a model could alter what ships.
const shipOut = await callAgent(`Run this command and return its stdout EXACTLY as printed:
   bun ${scriptsDir}/ship.mjs --repo ${repo} --issue ${issue} --branch ${BRANCH} --base ${baseBranch} --worktree ${WORKTREE} ${verifyFlags} --compact

It prints one line of JSON that the pipeline parses itself, so reformatting, pretty-printing, summarizing or truncating it breaks a deterministic step. A non-zero exit is a normal answer — it means verification failed or no PR was opened. Report it and stop; do NOT retry, do NOT fix anything, and do NOT run any other command to work around it.

Only if that command printed \`"number"\` with a real PR number, do this as a final best-effort step (its failure must not change anything you return):
${boardMoveInstructions('inReview', boardIds)}`,
  { label: `ship:#${issue}`, phase: 'Ship', model: 'haiku', ...triggerAgent, schema: {
    type: 'object', required: ['stdout'],
    properties: {
      stdout: { type: 'string', description: 'the command\'s stdout, byte for byte, unmodified' },
      error: { type: 'string', description: 'the command\'s stderr, when it failed' },
    },
  } })
if (!shipOut) throw new Error('ship agent died')

let ship
try {
  ship = JSON.parse(String(shipOut.stdout ?? ''))
} catch (err) {
  // Parsed HERE so a mangled transcription fails at the boundary rather than
  // arriving as a plausible-looking success.
  return { issue, blocked: 'pr', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `ship.mjs returned output that is not JSON (${err.message}). The branch may or may not have been pushed — check before re-running. First 200 characters: ${String(shipOut.stdout ?? '').slice(0, 200)}` }
}


// `blocked: 'tests'` is load-bearing: orchestrator.js maps that exact string to
// escalation trigger 'tests' and everything else to 'blocked', which route
// differently. The dirty-tree and Plan-Hash gates that used to live here are
// now decided in script above, off Review's reported values.
if (!ship.passed) {
  return { issue, blocked: 'tests', branch: BRANCH, worktree: WORKTREE, plan, detail: ship.detail }
}

// ship.mjs already parsed the URL and refused to push after a red command, so
// these read its fields rather than re-deriving anything.
const prNumber = Number(ship.number)
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  return { issue, blocked: 'pr', branch: BRANCH, worktree: WORKTREE, plan,
    detail: ship.detail || `verification passed but no usable PR number came back (url: ${String(ship.url ?? '').slice(0, 120)}). The branch ${ship.pushed ? 'WAS' : 'may not have been'} pushed — check before re-running.` }
}

return { issue, pr: prNumber, branch: BRANCH, worktree: WORKTREE, plan,
  tests: (ship.verified || []).map(v => `${v.ok ? 'PASS' : 'FAIL'} ${v.command}`).join('\n') }
