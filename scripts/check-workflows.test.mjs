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
