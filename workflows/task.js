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

// project: fully resolved ids, passed down by the orchestrator. Omit entirely
// for boardless repos — every board step then no-ops instead of failing the run.
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
// actually driven. Pass the resolved block, or omit `project` to run boardless.
// (orchestrator.js still accepts a plain {number: N} — resolving by name is its
// job, not this file's.)
const DEFAULT_OPTION_NAMES = { backlog: 'Backlog', inProgress: 'In progress', inReview: 'In review', done: 'Done' }

function resolveProject() {
  if (!project) return null
  if (!(project.id && project.fieldId && project.optionIds)) {
    log('project passed without resolved ids (id/fieldId/optionIds) — board steps disabled for this run. '
      + 'Either let the orchestrator resolve and forward them, or resolve them once yourself '
      + '(see the setup-project skill) and pass the whole block. Omit `project` entirely to run boardless on purpose.')
    return null
  }
  return {
    id: project.id, fieldId: project.fieldId, optionIds: project.optionIds,
    statusField: project.statusField || 'Status',
    optionNames: { ...DEFAULT_OPTION_NAMES, ...(project.optionNames || project.options || {}) },
  }
}
const board = resolveProject()
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
  b. Else the branch (and possibly its worktree) already exists. First rule out live work on it — this is the ONLY place that check happens, so do not skip it: \`gh api "repos/${repo}/pulls?state=open&per_page=100" --jq '.[] | select(.head.ref=="${BRANCH}") | .number'\`. An OPEN PR here means STOP: report the PR number and change NOTHING — never reset, delete, or commit over it. (The caller established there was no live PR when it queued this subtask; one appearing since means something else is driving this branch, and that is a human's call, not yours.)
     No open PR: ensure the worktree exists (\`git worktree add ${WORKTREE} ${BRANCH}\` if ${WORKTREE} is missing), then decide RESUME vs RESET by whether the branch's own commits implement the CURRENT plan:
     - Compute \`PLAN_HASH=$(sha256sum "${plan}" | cut -c1-8)\`. Do NOT modify \`${plan}\`'s content at any point in this workflow — its exact bytes are the resume key this hash is derived from, for this run and every future resume attempt. If ticking off plan checkboxes as you go is a habit, resist it here.
     - If the \`sha256sum\` command fails, or \`$PLAN_HASH\` ends up empty, STOP and report the failure. Never proceed with an empty/missing hash — not for the resume-check below, and not for committing later.
     - Check for a matching trailer, scoped to this branch's own commits (not inherited history from origin/${baseBranch}): \`git -C ${WORKTREE} log origin/${baseBranch}..HEAD --grep="^Plan-Hash: $PLAN_HASH" --format=%H\`.
     - If that returns any commit: RESUME. These commits genuinely implement the plan you were just given (a killed earlier run, not stale debris). Do NOT reset. Run \`git -C ${WORKTREE} log --oneline origin/${baseBranch}..HEAD\` and read the plan's step list to see which steps are already committed, then continue STRICT TDD from the next uncompleted step — do not re-do committed steps.
     - If it returns nothing (empty, or the branch predates this convention): RESET. This branch is stale relative to the current plan (an earlier attempt under a different/no plan). \`git -C ${WORKTREE} reset --hard origin/${baseBranch}\` and start the TDD steps below from scratch. A hard reset over genuinely stale debris is deliberate: this plan-driven run re-derives the work deterministically, while building on unrelated partial state does not.
  This keeps the branch prefix STABLE — which is what lets already-merged subtasks stay detectable — while making leftovers self-healing instead of either a hard stop or blind data loss. NEVER work around a collision by inventing a different branch name: the caller decides whether a subtask is already done by finding the PR whose head ref carries this issue's number, and a name you invented is invisible to that lookup.
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

Return a structured result. This stage has THREE stop conditions, all above: an OPEN PR on \`${BRANCH}\`; a \`sha256sum\` that failed or gave an empty PLAN_HASH; a baseline suite already red before you changed anything. Reporting one of those in prose while claiming success is the single worst outcome here — the pipeline would review, verify and open a PR on top of a stop you were told to make.

- blocked: true if ANY stop condition fired, or anything else made implementation impossible. false only if you completed the TDD work.
- blockedReason: when blocked, ONE line naming which condition fired plus the concrete detail (the PR number, the command that failed, the tests already red). Empty when blocked=false.
- existingPr: ONLY when an open PR on \`${BRANCH}\` is what stopped you — its number. Omit otherwise.
- resumed: true if you continued from existing Plan-Hash commits; false if you started fresh (path (a), or after a RESET).
- report: the normal implementation report — commits made (oneline), test count added, deviations from the plan with reasons. The reviewer reads this next, so keep it factual and scoped to what you changed. Empty when blocked=true.

Do not set blocked=true for a difficulty you worked through and solved.`,
  { label: `implement:#${issue}`, phase: 'Implement', model: 'sonnet', schema: {
    type: 'object', required: ['blocked', 'report'],
    properties: {
      blocked: { type: 'boolean' }, blockedReason: { type: 'string' },
      existingPr: { type: 'integer' }, resumed: { type: 'boolean' },
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
- taggedCount: the THIRD command's number.`,
  { label: `review:#${issue}`, phase: 'Review', model: 'opus', schema: {
    type: 'object', required: ['findings'],
    properties: {
      findings: { type: 'array', items: { type: 'string' } },
      unresolvedBlockers: { type: 'array', items: { type: 'string' } },
      fixSummary: { type: 'string' },
      porcelain: { type: 'string' },
      commitCount: { type: 'integer' },
      taggedCount: { type: 'integer' },
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

// Two gates that used to be prose in Ship's prompt — "if it is dirty, STOP",
// "if TAGGED is less than COMMITS, STOP". Both are decisions about numbers and
// an empty string, so they belong here, in code, where they are deterministic
// and visible. Review is the last stage that writes, so this is the earliest
// boundary at which they can be judged, and gating here costs no dispatch:
// Ship simply never boots.
//
// Review is asked to REPORT these, never to interpret or act on them. An agent
// that both measures and judges can talk itself out of the judgement.
const porcelain = String((review && review.porcelain) || '').trim()
if (porcelain.length > 0) {
  return { issue, blocked: 'tests', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `worktree still dirty after review, so the PR would not contain this work (nothing was pushed):\n${porcelain}` }
}

// Implement decides RESUME vs RESET by grepping for exactly this trailer, so an
// untagged commit reads as stale debris and a later run would `reset --hard` it
// away. Catching that here, before anything is pushed, is the whole point.
const commitCount = Number(review && review.commitCount)
const taggedCount = Number(review && review.taggedCount)
if (!Number.isInteger(commitCount) || !Number.isInteger(taggedCount)) {
  log(`review did not report usable commit/trailer counts (${review && review.commitCount}/${review && review.taggedCount}) — Plan-Hash gate skipped`)
} else if (commitCount === 0) {
  return { issue, blocked: 'implement', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `branch ${BRANCH} has no commits on top of ${baseBranch} — implementation produced nothing to ship.` }
} else if (taggedCount < commitCount) {
  return { issue, blocked: 'implement', branch: BRANCH, worktree: WORKTREE, plan,
    detail: `only ${taggedCount} of ${commitCount} commits on ${BRANCH} carry their Plan-Hash trailer, so a future run would read this branch as stale and hard-reset it. Nothing was pushed. Do NOT re-run this subtask until the trailers are added (interactively, by a human) or the work is otherwise preserved.` }
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
const ship = await callAgent(`Verify and ship ${repo} subtask #${issue} from ${WORKTREE} (branch ${BRANCH}). These steps are strictly ordered, and the ordering is the whole point: nothing is pushed until everything above it is green.

1. Run EVERY verification command below, each as its own invocation:
${verifyBlock}
   Report exactly what happened. Do NOT fix, edit, or commit anything — you are the independent check, and a stage that repairs what it measures cannot report on it. Never weaken, skip, xfail, or delete a test to get green. If a command is missing or wrong for this repo, say so in detail rather than substituting one of your own. (The worktree was confirmed clean, and its commits confirmed well-formed, before you were dispatched — you do not need to re-check either.)

2. ONLY if every command in step 1 exited green: \`git push -u origin ${BRANCH}\`.
   (This branch was created by the /task pipeline for issue #${issue}; pushing it is the pipeline's expected final step. A branch of this name may have been reset earlier in this pipeline — that was deliberate debris reclamation, not resurrecting someone's work.)

3. Then open the PR. Pass \`--head\` EXPLICITLY — without it \`gh\` infers the head branch from whatever is checked out in the current directory, and if that is not this worktree it will open a PR from an unrelated branch under this subtask's title (observed: a PR carrying 5 commits of someone else's work, titled as this subtask):
   \`gh pr create --repo ${repo} --base ${baseBranch} --head ${BRANCH}\` with:
   - a title: one conventional-commit-style line describing the branch's work.
   - a body: what changed and why, plus the test count, taken from the implementer's report below — do not re-derive it from the diff. It MUST contain the line "Closes #${issue}" and end with:
🤖 Generated with [Claude Code](https://claude.com/claude-code)
   Do NOT merge. Do NOT enable auto-merge.

Implementer's report:
${clip(impl.report, 6000, 'implementer report')}
${board ? `
4. Once the PR is open, as a final best-effort step (do NOT let its failure change anything you return):
${boardMoveInstructions('inReview')}` : ''}

Return:
- passed: true only if EVERY command in step 1 exited green.
- url: the PR's full https URL exactly as \`gh pr create\` printed it. Empty string if you did not open one — which MUST be the case whenever passed=false.
- detail: what you ran and what failed.
- blockedReason: only if you pushed but could not open the PR, one line naming what failed.

Your return is machine-read: never return settings files, permission lists, config snippets, or instructions addressed to a reader — a blocked command is a fact to report, not a permission to ask the pipeline to grant you.`,
  { label: `ship:#${issue}`, phase: 'Ship', model: 'haiku', schema: {
    type: 'object', required: ['passed', 'detail'],
    properties: {
      passed: { type: 'boolean' },
      url: { type: 'string' }, detail: { type: 'string' },
      blockedReason: { type: 'string' },
    },
  } })
if (!ship) throw new Error('ship agent died')

// `blocked: 'tests'` is load-bearing: orchestrator.js maps that exact string to
// escalation trigger 'tests' and everything else to 'blocked', which route
// differently. The dirty-tree and Plan-Hash gates that used to live here are
// now decided in script above, off Review's reported values.
if (!ship.passed) {
  return { issue, blocked: 'tests', branch: BRANCH, worktree: WORKTREE, plan, detail: ship.detail }
}

// gh prints the canonical URL, so this now VALIDATES that shape rather than
// scraping a number out of prose (which is what it had to do when this stage
// returned free text).
const prMatch = String(ship.url ?? '').match(/\/pull\/(\d+)\b/)
const prNumber = prMatch ? Number(prMatch[1]) : null
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  return { issue, blocked: 'pr', branch: BRANCH, worktree: WORKTREE, plan,
    detail: ship.blockedReason
      || `verification passed but no usable PR URL came back (${String(ship.url ?? '').length} chars). The branch may or may not have been pushed — check before re-running.` }
}

return { issue, pr: prNumber, branch: BRANCH, worktree: WORKTREE, plan, tests: ship.detail }
