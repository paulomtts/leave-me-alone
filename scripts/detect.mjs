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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Injectable so the logic below can be tested without a network or a `gh`.
export async function ghRunner(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

export function parseArgs(argv) {
  const out = { labels: { story: 'story', subtask: 'subtask' } }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const value = inline !== undefined ? inline : argv[i + 1]
    const consume = () => { if (inline === undefined) i += 1 }
    if (flag === '--repo') { out.repo = value; consume() }
    else if (flag === '--milestone') { out.milestone = Number(value); consume() }
    else if (flag === '--story-label') { out.labels.story = value; consume() }
    else if (flag === '--subtask-label') { out.labels.subtask = value; consume() }
    // Compact for machines: the orchestrator's trigger path returns this stdout
    // through an agent's structured output, and every byte saved is a byte that
    // cannot be truncated on the way.
    else if (flag === '--compact') { out.compact = true }
    else throw new Error(`detect: unknown argument "${argv[i]}"`)
  }
  if (typeof out.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
    throw new Error('detect needs --repo owner/name')
  }
  if (!Number.isInteger(out.milestone) || out.milestone <= 0) {
    throw new Error('detect needs --milestone <positive integer>')
  }
  return out
}

// `gh api --paginate --jq '.[] | …'` emits one JSON object per line rather than
// a single array, because concatenated pages would not be valid JSON.
export function parseNdjson(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{') || line.startsWith('['))
    .map(line => JSON.parse(line))
}

// Tool managers print activation banners into stdout the first time they
// resolve a binary — `mise ~/.config/mise/config.toml tools: gh@2.97.0` broke
// the very first real run of this script. That text is not our output, and it
// is not specific to mise (direnv and nvm do the same), so parse from the first
// structural character rather than assuming byte zero.
export function jsonFrom(text) {
  const raw = String(text ?? '')
  const start = raw.search(/[[{]/)
  if (start === -1) throw new Error(`detect: expected JSON, got: ${raw.slice(0, 200).trim() || '(empty)'}`)
  return JSON.parse(raw.slice(start))
}

// Same problem for plain-text output: the value we asked for is the LAST line,
// with any banner above it.
export function lastLine(text) {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1] : ''
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

async function withRetries(label, attempt, tries = 3) {
  let last = null
  for (let i = 0; i < tries; i += 1) {
    try { return await attempt() } catch (err) { last = err }
  }
  const error = new Error(`detect: ${label} failed after ${tries} attempts: ${last && last.message}`)
  error.cause = last
  return Promise.reject(error)
}

export async function detect({ repo, milestone, labels, run = ghRunner }) {
  const [owner, name] = repo.split('/')

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
    const raw = await withRetries('pull request listing', () => run([
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

  return { milestoneTitle, stories, pullRequests, prLookupFailed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await detect(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
}
