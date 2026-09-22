#!/usr/bin/env node
// Deterministic replacement for task.js's Ship agent.
//
// Ship runs every verification command, checks they were green, then reports
// pass/fail. It never pushes and never opens a PR — this workflow never has,
// since the migration off GitHub; the card reaches `done` on a local commit.
//
//   bun scripts/ship.mjs --card a32af745 --branch m12/task-write-rows-a32af745 \
//     --base m12/task-write-columns-91a2 --worktree /abs/wt --verify "npm test" --compact
//
// The card is accepted only for the caller's own logging/bookkeeping; ship()
// itself never reads or returns it. The title is no longer needed because we
// don't open PRs anymore.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ghError, lastLine, plainText, readFlags } from './gh.mjs'

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
    else if (flag === '--card') out.card = take()
    else if (flag === '--branch') out.branch = take()
    else if (flag === '--base') out.base = take()
    else if (flag === '--worktree') out.worktree = take()
    else throw new Error(`ship: unknown argument "${argv[i]}"`)
  }
  for (const [key, test, msg] of [
    ['card', v => typeof v === 'string' && v.length > 0, '--card <shortid>'],
    ['branch', v => typeof v === 'string' && v.length > 0, '--branch <name>'],
    ['base', v => typeof v === 'string' && v.length > 0, '--base <name>'],
    ['worktree', v => typeof v === 'string' && v.startsWith('/'), '--worktree <absolute path>'],
  ]) if (!test(out[key])) throw new Error(`ship needs ${msg}`)
  if (out.verify.filter(Boolean).length === 0) {
    throw new Error('ship needs at least one --verify <command>; refusing to mark a card done nothing verified')
  }
  return out
}

// ghError only reads err.stderr, which is right for gh/git (they always put
// the real error there) but wrong here: verify commands are arbitrary repo
// scripts, and linters/gate scripts routinely print their diagnostic to
// STDOUT and exit non-zero, leaving stderr empty. Seven live Ship runs all
// reported the content-free "Command failed: ./scripts/gate-frontend.sh" —
// ghError never looked at the stream the actual diagnostic was on. Prefer the
// last non-empty line of stderr (real errors, when a tool does use it), fall
// back to the last non-empty line of stdout (the gate-frontend.sh case),
// otherwise fall back to ghError's bare-message handling.
export function verifyError(err) {
  const stderr = lastLine(String((err && err.stderr) || ''))
  if (stderr) return stderr
  const stdout = lastLine(String((err && err.stdout) || ''))
  if (stdout) return stdout
  return ghError(err)
}

export async function ship(options, run = runner, wait) {
  const { branch, worktree, verify } = options
  const result = { passed: false, verified: [], detail: '' }

  // Nothing uncommitted may ship: a dirty tree means the branch does not yet
  // carry the work it claims to.
  const status = await run(['git', '-C', worktree, 'status', '--porcelain'])
  if (String(status.stdout).trim()) {
    result.detail = plainText(`worktree is dirty, so the branch would not contain this work: ${status.stdout.trim()}`, 600)
    return result
  }

  for (const command of verify.filter(Boolean)) {
    try {
      const out = await run(command, { cwd: worktree, shell: true })
      result.verified.push({ command, ok: true, tail: plainText(lastLine(out.stdout)) })
    } catch (err) {
      result.verified.push({ command, ok: false, tail: plainText(verifyError(err)) })
      result.detail = plainText(`verification failed: ${command} — ${verifyError(err)}`, 600)
      return result   // nothing is marked done after a red command
    }
  }
  result.passed = true
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await ship(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (!result.passed) process.exitCode = 1
}
