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

import { gitRunner, readFlags, withRetries } from './gh.mjs'
import { brd, brdRunner } from './brd.mjs'
import { findMilestone, flattenMilestone } from './census.mjs'
import { shortId } from './naming.mjs'

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
// no longer pushes at all — every subtask's parent is another LOCAL branch in
// this same checkout, already up to date the moment it was created. Only the
// milestone base itself needs the network, and freezing it here with the one
// fetch this function performs is a feature — every story in the run then
// builds on the same base rather than on whatever landed mid-run.
//
// A fully local repo (no remote at all — the normal shape for a solo,
// not-yet-pushed project under this same local-only DRIVE) has nothing for
// that fetch to reach. `git fetch origin` there fails outright with `'origin'
// does not appear to be a git repository`, which used to kill the run before
// a single subtask was dispatched — for a repo that was never going to touch
// the network anyway. So the fetch itself is conditional on an `origin`
// remote actually being configured; a repo with none just skips straight to
// the (always-local, always-safe) prune.
export async function prepareCheckout(repoDir, git = gitRunner, wait) {
  if (!repoDir) return false
  const remotes = (await git(['-C', repoDir, 'remote']))
    .split('\n').map(line => line.trim()).filter(Boolean)
  if (remotes.includes('origin')) {
    // Retried the same way a now-removed PR listing used to be, and for the
    // same reason: this is a network call, and it is the FIRST thing a run
    // does. An HTTP2 framing flake here killed a whole milestone at Detect —
    // before a single subtask was dispatched.
    await withRetries('detect: git fetch', () => git(['-C', repoDir, 'fetch', 'origin']), { wait })
  }
  // Local, so a single attempt is right: a failure here is a real problem with
  // the checkout, not the network, and retrying would just hide it.
  await git(['-C', repoDir, 'worktree', 'prune'])
  return true
}

export async function detect({ repo, milestone, repoDir, runBrd = brdRunner, git = gitRunner, wait }) {
  const prepared = await prepareCheckout(repoDir, git, wait)

  // One local call replaces a milestone lookup, a story list, and what used
  // to be two API calls per story. NOT wrapped in withRetries: brd is local,
  // so a failure is real.
  const roots = await brd(['tree'], { cwd: repoDir, run: runBrd })
  const { milestoneTitle, stories } = flattenMilestone(findMilestone(roots, milestone))

  // Validate all card IDs are well-formed before returning. A malformed card id
  // is a data-integrity bug, not a network condition.
  stories.flatMap(story => story.subtasks.map(sub => shortId(sub.id)))

  return { milestoneTitle, stories, prepared }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await detect(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
}
