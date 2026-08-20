// Shared plumbing for the deterministic `gh` scripts.
//
// These exist because a Workflow script cannot execute a command, so anything
// that has to touch GitHub either runs out here or gets carried out by a model.
// Out here is better: no latitude, no transcription, and testable.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Injectable everywhere, so the logic above it can be tested without a network.
export async function ghRunner(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

// execFile's message is "Command failed: <the entire command>\n<stderr>", which
// for a GraphQL query buries the actual error under 200 characters of query
// text. The useful part is almost always the first line of stderr.
export function ghError(err) {
  const stderr = String((err && err.stderr) || '').trim()
  if (stderr) {
    const line = stderr.split('\n').map(l => l.trim()).filter(Boolean)[0]
    if (line) return line
  }
  return String((err && err.message) || err || 'unknown error').split('\n')[0]
}

// Same shape for git, so the scripts that touch a checkout are injectable too.
export async function gitRunner(args) {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

// Tool managers print activation banners into stdout the first time they
// resolve a binary — `mise ~/.config/mise/config.toml tools: gh@2.97.0` broke
// the very first real run of detect.mjs. That text is not our output, and it is
// not specific to mise (direnv and nvm do the same), so parse from the first
// structural character rather than assuming byte zero.
export function jsonFrom(text) {
  const raw = String(text ?? '')
  const start = raw.search(/[[{]/)
  if (start === -1) throw new Error(`expected JSON, got: ${raw.slice(0, 200).trim() || '(empty)'}`)
  return JSON.parse(raw.slice(start))
}

// Same problem for plain-text output: the value we asked for is the LAST line,
// with any banner above it.
export function lastLine(text) {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1] : ''
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

export async function withRetries(label, attempt, tries = 3) {
  let last = null
  for (let i = 0; i < tries; i += 1) {
    try { return await attempt() } catch (err) { last = err }
  }
  const error = new Error(`${label} failed after ${tries} attempts: ${last && last.message}`)
  error.cause = last
  return Promise.reject(error)
}

// Shared by every script here: a bare `--flag` or a `--flag value` / `--flag=value`
// pair, rejecting anything unrecognised rather than ignoring it.
export function readFlags(argv, spec) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const kind = spec[flag]
    if (!kind) throw new Error(`unknown argument "${argv[i]}"`)
    if (kind === 'boolean') { out[flag] = true; continue }
    out[flag] = inline !== undefined ? inline : argv[i + 1]
    if (inline === undefined) i += 1
  }
  return out
}
