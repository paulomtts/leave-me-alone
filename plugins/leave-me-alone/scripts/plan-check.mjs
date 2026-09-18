#!/usr/bin/env node
// Deterministic replacement for task.js's plan-check agent.
//
// The agent's entire job was: find `task-<slug>-<shortid>.md` under the plans
// directory, and grep it for one marker line. That is `ls` and `grep` — no
// judgement — yet it cost a dispatch every run because a Workflow script
// cannot touch a disk.
//
//   bun scripts/plan-check.mjs --repo-dir /abs/repo --card a32af745 --compact

import { readdir, readFile } from 'node:fs/promises'
import { readFlags } from './gh.mjs'

// A plan only counts as reusable once Validate has signed it off. The marker is
// matched literally, never by regex: a plan whose PROSE discusses the marker
// must not be mistaken for one that carries it.
export const VALIDATED_MARKER = '<!-- task-pipeline: validated -->'

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--repo-dir': 'value', '--card': 'value', '--plans-dir': 'value', '--compact': 'boolean',
  })
  const out = {
    repoDir: flags['--repo-dir'],
    card: flags['--card'],
    compact: flags['--compact'] === true,
  }
  if (typeof out.repoDir !== 'string' || !out.repoDir.startsWith('/')) {
    throw new Error('plan-check needs --repo-dir <absolute path>')
  }
  if (typeof out.card !== 'string' || !/^[0-9a-f]{8}$/.test(out.card)) {
    throw new Error('plan-check needs --card <8 hex characters>')
  }
  out.plansDir = flags['--plans-dir'] ?? `${out.repoDir}/.claude/plans`
  return out
}

// The short id is the LAST dash-delimited segment of the stem, so a longer hex
// run ending in the same 8 characters cannot match. The old check tested that
// the preceding character was not a digit, which is the wrong anchor for hex —
// `deadbeefa32af745` would have slipped through it.
export function matchesCard(filename, card) {
  const name = String(filename ?? '')
  if (!name.endsWith('.md')) return false
  const stem = name.slice(0, -'.md'.length)
  return stem.split('-').pop() === card
}

// Newest wins when several match: a re-planned subtask leaves the old file
// behind, and the stale one must not decide whether Spec/Plan/Validate re-run.
export function pickPlan(filenames, card) {
  const hits = (filenames ?? []).filter(name => matchesCard(name, card)).sort()
  return hits.length > 0 ? hits[hits.length - 1] : null
}

export async function planCheck({ plansDir, card, list = readdir, read = readFile }) {
  let entries
  try {
    entries = await list(plansDir)
  } catch {
    // No plans directory is a normal answer on a first run, not a failure.
    return { found: false, path: '', validated: false }
  }
  const name = pickPlan(entries, card)
  if (!name) return { found: false, path: '', validated: false }

  const path = `${plansDir}/${name}`
  let content = ''
  try {
    content = String(await read(path, 'utf8'))
  } catch (err) {
    return { found: true, path, validated: false, error: `could not read ${path}: ${err.message}` }
  }
  return { found: true, path, validated: content.includes(VALIDATED_MARKER) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await planCheck(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
}
