#!/usr/bin/env node
// Deterministic replacement for the orchestrator's Detect agent, steps 1-4.
//
// Those steps are `gh` calls, a loop, and a JSON reshape — no judgement of any
// kind. They ran through an agent for exactly one reason: a Workflow script
// cannot execute a command, so asking a model was the only way to reach `gh`.
// That rented a shell with opinions, and it acted on them: substituting
// `gh pr list` for the endpoint it was given, reporting an API failure as an
// empty list, tidying a branch name in transit. Every one of those cost a run.
//
// This script has no opinions. Run it outside the sandbox and hand the JSON to
// the orchestrator as `args.state`:
//
//   node scripts/detect.mjs --repo you/thing --milestone <card id or title substring> > state.json
//
// Step 5 (discovering how a repo runs its tests) is deliberately NOT here: it
// is reading comprehension over prose nobody standardised, which is the one
// genuinely model-shaped task in the stage. Configure it once via
// `args.verification` instead, or let the agent fall back to discovering it.

import { ghRunner, gitRunner, jsonFrom, lastLine, parseNdjson, withRetries, readFlags } from './gh.mjs'
import { brd, brdRunner } from './brd.mjs'
import { findMilestone, flattenMilestone } from './census.mjs'
import { shortId } from './naming.mjs'

export { jsonFrom, lastLine, parseNdjson } from './gh.mjs'

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

// Refresh the shared checkout ONCE, here, because this runs before any subtask
// is dispatched.
//
// It used to happen inside every Implement stage, which is a problem the moment
// more than one story runs at a time: up to maxConcurrentStories task.js runs
// share one .git, and `worktree prune` is a GLOBAL sweep that removes
// registrations whose directories are missing. One lane can prune another
// lane's worktree in the window between `worktree add` registering it and the
// directory appearing. Narrow, destructive, and it would present as "the
// worktree vanished mid-run".
//
// Hoisting the fetch is safe because a stack parent needs no fetch: ship.mjs
// pushes with `git push -u origin <branch>`, which updates this checkout's own
// refs/remotes/origin/<branch> as a side effect. Only the milestone base comes
// from the network, and freezing it here is a feature — every story in the run
// then builds on the same base rather than on whatever landed mid-run.
export async function prepareCheckout(repoDir, git = gitRunner, wait) {
  if (!repoDir) return false
  // Retried like the PR listing is, and for the same reason: this is a network
  // call, and it is the FIRST thing a run does. An HTTP2 framing flake here
  // killed a whole milestone at Detect — before a single subtask was
  // dispatched — while the identical class of failure on the PR listing was
  // already being absorbed three attempts deep.
  await withRetries('detect: git fetch', () => git(['-C', repoDir, 'fetch', 'origin']), { wait })
  // Local, so a single attempt is right: a failure here is a real problem with
  // the checkout, not the network, and retrying would just hide it.
  await git(['-C', repoDir, 'worktree', 'prune'])
  return true
}

// Deliberately LOOSE — anything whose branch name contains any subtask's short
// id. The orchestrator matches exactly and separately looks for near misses, so
// over-reporting here is free and under-reporting is not.
//
// Takes already-resolved SHORT ids, not card ids: the caller resolves those
// with shortId() before the PR-listing try/catch, so a malformed card id
// aborts the run instead of being caught there and reported as prLookupFailed.
export function filterPullRequests(pulls, subtaskShortIds) {
  const ids = [...new Set(subtaskShortIds ?? [])]
  return (pulls ?? []).filter(pull => {
    const ref = String((pull && pull.ref) ?? '')
    return ids.some(id => ref.includes(id))
  })
}

export async function detect({ repo, milestone, repoDir, run = ghRunner, runBrd = brdRunner, git = gitRunner, wait }) {
  const prepared = await prepareCheckout(repoDir, git, wait)

  // One local call replaces a milestone lookup, a story list, and two API calls
  // per story. NOT wrapped in withRetries: brd is local, so a failure is real.
  const roots = await brd(['tree'], { cwd: repoDir, run: runBrd })
  const { milestoneTitle, stories } = flattenMilestone(findMilestone(roots, milestone))

  // Resolved BEFORE the try: shortId throws on a malformed card id, and that is a
  // data-integrity bug, not a network condition. Inside the try it would be caught
  // and reported as prLookupFailed — the same "a failed read looks like no data"
  // collapse this module exists to avoid.
  const subtaskShortIds = stories.flatMap(story => story.subtasks.map(sub => shortId(sub.id)))

  // REST, not `gh pr list`: the latter goes through GraphQL, which returned
  // empty results for genuinely-merged PRs during the 2026-08-17 incident.
  let pullRequests = []
  let prLookupFailed = false
  try {
    const raw = await withRetries('detect: pull request listing', () => run([
      'api', `repos/${repo}/pulls?state=all&per_page=100`, '--paginate',
      '--jq', '.[] | {number, url: .html_url, state, merged_at, ref: .head.ref, base: .base.ref}',
    ]), { wait })
    const all = parseNdjson(raw)
    pullRequests = filterPullRequests(all, subtaskShortIds)
  } catch (err) {
    // NOT an empty list. "The API did not answer" and "there are no PRs" must
    // stay distinguishable, or merged work gets re-implemented.
    prLookupFailed = true
    process.stderr.write(`${err.message}\n`)
  }

  return { milestoneTitle, stories, pullRequests, prLookupFailed, prepared }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await detect(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
}
