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

const NO_META_WORKFLOW = `const value = 1

return { ok: value === 1 }
`

test('script with no meta export fails and says meta is missing', async () => {
  const file = await fixture('no-meta.js', NO_META_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  const output = result.stdout + result.stderr
  assert.ok(output.includes(file), `expected output to name ${file}\n${output}`)
  assert.match(output, /missing top-level "export const meta"/)
})

const INDENTED_META_WORKFLOW = `// usage:
//   export const meta = { name: 'x', description: 'y' }

return { ok: true }
`

test('an indented (non top-level) export const meta does not count as meta', async () => {
  const file = await fixture('indented-meta.js', INDENTED_META_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, /missing top-level "export const meta"/)
})

test('a syntax error short-circuits meta validation', async () => {
  const file = await fixture('broken.js', BROKEN_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  const output = result.stdout + result.stderr
  assert.match(output, /Unexpected token/)
  assert.doesNotMatch(output, /meta\./)
  assert.doesNotMatch(output, /missing top-level/)
})

const IMPURE_MESSAGE = /meta must be a plain object literal with no variables, calls, spreads, or interpolation/

const VARIABLE_META_WORKFLOW = `const NAME = 'impure'

export const meta = {
  name: NAME,
  description: 'built from a variable',
}

return { ok: true }
`

test('meta built from a variable is rejected as impure', async () => {
  const file = await fixture('variable-meta.js', VARIABLE_META_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, IMPURE_MESSAGE)
})

const SPREAD_META_WORKFLOW = `const base = { description: 'from a spread' }

export const meta = {
  ...base,
  name: 'spread',
}

return { ok: true }
`

test('meta built with a spread is rejected as impure', async () => {
  const file = await fixture('spread-meta.js', SPREAD_META_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, IMPURE_MESSAGE)
})

const CALL_META_WORKFLOW = `export const meta = {
  name: String('called'),
  description: 'built with a call',
}

return { ok: true }
`

test('meta built with a function call is rejected as impure', async () => {
  const file = await fixture('call-meta.js', CALL_META_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, IMPURE_MESSAGE)
})

const SIDE_EFFECT_WORKFLOW = `export const meta = {
  name: 'side-effect',
  description: 'a body that would explode if it ran',
}

throw new Error('should not run')
`

test('the checker never executes the module body', async () => {
  const file = await fixture('side-effect.js', SIDE_EFFECT_WORKFLOW)
  const result = await runChecker([file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout + result.stderr, /should not run/)
})
