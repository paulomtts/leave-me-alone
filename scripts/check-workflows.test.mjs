import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const CHECKER = path.join(repoRoot, 'scripts', 'check-workflows.mjs')

const VALID_WORKFLOW = `export const meta = {
  name: 'fixture',
  description: 'a valid workflow-shaped script',
  phases: [{ title: 'One', detail: 'does a thing', model: 'haiku' }],
}

const value = 1
if (value === 0) {
  return { ok: false }
}

return { ok: true }
`

async function runChecker(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CHECKER, ...args])
    return { code: 0, stdout, stderr }
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

async function fixture(name, source) {
  const dir = await mkdtemp(path.join(tmpdir(), 'check-workflows-'))
  const file = path.join(dir, name)
  await writeFile(file, source, 'utf8')
  return file
}

test('valid workflow-shaped script passes', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker([file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
})

test('real workflows/*.js scripts pass with no arguments', async () => {
  const result = await runChecker([])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.match(result.stdout, /checked 2 workflow script\(s\); 0 failed/)
})

test('real workflow scripts pass when named explicitly', async () => {
  const result = await runChecker([
    path.join(repoRoot, 'workflows', 'orchestrator.js'),
    path.join(repoRoot, 'workflows', 'task.js'),
  ])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
})

const BROKEN_WORKFLOW = `export const meta = { name: 'broken' }

const value = ;

return { ok: true }
`

test('script with a real syntax error fails and names the file', async () => {
  const file = await fixture('broken.js', BROKEN_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  const output = result.stdout + result.stderr
  assert.ok(output.includes(file), `expected output to name ${file}\n${output}`)
  assert.match(output, /Unexpected token/)
})

test('a broken file does not stop later files from being checked', async () => {
  const broken = await fixture('broken.js', BROKEN_WORKFLOW)
  const valid = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker([broken, valid])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout, /checked 2 workflow script\(s\); 1 failed/)
})

const SUMMARY_RE = /checked \d+ workflow script\(s\)/

test('--quiet alone suppresses the summary and still checks workflows/', async () => {
  const result = await runChecker(['--quiet'])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, SUMMARY_RE)
})

test('--quiet before an explicit passing target suppresses the summary', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker(['--quiet', file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, SUMMARY_RE)
})

test('--quiet after an explicit passing target suppresses the summary', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker([file, '--quiet'])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, SUMMARY_RE)
})

test('--quiet still reports failures, the summary, and exit 1', async () => {
  const file = await fixture('broken.js', BROKEN_WORKFLOW)
  const result = await runChecker(['--quiet', file])
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}`)
  const output = result.stdout + result.stderr
  assert.ok(output.includes(file), `expected output to name ${file}\n${output}`)
  assert.match(output, /Unexpected token/)
  assert.match(result.stdout, /checked 1 workflow script\(s\); 1 failed/)
})

// ── smokeInit ────────────────────────────────────────────────────────────────
// Compiling is not enough: a `const` referenced above its own declaration
// compiles fine and throws only when the script RUNS. That shipped once and
// took a live milestone to find.

import { smokeInit, SMOKE_ARGS } from './check-workflows.mjs'

const scratch = async (body) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'smoke-'))
  const file = path.join(dir, 'x.js')
  await writeFile(file, body)
  return file
}

test('a script that reaches its first dispatch passes', async () => {
  const file = await scratch("export const meta = {}\nconst a = 1\nawait agent('go')\n")
  const got = await smokeInit(file, { any: true })
  assert.equal(got.ok, true)
})

test('a temporal dead zone is caught — the bug that shipped', async () => {
  const file = await scratch("export const meta = {}\nconst derived = `${LATER}/x`\nconst LATER = '/wt'\nawait agent('go')\n")
  const got = await smokeInit(file, { any: true })
  assert.equal(got.ok, false)
  assert.match(got.error, /Cannot access 'LATER' before initialization/)
})

test('any throw before the first dispatch is caught, not just TDZ', async () => {
  const file = await scratch("export const meta = {}\nthrow new Error('args are wrong')\n")
  const got = await smokeInit(file, { any: true })
  assert.equal(got.ok, false)
  assert.match(got.error, /args are wrong/)
})

test('a script that never dispatches is a failure, not a pass', async () => {
  // Otherwise a script that silently returned early would look healthy.
  const file = await scratch("export const meta = {}\nconst a = 1\n")
  const got = await smokeInit(file, { any: true })
  assert.equal(got.ok, false)
  assert.match(got.error, /without dispatching an agent/)
})

test('a script with no fixture is skipped rather than guessed at', async () => {
  const got = await smokeInit('/nonexistent.js', undefined)
  assert.equal(got.ok, true)
  assert.equal(got.skipped, true)
})

test('both workflow scripts have fixtures', () => {
  // A new workflow script without one would silently skip this whole check.
  assert.deepEqual(Object.keys(SMOKE_ARGS).sort(), ['orchestrator.js', 'task.js'])
})
