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

test('--quiet suppresses the summary when nothing fails', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker(['--quiet', file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /checked \d+ workflow script\(s\)/)
})

test('--quiet still prints failures and still exits non-zero', async () => {
  const file = await fixture('broken.js', BROKEN_WORKFLOW)
  const result = await runChecker(['--quiet', file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  const output = result.stdout + result.stderr
  assert.ok(output.includes(file), `expected output to name ${file}\n${output}`)
  assert.match(output, /FAIL /)
})

test('--quiet is not treated as a target path', async () => {
  const result = await runChecker(['--quiet'])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.equal(result.stdout, '', `expected empty stdout, got ${JSON.stringify(result.stdout)}`)
})
