import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFile, toJsonReport } from './check-workflows.mjs'

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
  assert.throws(
    () => JSON.parse(result.stdout),
    'default mode must not emit a JSON document',
  )
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

function metaOnly(body) {
  return `export const meta = {\n${body}\n}\n\nreturn { ok: true }\n`
}

test('meta with no name fails', async () => {
  const file = await fixture('no-name.js', metaOnly(`  description: 'has no name',`))
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, /meta\.name must be a non-empty string/)
})

test('meta with an empty or blank name fails', async () => {
  for (const value of ["''", "'   '"]) {
    const file = await fixture('blank-name.js', metaOnly(`  name: ${value},\n  description: 'ok',`))
    const result = await runChecker([file])
    assert.notEqual(result.code, 0, `expected a non-zero exit code for name ${value}`)
    assert.match(result.stdout + result.stderr, /meta\.name must be a non-empty string/)
  }
})

test('meta with a non-string name fails', async () => {
  const file = await fixture('number-name.js', metaOnly(`  name: 42,\n  description: 'ok',`))
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, /meta\.name must be a non-empty string/)
})

test('meta with a missing or empty description fails', async () => {
  for (const body of [`  name: 'ok',`, `  name: 'ok',\n  description: '',`]) {
    const file = await fixture('bad-description.js', metaOnly(body))
    const result = await runChecker([file])
    assert.notEqual(result.code, 0, `expected a non-zero exit code for body ${body}`)
    assert.match(result.stdout + result.stderr, /meta\.description must be a non-empty string/)
  }
})

test('a file missing both name and description reports both, and counts as one failure', async () => {
  const file = await fixture('bare-meta.js', metaOnly(`  phases: [],`))
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  const output = result.stdout + result.stderr
  assert.match(output, /meta\.name must be a non-empty string/)
  assert.match(output, /meta\.description must be a non-empty string/)
  assert.match(result.stdout, /checked 1 workflow script\(s\); 1 failed/)
})

test('a meta-invalid file does not stop later files or inflate the failure count', async () => {
  const bad = await fixture('bare-meta.js', metaOnly(`  phases: [],`))
  const valid = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker([bad, valid])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout, /checked 2 workflow script\(s\); 1 failed/)
})

test('meta without a phases key passes', async () => {
  const file = await fixture('no-phases.js', metaOnly(`  name: 'ok',\n  description: 'no phases',`))
  const result = await runChecker([file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
})

test('meta with an empty phases array passes', async () => {
  const file = await fixture(
    'empty-phases.js',
    metaOnly(`  name: 'ok',\n  description: 'empty phases',\n  phases: [],`),
  )
  const result = await runChecker([file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
})

test('meta with non-array phases fails', async () => {
  for (const value of [`{ title: 'One' }`, `'One'`]) {
    const file = await fixture(
      'bad-phases.js',
      metaOnly(`  name: 'ok',\n  description: 'bad phases',\n  phases: ${value},`),
    )
    const result = await runChecker([file])
    assert.notEqual(result.code, 0, `expected a non-zero exit code for phases ${value}`)
    assert.match(result.stdout + result.stderr, /meta\.phases must be an array/)
  }
})

test('a phase entry with no title is reported by index', async () => {
  const file = await fixture(
    'untitled-phase.js',
    metaOnly(
      `  name: 'ok',\n  description: 'one untitled phase',\n  phases: [{ title: 'One' }, { detail: 'no title' }],`,
    ),
  )
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, /meta\.phases\[1\]\.title must be a non-empty string/)
})

test('a phase title that is blank or non-string is reported by index', async () => {
  for (const value of [`''`, `'   '`, `7`]) {
    const file = await fixture(
      'blank-phase-title.js',
      metaOnly(
        `  name: 'ok',\n  description: 'blank phase title',\n  phases: [{ title: ${value} }],`,
      ),
    )
    const result = await runChecker([file])
    assert.notEqual(result.code, 0, `expected a non-zero exit code for title ${value}`)
    assert.match(
      result.stdout + result.stderr,
      /meta\.phases\[0\]\.title must be a non-empty string/,
    )
  }
})

test('every offending phase entry is reported, not just the first', async () => {
  const file = await fixture(
    'two-bad-phases.js',
    metaOnly(
      `  name: 'ok',\n  description: 'two bad phases',\n  phases: [{ title: '' }, { title: 'Fine' }, { detail: 'no title' }],`,
    ),
  )
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  const output = result.stdout + result.stderr
  assert.match(output, /meta\.phases\[0\]\.title must be a non-empty string/)
  assert.match(output, /meta\.phases\[2\]\.title must be a non-empty string/)
  assert.doesNotMatch(output, /meta\.phases\[1\]\.title/)
})

const LITERAL_SPREAD_META_WORKFLOW = `export const meta = {
  ...{ description: 'spread from an inline literal' },
  name: 'inline-spread',
}

return { ok: true }
`

test('meta built with a spread of an inline object literal is rejected as impure', async () => {
  const file = await fixture('inline-spread-meta.js', LITERAL_SPREAD_META_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, IMPURE_MESSAGE)
})

test('checkFile collects every violation and joins them into the back-compat error string', async () => {
  const file = await fixture('bare-meta.js', metaOnly(`  phases: [],`))
  const result = await checkFile(file)
  assert.equal(result.file, file)
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    'meta.name must be a non-empty string',
    'meta.description must be a non-empty string',
  ])
  assert.equal(
    result.error,
    'meta.name must be a non-empty string; meta.description must be a non-empty string',
  )
})

test('checkFile reports a passing file with no violations and a null error', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await checkFile(file)
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.error, null)
})

const INTERPOLATED_META_WORKFLOW = `export const meta = {
  name: \`pre\${'fix'}\`,
  description: 'built from an interpolated template',
}

return { ok: true }
`

test('meta built from an interpolated template is rejected as impure', async () => {
  const file = await fixture('interpolated-meta.js', INTERPOLATED_META_WORKFLOW)
  const result = await runChecker([file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  assert.match(result.stdout + result.stderr, IMPURE_MESSAGE)
})

const PLAIN_TEMPLATE_META_WORKFLOW = `export const meta = {
  name: \`plain\`,
  description: 'a template literal with nothing interpolated',
}

return { ok: true }
`

test('a plain (uninterpolated) template literal in meta is still accepted', async () => {
  const file = await fixture('plain-template-meta.js', PLAIN_TEMPLATE_META_WORKFLOW)
  const result = await runChecker([file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
})

test('toJsonReport maps checkFile results onto the JSON contract shape', () => {
  const doc = toJsonReport([
    { file: '/tmp/a.js', ok: true, error: null, errors: [] },
    { file: '/tmp/b.js', ok: false, error: 'Unexpected token ;', errors: ['Unexpected token ;'] },
  ])
  assert.deepEqual(doc, {
    ok: false,
    results: [
      { path: '/tmp/a.js', ok: true, violations: [] },
      { path: '/tmp/b.js', ok: false, violations: ['Unexpected token ;'] },
    ],
  })
})

test('toJsonReport reports ok:true when every entry passes', () => {
  const doc = toJsonReport([{ file: '/tmp/a.js', ok: true, error: null, errors: [] }])
  assert.equal(doc.ok, true)
  assert.deepEqual(doc.results[0].violations, [])
})

test('toJsonReport preserves multiple violations on one entry instead of collapsing them', () => {
  const doc = toJsonReport([
    {
      file: '/tmp/c.js',
      ok: false,
      error: 'meta.name must be a non-empty string; meta.description must be a non-empty string',
      errors: ['meta.name must be a non-empty string', 'meta.description must be a non-empty string'],
    },
  ])
  assert.deepEqual(doc.results[0].violations, [
    'meta.name must be a non-empty string',
    'meta.description must be a non-empty string',
  ])
})

test('toJsonReport on an empty result list is ok with no results', () => {
  assert.deepEqual(toJsonReport([]), { ok: true, results: [] })
})

test('--json on an all-passing run prints a JSON document and exits 0', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker(['--json', file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.ok, true)
  assert.equal(doc.results.length, 1)
  assert.equal(doc.results[0].path, file)
  assert.equal(doc.results[0].ok, true)
  assert.deepEqual(doc.results[0].violations, [])
})

test('--json on a failing run still prints JSON and exits non-zero', async () => {
  const file = await fixture('broken.js', BROKEN_WORKFLOW)
  const result = await runChecker(['--json', file])
  assert.notEqual(result.code, 0, 'expected a non-zero exit code')
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.ok, false)
  assert.equal(doc.results[0].ok, false)
  assert.equal(doc.results[0].violations.length, 1)
  assert.match(doc.results[0].violations[0], /Unexpected token/)
})

test('--json preserves argv order across a mixed run', async () => {
  const broken = await fixture('broken.js', BROKEN_WORKFLOW)
  const valid = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker(['--json', broken, valid])
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}\n${result.stderr}`)
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.ok, false)
  assert.equal(doc.results.length, 2)
  assert.equal(doc.results[0].path, broken)
  assert.equal(doc.results[0].ok, false)
  assert.equal(doc.results[0].violations.length, 1)
  assert.equal(doc.results[1].path, valid)
  assert.equal(doc.results[1].ok, true)
  assert.deepEqual(doc.results[1].violations, [])
})

test('--json emits no human-readable lines on stdout or stderr', async () => {
  const valid = await fixture('valid.js', VALID_WORKFLOW)
  const passing = await runChecker(['--json', valid])
  assert.ok(!passing.stdout.includes('checked '), `unexpected summary line:\n${passing.stdout}`)
  assert.ok(!passing.stderr.includes('FAIL '), `unexpected FAIL line:\n${passing.stderr}`)

  const broken = await fixture('broken.js', BROKEN_WORKFLOW)
  const failing = await runChecker(['--json', broken])
  assert.ok(!failing.stdout.includes('checked '), `unexpected summary line:\n${failing.stdout}`)
  assert.ok(!failing.stderr.includes('FAIL '), `unexpected FAIL line:\n${failing.stderr}`)
})

test('--json is consumed as a flag, never treated as a target path', async () => {
  const result = await runChecker(['--json'])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  const doc = JSON.parse(result.stdout)
  assert.equal(doc.results.length, 2)
  for (const entry of doc.results) {
    assert.ok(!entry.path.includes('--json'), `unexpected target: ${entry.path}`)
  }
})

test('--json works after the target path as well as before it', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const before = await runChecker(['--json', file])
  const after = await runChecker([file, '--json'])
  assert.equal(after.code, 0, `expected exit 0, got ${after.code}\n${after.stderr}`)
  assert.deepEqual(JSON.parse(after.stdout), JSON.parse(before.stdout))
})

test('--quiet suppresses the FAIL diagnostics on a failing run', async () => {
  const file = await fixture('broken.js', BROKEN_WORKFLOW)
  const result = await runChecker(['--quiet', file])
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}\n${result.stderr}`)
  assert.ok(!result.stderr.includes('FAIL '), `unexpected FAIL line:\n${result.stderr}`)
  assert.equal(result.stderr, '', `expected empty stderr, got:\n${result.stderr}`)
})

test('--quiet still prints the summary line', async () => {
  const broken = await fixture('broken.js', BROKEN_WORKFLOW)
  const valid = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker(['--quiet', broken, valid])
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}\n${result.stderr}`)
  assert.match(result.stdout, /checked 2 workflow script\(s\); 1 failed/)
  assert.equal(result.stdout, 'checked 2 workflow script(s); 1 failed\n')
})

test('--quiet leaves exit codes unchanged', async () => {
  const valid = await fixture('valid.js', VALID_WORKFLOW)
  const passing = await runChecker(['--quiet', valid])
  assert.equal(passing.code, 0, `expected exit 0, got ${passing.code}\n${passing.stderr}`)
  assert.match(passing.stdout, /checked 1 workflow script\(s\); 0 failed/)

  const broken = await fixture('broken.js', BROKEN_WORKFLOW)
  const failing = await runChecker(['--quiet', broken])
  assert.equal(failing.code, 1, `expected exit 1, got ${failing.code}\n${failing.stdout}`)
})

test('--quiet is consumed as a flag, never treated as a target path', async () => {
  const result = await runChecker(['--quiet'])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.match(result.stdout, /checked 2 workflow script\(s\); 0 failed/)
  assert.ok(!result.stdout.includes('--quiet'), `unexpected flag in output:\n${result.stdout}`)
})

test('--quiet works after the target path as well as before it', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const before = await runChecker(['--quiet', file])
  const after = await runChecker([file, '--quiet'])
  assert.equal(after.code, before.code, 'flag order must not change the exit code')
  assert.equal(after.stdout, before.stdout)
  assert.equal(after.stderr, '')
})

test('repeated --quiet is harmless', async () => {
  const file = await fixture('valid.js', VALID_WORKFLOW)
  const result = await runChecker(['--quiet', '--quiet', file])
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stderr}`)
  assert.match(result.stdout, /checked 1 workflow script\(s\); 0 failed/)
})
