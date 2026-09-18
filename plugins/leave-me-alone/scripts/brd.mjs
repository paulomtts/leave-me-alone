// The brd equivalent of gh.mjs: an injectable runner plus a parse that refuses
// to let a failure look like an empty result.
//
// Deliberately NO retries. Every call here is a local SQLite read or write, so
// a failure is a real one — retrying a CycleError just fails four times.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { jsonFrom } from './gh.mjs'

const execFileAsync = promisify(execFile)

export class BrdError extends Error {
  constructor(type, message) {
    super(`${type}: ${message}`)
    this.name = 'BrdError'
    this.type = type
  }
}

// brd prints its error payload to STDOUT and exits 1, leaving stderr EMPTY.
// execFile rejects on the non-zero exit, so the body we need is on err.stdout —
// the opposite of ghError(), which reads stderr.
export async function brdRunner(args, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync('brd', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch (err) {
    if (err && typeof err.stdout === 'string' && err.stdout.trim()) return err.stdout
    throw err
  }
}

export function brdData(text) {
  const payload = jsonFrom(text)
  if (!payload || payload.ok !== true) {
    const error = payload && payload.error
    throw new BrdError(
      (error && error.type) || 'BrdFailure',
      (error && error.message) || 'brd reported failure without an error body')
  }
  return payload.data
}

export async function brd(args, { cwd, run = brdRunner } = {}) {
  return brdData(await run(args, { cwd }))
}
