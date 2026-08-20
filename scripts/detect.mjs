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
//   node scripts/detect.mjs --repo you/thing --milestone 12 > state.json
//
// Step 5 (discovering how a repo runs its tests) is deliberately NOT here: it
// is reading comprehension over prose nobody standardised, which is the one
// genuinely model-shaped task in the stage. Configure it once via
// `args.verification` instead, or let the agent fall back to discovering it.

import { ghRunner, gitRunner, jsonFrom, lastLine, parseNdjson, withRetries, readFlags } from './gh.mjs'

export { jsonFrom, lastLine, parseNdjson } from './gh.mjs'

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--repo': 'value', '--milestone': 'value', '--compact': 'boolean',
    '--story-label': 'value', '--subtask-label': 'value', '--repo-dir': 'value',
  })
  const out = {
    repo: flags['--repo'],
    milestone: Number(flags['--milestone']),
    compact: flags['--compact'] === true,
    labels: {
      story: flags['--story-label'] ?? 'story',
      subtask: flags['--subtask-label'] ?? 'subtask',
    },
  }
  if (typeof out.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
    throw new Error('detect needs --repo owner/name')
  }
  if (!Number.isInteger(out.milestone) || out.milestone <= 0) {
    throw new Error('detect needs --milestone <positive integer>')
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
export async function prepareCheckout(repoDir, git = gitRunner) {
  if (!repoDir) return false
  await git(['-C', repoDir, 'fetch', 'origin'])
  await git(['-C', repoDir, 'worktree', 'prune'])
  return true
}

// Deliberately LOOSE — anything whose branch name contains any subtask number.
// The orchestrator matches exactly (derived branch, graph-derived base) and
// separately looks for near misses, so over-reporting here is free and
// under-reporting is not.
export function filterPullRequests(pulls, subtaskNumbers) {
  const numbers = [...new Set((subtaskNumbers ?? []).map(String))]
  return (pulls ?? []).filter(pull => {
    const ref = String((pull && pull.ref) ?? '')
    return numbers.some(number => ref.includes(number))
  })
}

export async function detect({ repo, milestone, labels, repoDir, run = ghRunner, git = gitRunner }) {
  const [owner, name] = repo.split('/')
  const prepared = await prepareCheckout(repoDir, git)

  const milestoneTitle = lastLine(await run(['api', `repos/${repo}/milestones/${milestone}`, '--jq', '.title']))
  if (!milestoneTitle) throw new Error(`detect: milestone #${milestone} on ${repo} has no title — wrong number or wrong repo?`)

  const storyList = jsonFrom(await run([
    'issue', 'list', '--repo', repo, '--milestone', milestoneTitle,
    '--label', labels.story, '--state', 'all', '--limit', '200',
    '--json', 'number,title,state',
  ]))

  const stories = []
  for (const story of storyList) {
    // An ERROR here is not "no dependencies" — that would be an empty nodes
    // list. Letting a failed query become [] is how a milestone ends up flat,
    // with every story dispatched at once against a base none has built on.
    const blocked = jsonFrom(await run([
      'api', 'graphql', '-f',
      'query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){blockedBy(first:50){nodes{number}}}}}',
      '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${story.number}`,
    ]))
    const blockedBy = (blocked?.data?.repository?.issue?.blockedBy?.nodes ?? []).map(node => node.number)

    // Order is the stack geometry, so the endpoint's order is preserved exactly
    // and titles are copied verbatim (their ordinal prefixes decide sorting).
    const subs = jsonFrom(await run(['api', `repos/${repo}/issues/${story.number}/sub_issues`, '--paginate']))
    const subtasks = subs.map(sub => ({
      number: sub.number, title: sub.title, state: String(sub.state ?? '').toUpperCase(),
    }))

    stories.push({ number: story.number, title: story.title, state: story.state, blockedBy, subtasks })
  }

  // REST, not `gh pr list`: the latter goes through GraphQL, which returned
  // empty results for genuinely-merged PRs during the 2026-08-17 incident.
  let pullRequests = []
  let prLookupFailed = false
  try {
    const raw = await withRetries('detect: pull request listing', () => run([
      'api', `repos/${repo}/pulls?state=all&per_page=100`, '--paginate',
      '--jq', '.[] | {number, url: .html_url, state, merged_at, ref: .head.ref, base: .base.ref}',
    ]))
    const all = parseNdjson(raw)
    pullRequests = filterPullRequests(all, stories.flatMap(story => story.subtasks.map(sub => sub.number)))
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
