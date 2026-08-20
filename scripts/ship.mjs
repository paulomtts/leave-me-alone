#!/usr/bin/env node
// Deterministic replacement for task.js's Ship agent.
//
// Ship ran five-plus commands fenced in by prose: run every verification
// command, check they were green, push, open the PR with --head passed
// EXPLICITLY (omitting it once opened a PR from an unrelated branch under this
// subtask's title), then move the card. All of that is mechanical.
//
//   bun scripts/ship.mjs --repo o/n --issue 23 --branch m2/task-23 \
//     --base m2/task-22 --worktree /abs/wt --verify "npm test" --compact
//
// The PR title and body are DERIVED, not passed. Long text on a command line
// that an agent has to type is a quoting accident waiting to happen, and it is
// the last place a model could alter what ships. The title comes from the issue
// (minus its ordinal prefix), the body from the branch's own commits.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ghError, jsonFrom, lastLine, readFlags } from './gh.mjs'

const execFileAsync = promisify(execFile)

export async function runner(command, { cwd, shell = false } = {}) {
  const [file, ...args] = shell ? [command] : command
  const { stdout, stderr } = await execFileAsync(file, shell ? [] : args,
    { cwd, shell, maxBuffer: 64 * 1024 * 1024 })
  return { code: 0, stdout, stderr }
}

export function parseArgs(argv) {
  const out = { verify: [], compact: false }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const take = () => { if (inline !== undefined) return inline; i += 1; return argv[i] }
    if (flag === '--verify') out.verify.push(take())
    else if (flag === '--compact') out.compact = true
    else if (flag === '--repo') out.repo = take()
    else if (flag === '--issue') out.issue = Number(take())
    else if (flag === '--branch') out.branch = take()
    else if (flag === '--base') out.base = take()
    else if (flag === '--worktree') out.worktree = take()
    else if (flag === '--title') out.title = take()
    else throw new Error(`ship: unknown argument "${argv[i]}"`)
  }
  for (const [key, test, msg] of [
    ['repo', v => typeof v === 'string' && /^[^/\s]+\/[^/\s]+$/.test(v), '--repo owner/name'],
    ['issue', v => Number.isInteger(v) && v > 0, '--issue <positive integer>'],
    ['branch', v => typeof v === 'string' && v.length > 0, '--branch <name>'],
    ['base', v => typeof v === 'string' && v.length > 0, '--base <name>'],
    ['worktree', v => typeof v === 'string' && v.startsWith('/'), '--worktree <absolute path>'],
  ]) if (!test(out[key])) throw new Error(`ship needs ${msg}`)
  // An empty suite makes every check below vacuous — the same stop task.js
  // makes before it ever gets here, repeated because this script is also usable
  // on its own.
  if (out.verify.filter(Boolean).length === 0) {
    throw new Error('ship needs at least one --verify <command>; refusing to open a PR nothing verified')
  }
  return out
}

// "21.1 feat: --json output" -> "feat: --json output". The ordinal orders the
// stack; it means nothing in a PR title.
export function titleFromIssue(issueTitle) {
  return String(issueTitle ?? '').replace(/^\s*[A-Za-z]?\d+(?:\.\d+)*\.?\d*\s+/, '').trim()
}

export function buildBody(commitLines, issue) {
  const commits = (commitLines ?? []).map(l => String(l).trim()).filter(Boolean)
  return [
    commits.length ? commits.map(line => `- ${line}`).join('\n') : '- (no commit subjects found)',
    '',
    `Closes #${issue}`,
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n')
}

export async function ship(options, run = runner) {
  const { repo, issue, branch, base, worktree, verify } = options
  const result = { passed: false, verified: [], pushed: false, url: '', number: null, detail: '' }

  // Nothing uncommitted may ship: git push does not carry a dirty tree, so the
  // PR would silently lack the work.
  const status = await run(['git', '-C', worktree, 'status', '--porcelain'])
  if (String(status.stdout).trim()) {
    result.detail = `worktree is dirty, so the PR would not contain this work:\n${status.stdout.trim()}`
    return result
  }

  for (const command of verify.filter(Boolean)) {
    try {
      const out = await run(command, { cwd: worktree, shell: true })
      result.verified.push({ command, ok: true, tail: lastLine(out.stdout) })
    } catch (err) {
      result.verified.push({ command, ok: false, tail: ghError(err) })
      result.detail = `verification failed: ${command}\n${ghError(err)}`
      return result   // nothing is pushed after a red command
    }
  }
  result.passed = true

  await run(['git', '-C', worktree, 'push', '-u', 'origin', branch])
  result.pushed = true

  const issueTitle = options.title
    || titleFromIssue(jsonFrom(
      (await run(['gh', 'issue', 'view', String(issue), '--repo', repo, '--json', 'title'])).stdout).title)
  const subjects = String(
    (await run(['git', '-C', worktree, 'log', `origin/${base}..HEAD`, '--format=%s'])).stdout).split('\n')

  // --head EXPLICITLY: without it gh infers the head branch from whatever is
  // checked out in the current directory, and once opened a PR carrying five
  // commits of unrelated work under this subtask's title.
  const created = await run(['gh', 'pr', 'create', '--repo', repo, '--base', base, '--head', branch,
    '--title', issueTitle, '--body', buildBody(subjects, issue)])
  result.url = lastLine(created.stdout)
  const match = result.url.match(/\/pull\/(\d+)\b/)
  result.number = match ? Number(match[1]) : null
  if (!result.number) result.detail = `pushed, but no usable PR URL came back: ${result.url.slice(0, 200)}`
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await ship(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (!result.passed || !result.number) process.exitCode = 1
}
