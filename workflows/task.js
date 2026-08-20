export const meta = {
  name: 'task',
  description: 'Drive ONE subtask issue end-to-end in its own worktree/branch: intake, spec, TDD implementation plan, adversarial validation, strict-TDD implementation, review, full verification, and a PR. Repo-agnostic: repo, board, and verification commands are arguments or discovered at runtime. Stops at PR — never merges.',
  whenToUse: 'User asks to work a subtask card: "/task 251", "pick up #252", "run the task workflow on 253". Also invoked per subtask, sequentially within a story, by the orchestrator workflow.',
  phases: [
    { title: 'Resume', detail: 'check for an existing PR on this issue\'s branch — short-circuit if merged or open', model: 'haiku' },
    { title: 'Intake', detail: 'issue + parent story + repo docs; discover this repo\'s test/lint/typecheck commands; card -> In progress', model: 'sonnet' },
    { title: 'Spec', detail: 'scope, behavior, error paths, test list', model: 'sonnet' },
    { title: 'Plan', detail: 'TDD implementation plan from the spec', model: 'opus' },
    { title: 'Validate', detail: 'adversarial plan review, fixes folded in', model: 'sonnet' },
    { title: 'Implement', detail: 'worktree + strict TDD, granular commits', model: 'sonnet' },
    { title: 'Review', detail: 'branch diff review + fixes; unresolved blockers stop the run', model: 'sonnet' },
    { title: 'Verify', detail: 'full suite + typecheck + lint + test-integrity gate', model: 'haiku' },
    { title: 'PR', detail: 'push, open PR (no merge); card -> In review', model: 'haiku' },
  ],
}

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

const branchPrefix = typeof opts.branchPrefix === 'string' ? opts.branchPrefix : 'task-'
const BRANCH = `${branchPrefix}${issue}`
const WORKTREE = `${repoDir}/.claude/worktrees/${BRANCH}`
const coauthor = typeof opts.coauthor === 'string' ? opts.coauthor : 'Claude <noreply@anthropic.com>'
const DRY = opts.dryRun === true

// ── 0. resume-check — read-only PR lookup, short-circuits everything below ──
// Branch names are deterministic per issue (`${branchPrefix}${issue}`), so any
// PR whose head ref carries this issue's number IS this pipeline's own prior
// attempt — never foreign work. Mirrors orchestrator.js's Detect step, kept as
// its own cheap Haiku call so a resumed/rerun task never pays for Intake's
// Sonnet-tier exploration just to rediscover work that already happened.
phase('Resume')
const resumeCheck = await callAgent(`Find any pull request on ${repo} (any state) whose head ref ends with a non-digit followed by "${issue}" — so branches like "${BRANCH}" and "wip/${issue}" match, but one ending in a longer number (e.g. "${issue}0") must NOT. Use the REST endpoint, not gh pr list or search:
gh api "repos/${repo}/pulls?state=all&per_page=100" --paginate --jq '.[] | {number, state, merged: (.merged_at != null), ref: .head.ref, base: .base.ref}'
Read only — do NOT create, edit, merge, or comment on anything. If the command errors or times out, retry up to 3 times with a short pause; if it still fails, return found=false, unknown=true (an API failure is not evidence there is no PR — never guess). Otherwise return found=true with the PR's number/state/merged/base, preferring a merged match, then the most recently opened one, if several qualify. Always report base VERBATIM (never blank, never guessed).`,
  { label: `resume-check:#${issue}`, phase: 'Resume', model: 'haiku', effort: 'low', schema: {
    type: 'object', required: ['found'],
    properties: {
      found: { type: 'boolean' }, unknown: { type: 'boolean' },
      number: { type: 'integer' }, state: { type: 'string' }, merged: { type: 'boolean' }, base: { type: 'string' },
    },
  } })
if (resumeCheck && resumeCheck.unknown) {
  throw new Error(`task workflow: PR lookup for #${issue} failed after retries — cannot safely determine resume state`)
}
// A PR matched by branch-suffix is only this pipeline's own prior attempt if
// it also targets THIS run's baseBranch — a PR opened by mistake against the
// wrong branch is foreign work as far as this run is concerned, merged or not
// (this is what silently "resumed" #1133's dead-end merge into main
// repeatedly on paulomtts/refactor-nori: PR #1150, head task-1133, base
// main, kept getting rediscovered as done). Fall through to a fresh dispatch
// instead of trusting it.
const resumeBase = resumeCheck && typeof resumeCheck.base === 'string' ? resumeCheck.base : ''
const resumeBaseMismatch = resumeCheck && resumeCheck.found && resumeBase && resumeBase !== baseBranch
if (resumeBaseMismatch) {
  log(`resume-check: ignoring PR #${resumeCheck.number} for #${issue} — base "${resumeBase}" is not "${baseBranch}"`)
}
if (resumeCheck && resumeCheck.found && resumeCheck.merged && !resumeBaseMismatch) {
  return { issue, pr: resumeCheck.number, branch: BRANCH, worktree: WORKTREE, note: 'resumed: PR already merged' }
}
if (resumeCheck && resumeCheck.found && String(resumeCheck.state).toUpperCase() === 'OPEN' && !resumeBaseMismatch) {
  return { issue, pr: resumeCheck.number, branch: BRANCH, worktree: WORKTREE, note: 'resumed: PR already open from a prior run' }
}

// project: fully resolved ids (passed down by the orchestrator) or a project
// number this workflow resolves itself when standalone. Omit entirely for
// boardless repos — every board step then no-ops instead of failing the run.
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

// ── board — resolved ids only, Haiku, low effort, sole board writer ──────────
const DEFAULT_OPTION_NAMES = { backlog: 'Backlog', inProgress: 'In progress', inReview: 'In review', done: 'Done' }

async function resolveProject() {
  if (!project) return null
  if (project.id && project.fieldId && project.optionIds) {
    // Orchestrator-resolved ids; fill display defaults a standalone caller
    // may have omitted.
    return {
      id: project.id, fieldId: project.fieldId, optionIds: project.optionIds,
      statusField: project.statusField || 'Status',
      optionNames: { ...DEFAULT_OPTION_NAMES, ...(project.optionNames || project.options || {}) },
    }
  }
  if (!Number.isInteger(Number(project.number))) {
    log('project given without a number and without resolved ids — board steps disabled')
    return null
  }
  const statusField = project.statusField || 'Status'
  const optionNames = { ...DEFAULT_OPTION_NAMES, ...(project.options || {}) }
  const owner = repo.split('/')[0]
  const resolved = await callAgent(`Resolve GitHub Projects v2 ids for project number ${project.number} owned by "${owner}". Read only — do NOT create, edit, or delete anything.

1. Try the user-owned query, and if it returns null data, the org-owned one:
gh api graphql -f query='query($o:String!,$n:Int!){user(login:$o){projectV2(number:$n){id title fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}' -f o="${owner}" -F n=${project.number}
gh api graphql -f query='query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){id title fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}' -f o="${owner}" -F n=${project.number}
2. Find the single-select field named exactly "${statusField}" and, inside it, the options named exactly: ${Object.entries(optionNames).map(([key, value]) => `${key}="${value}"`).join(', ')}.
3. Return the project id, the field id, and the four option ids keyed backlog/inProgress/inReview/done. If the field or ANY option name is missing, return found=false and name exactly what is missing — do not invent, guess, or create a field or option.`,
    { label: `resolve-project:${project.number}`, phase: 'Intake', model: 'haiku', effort: 'low', schema: {
      type: 'object', required: ['found'],
      properties: {
        found: { type: 'boolean' }, missing: { type: 'string' },
        id: { type: 'string' }, fieldId: { type: 'string' },
        optionIds: { type: 'object', properties: {
          backlog: { type: 'string' }, inProgress: { type: 'string' }, inReview: { type: 'string' }, done: { type: 'string' },
        } },
      },
    } })
  if (!resolved || !resolved.found) {
    log(`project ${project.number} field/option resolution failed${resolved ? `: missing ${resolved.missing}` : ''} — board steps disabled for this run`)
    return null
  }
  return { id: resolved.id, fieldId: resolved.fieldId, optionIds: resolved.optionIds, statusField, optionNames }
}
const board = await resolveProject()
const optionNames = board ? board.optionNames : null

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
function boardMoveInstructions(optionKey) {
  if (!board) return ''
  return `
Move the board card for ${repo} issue #${issue} to Status "${optionNames[optionKey]}", then mirror its parent story. Use ONLY the Status-setting mutation below — never create, close, edit, or delete anything.

1. Find the card:
ITEM_ID=$(gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:10){nodes{id project{id}}}}}}' -f o="${repo.split('/')[0]}" -f r="${repo.split('/')[1]}" -F n=${issue} --jq '.data.repository.issue.projectItems.nodes[] | select(.project.id=="${board.id}") | .id')

2. Set its Status (pass the option id with -f, NOT -F — -F coerces numeric-looking strings to int and the mutation rejects it):
gh api graphql -f query='mutation($i:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:"${board.id}",itemId:$i,fieldId:"${board.fieldId}",value:{singleSelectOptionId:$o}}){projectV2Item{id}}}' -f i="$ITEM_ID" -f o="${board.optionIds[optionKey]}"

3. Mirror the parent story. Fetch:
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){parent{number subIssues(first:50){nodes{projectItems(first:10){nodes{project{id} fieldValueByName(name:"${board.statusField}"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}}}' -f o="${repo.split('/')[0]}" -f r="${repo.split('/')[1]}" -F n=${issue}
If there is no parent, stop here. Otherwise, among the sub-issues' Status names on this project (missing value counts as "${optionNames.backlog}"), decide the parent's target status by PROGRESS, not by the least-advanced sibling: if EVERY sub-issue is "${optionNames.backlog}", target is "${optionNames.backlog}"; if EVERY sub-issue is "${optionNames.done}", target is "${optionNames.done}"; otherwise (a mix) target is "${optionNames.inProgress}". Then find the parent's card with the step-1-style query (its issue number) and set its Status with the step-2-style mutation using this option-id map: ${optionNames.backlog}=${board.optionIds.backlog} ${optionNames.inProgress}=${board.optionIds.inProgress} ${optionNames.inReview}=${board.optionIds.inReview} ${optionNames.done}=${board.optionIds.done}.`
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
${DRY || board === null ? '' : `
7. Only if you did NOT refuse above, as a final best-effort step (do NOT let its failure change refused/summary/verification above — note it in summary instead): ${boardMoveInstructions('inProgress')}`}

Return: what #${issue} must deliver, exact constraints from the docs (invariants, types, conventions the subtask must obey) INCLUDING the test-placement rule from step 6, relevant file:line references, what sibling subtasks own (so this one doesn't drift into them), and the verification commands.`,
  { label: `intake:#${issue}`, phase: 'Intake', model: 'sonnet', schema: {
    type: 'object', required: ['refused', 'summary', 'verification'],
    properties: {
      refused: { type: 'boolean' }, reason: { type: 'string' }, summary: { type: 'string' },
      verification: { type: 'object', required: ['fullSuite'], properties: {
        fullSuite: { type: 'array', items: { type: 'string' } },
        typecheck: { type: 'string' }, lint: { type: 'array', items: { type: 'string' } },
      } },
    },
  } })
if (!intake || intake.refused) return { issue, refused: true, reason: intake ? intake.reason : 'intake agent died' }

const verification = providedVerification || intake.verification
const suiteCmds = (verification.fullSuite || []).filter(Boolean)
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
const planCheck = await callAgent(`In ${repoDir}, look for an already-saved implementation plan for subtask #${issue}. Check ${repoDir}/CLAUDE.md and existing plan files to find this repo's plans directory convention (fall back to ${repoDir}/.claude/plans/), then look there for a file matching *issue-${issue}.md. Read only — do not create or modify anything.

If no such file exists, return found=false. If one does, return found=true, its ABSOLUTE path, and validated=true ONLY if the file literally contains the marker line \`<!-- task-pipeline: validated -->\` — test that with \`grep -Fq '<!-- task-pipeline: validated -->' <path>\` and report what grep actually said. Do NOT return the file's contents; the marker check is the only thing this step decides.`,
  { label: `plan-check:#${issue}`, phase: 'Spec', model: 'haiku', effort: 'low', schema: {
    type: 'object', required: ['found'],
    properties: { found: { type: 'boolean' }, validated: { type: 'boolean' }, path: { type: 'string' } },
  } })

let plan
if (planCheck && planCheck.found && planCheck.validated === true &&
    typeof planCheck.path === 'string' && planCheck.path.trim().startsWith('/')) {
  plan = planCheck.path.trim()
  log(`resumed: validated plan already exists at ${plan} — skipping Spec/Plan/Validate`)
} else {
  // ── 2a. spec (Sonnet) ──────────────────────────────────────────────────────
  const spec = await callAgent(`Write the spec for ${repo} subtask #${issue} in ${repoDir}.

Intake findings:
${intake.summary}

Rules:
- Scope, observable behavior, error paths, test list — half a page for most subtasks. Scale to subtask size: one subtask = usually one module/function + its tests.
- For every test in the list, name which tier it belongs in per the test-placement rule cited in the intake findings above — never default to a habitual tier without checking that rule.
- No hard-wrapped prose. No implementation plan yet — that's the next stage.

Return the spec as plain text (not saved to a file yet).`,
    { label: `spec:#${issue}`, phase: 'Spec', model: 'sonnet' })
  if (!spec) throw new Error('spec agent died')

  // ── 2b. plan (Opus) ────────────────────────────────────────────────────────
  phase('Plan')
  const planPath = await callAgent(`Write the TDD implementation plan for ${repo} subtask #${issue} in ${repoDir}, from the spec below.

Spec:
${spec}

Intake findings:
${intake.summary}

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

Then, as a final best-effort step, comment on ${repo} issue #${issue} via \`gh issue comment ${issue} --repo ${repo} --body "..."\` (concise, one line) — if blockers=false, that the plan validated and implementation is next; if blockers=true, that the /task workflow stopped at validation, with your reason. Do NOT let this comment's outcome change blockers/reason/summary above — note any failure in summary instead. The card is already "${optionNames ? optionNames.inProgress : 'In progress'}" from Intake; do not touch the board here.

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
        await agent(`Comment on ${repo} issue #${issue}: the /task workflow stopped at validation because the validator agent died without returning a verdict. Use \`gh issue comment ${issue} --repo ${repo} --body "..."\` with a concise version.`,
          { label: `blocked-comment:#${issue}`, phase: 'Validate', model: 'haiku', effort: 'low' })
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

Setup: from ${repoDir}, run \`git fetch origin && git worktree prune\` (prune clears stale worktree registrations whose directories are gone), then create the worktree IDEMPOTENTLY. The branch name is STABLE across runs, so a stopped or killed earlier run can leave \`${BRANCH}\` and/or \`${WORKTREE}\` behind and a plain \`-b\` would fail:
  a. If branch \`${BRANCH}\` does NOT exist: \`git worktree add ${WORKTREE} -b ${BRANCH} origin/${baseBranch}\`. Skip straight to the TDD steps below.
  b. Else the branch (and possibly its worktree) already exists. First rule out live foreign work (defensive re-check — the pipeline's own Resume step already ruled this out at launch, but re-verify since time has passed): \`gh api "repos/${repo}/pulls?state=open&per_page=100" --jq '.[] | select(.head.ref=="${BRANCH}") | .number'\`. An OPEN PR here means STOP and report it — never reset or delete it.
     No open PR: ensure the worktree exists (\`git worktree add ${WORKTREE} ${BRANCH}\` if ${WORKTREE} is missing), then decide RESUME vs RESET by whether the branch's own commits implement the CURRENT plan:
     - Compute \`PLAN_HASH=$(sha256sum "${plan}" | cut -c1-8)\`. Do NOT modify \`${plan}\`'s content at any point in this workflow — its exact bytes are the resume key this hash is derived from, for this run and every future resume attempt. If ticking off plan checkboxes as you go is a habit, resist it here.
     - If the \`sha256sum\` command fails, or \`$PLAN_HASH\` ends up empty, STOP and report the failure. Never proceed with an empty/missing hash — not for the resume-check below, and not for committing later.
     - Check for a matching trailer, scoped to this branch's own commits (not inherited history from origin/${baseBranch}): \`git -C ${WORKTREE} log origin/${baseBranch}..HEAD --grep="^Plan-Hash: $PLAN_HASH" --format=%H\`.
     - If that returns any commit: RESUME. These commits genuinely implement the plan you were just given (a killed earlier run, not stale debris). Do NOT reset. Run \`git -C ${WORKTREE} log --oneline origin/${baseBranch}..HEAD\` and read the plan's step list to see which steps are already committed, then continue STRICT TDD from the next uncompleted step — do not re-do committed steps.
     - If it returns nothing (empty, or the branch predates this convention): RESET. This branch is stale relative to the current plan (an earlier attempt under a different/no plan). \`git -C ${WORKTREE} reset --hard origin/${baseBranch}\` and start the TDD steps below from scratch. A hard reset over genuinely stale debris is deliberate: this plan-driven run re-derives the work deterministically, while building on unrelated partial state does not.
  This keeps the branch prefix STABLE — which is what lets already-merged subtasks stay detectable — while making leftovers self-healing instead of either a hard stop or blind data loss. NEVER work around a collision by inventing a different branch name: a changed name orphans the Resume step's PR lookup that decides whether a subtask is already done.
Whichever path above you took, you need \`PLAN_HASH=$(sha256sum "${plan}" | cut -c1-8)\` from here on — path (b) already computed it for the resume check above; if you took path (a), compute it now (and apply the same STOP-if-empty/failed rule if you're computing it here). Every commit you make below, on either path, must carry this same value as a trailer.
Work ONLY inside ${WORKTREE}. Sync dependencies per this repo's own convention, then a baseline full-suite run (skip this if you just RESUMED and the suite was already green as of the last commit — re-run it anyway if unsure):
${verifyBlock}
If baseline is ALREADY red before you change anything (and you are not resuming known-green work), stop and report it — do not fix someone else's failure inside this subtask.

Then STRICT TDD per the plan (continuing from the next uncompleted step if you RESUMED): write the failing test, RUN it and confirm it fails for the right reason, minimal code to green, re-run, refactor, commit granularly (conventional commits, reference #${issue}). Never write production code without having watched its test fail. Every new test must land in the tier the plan assigned it (per this repo's own test-placement rule) — if a test you're about to write doesn't fit its assigned tier once you're looking at the real code, stop and say so rather than dropping it into whatever tier is convenient. Mutation-check any meta/guard tests (make them fail once on purpose). End EVERY commit message with both trailers:
Co-Authored-By: ${coauthor}
Plan-Hash: $PLAN_HASH

(compute \`PLAN_HASH\` once at the start, as above, and reuse it — every commit on this branch must carry the SAME hash so a later resume can find them all with one \`git log --grep\`.)

Do NOT push, do NOT open a PR.

As a final best-effort step (do NOT let its failure change anything above): comment on ${repo} issue #${issue} (concise, one line, via \`gh issue comment ${issue} --repo ${repo} --body "..."\`) that implementation finished on branch ${BRANCH} and review/verify/PR is next.

Return: commits made (oneline), test count added, deviations from the plan with reasons, and whether you RESUMED or started fresh.`,
  { label: `implement:#${issue}`, phase: 'Implement', model: 'sonnet' })
if (!impl) throw new Error('implement agent died')

// ── 5. review + fixes ────────────────────────────────────────────────────────
phase('Review')
const review = await callAgent(`Review the branch diff in ${WORKTREE}: \`git diff origin/${baseBranch}...HEAD\`. Context: ${repo} subtask #${issue}; plan at ${plan}; this repo's own architecture/standards docs (cited in the plan). Implementer's report:
${impl}

Check every new test file's path against this repo's own test-placement rule (cited in the plan/intake findings) — a test sitting in the wrong tier is a finding, same severity class as a wrong-tier test would earn in this repo's own review discipline. One line per finding, severity-tagged (blocker/major/minor), no praise, no scope creep. Verify each finding against the actual code before reporting.

If you find any real findings, fix them yourself in the same pass: in ${WORKTREE}, on branch ${BRANCH} (TDD where behavior changes: failing test first), commit granularly, end commits with:
Co-Authored-By: ${coauthor}
Skip any finding that turns out to be wrong on closer inspection — note why in fixSummary instead of "fixing" it.

Return:
- findings: every finding you raised, severity-tagged, whether or not you went on to fix it (findings=[] if the diff was clean).
- unresolvedBlockers: ONLY the blocker-severity findings still standing after your fix pass — a blocker you actually fixed, or correctly determined was wrong, does NOT belong here. This list stops the pipeline before the PR opens, so an empty list is a claim that nothing blocker-severity is left in the code.
- fixSummary: what you fixed vs skipped and why (empty string if findings was empty).`,
  { label: `review:#${issue}`, phase: 'Review', model: 'sonnet', schema: {
    type: 'object', required: ['findings'],
    properties: {
      findings: { type: 'array', items: { type: 'string' } },
      unresolvedBlockers: { type: 'array', items: { type: 'string' } },
      fixSummary: { type: 'string' },
    },
  } })
// Review both raises AND fixes, so a blocker in `findings` may well have been
// resolved in the same pass — only what the reviewer says is STILL standing
// gates the PR. Previously nothing read this at all: a blocker-severity
// finding was reported and the PR opened anyway.
const unresolvedBlockers = (review && review.unresolvedBlockers) || []
if (unresolvedBlockers.length > 0) {
  return { issue, blocked: 'review', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `review left ${unresolvedBlockers.length} unresolved blocker(s): ${unresolvedBlockers.join('; ')}` }
}

// ── 6. verify ────────────────────────────────────────────────────────────────
phase('Verify')
const tests = await callAgent(`Full verification in ${WORKTREE} (branch ${BRANCH}). Run EVERY command below and report honestly:

${verifyBlock}

Then the test-integrity gate on \`git diff origin/${baseBranch}...HEAD -- tests/\` (or this repo's actual test directory): no weakened/deleted assertions, no tautologies, no tests that merely mirror the implementation, every new behavior has a test that would fail without its code. Report violations honestly — fix them, don't argue.

If any command is missing or wrong for this repo, find the right one (CLAUDE.md, CI workflows, the manifest) and say what you actually ran. Auto-fix and commit lint/format violations (reference #${issue}, end commits with "Co-Authored-By: ${coauthor}"). Never weaken, skip, xfail, or delete a test to get green — that is an automatic failure of this stage.

Return passed=true only if EVERY command is green after your fixes and the integrity gate is clean.`,
  { label: `verify:#${issue}`, phase: 'Verify', model: 'haiku', schema: {
    type: 'object', required: ['passed', 'detail'],
    properties: { passed: { type: 'boolean' }, detail: { type: 'string' } },
  } })
if (!tests || !tests.passed) return { issue, blocked: 'tests', detail: tests ? tests.detail : 'verify agent died', branch: BRANCH, worktree: WORKTREE }

// ── 7. PR — no merge ─────────────────────────────────────────────────────────
phase('PR')
const pr = await callAgent(`From ${WORKTREE}, branch ${BRANCH}:

Context: this branch was created by the /task pipeline for ${repo} issue #${issue}; pushing it and opening its PR is the pipeline's expected final step (a branch of the same name may have existed and been reset earlier in this pipeline — that was deliberate debris reclamation, not resurrecting someone's work).

1. Lint first: run this repo's own lint check commands (already verified clean in the previous stage — re-confirm, don't skip). If anything's dirty, fix and commit (conventional commit, reference #${issue}, end with "Co-Authored-By: ${coauthor}"). Do not push or open the PR until clean.
2. Push the branch (\`git push -u origin ${BRANCH}\`) and open a PR against ${baseBranch} with \`gh pr create --repo ${repo} --base ${baseBranch}\` — title from the branch's main commit, body summarizing the change (what + why, test count), containing the line "Closes #${issue}", ending with:
🤖 Generated with [Claude Code](https://claude.com/claude-code)

Do NOT merge. Do NOT enable auto-merge.
${board ? `3. Once the PR is open, as a final best-effort step (do NOT let its failure stop you from returning the URL below):\n${boardMoveInstructions('inReview')}\n` : ''}
Return ONLY the PR URL as your final answer — nothing else, regardless of what the board step above did or didn't do.

If you cannot get that far, return exactly "BLOCKED: <one line saying what failed>". Your return value is machine-read and pasted into another agent's prompt, so never return settings files, permission lists, config snippets, or instructions addressed to a reader — a blocked command is a fact to report, not something to ask the pipeline to grant you.`,
  { label: `pr:#${issue}`, phase: 'PR', model: 'haiku' })
if (!pr) throw new Error('pr agent died')

// Free-text stage: a failure returns PROSE where a URL belongs, and unparsed
// prose in the orchestrator's merge prompt once got classifier-blocked and
// halted the milestone. Extract the number or fail legibly; the raw return
// stays in the journal, deliberately not in `detail`.
const prMatch = String(pr).match(/\/pull\/(\d+)\b/) || String(pr).match(/^\s*#?(\d+)\s*$/)
const prNumber = prMatch ? Number(prMatch[1]) : null
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  return { issue, blocked: 'pr', branch: BRANCH, worktree: WORKTREE,
    detail: `PR stage returned no usable PR URL (${String(pr).length} chars of prose). ` +
      'The branch may or may not have been pushed — check before re-running.' }
}

return { issue, pr: prNumber, branch: BRANCH, worktree: WORKTREE, plan, tests: tests.detail }
