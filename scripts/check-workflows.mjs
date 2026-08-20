#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const EXPORT_META_RE = /^export\s+(const\s+meta\b)/m

// Mirrors the Workflow tool's runtime harness: workflow scripts declare a
// top-level `export const meta` and use bare top-level `return` statements,
// neither of which parses as a standalone script.
export function wrapSource(source) {
  return `async function __wrap(){\n${source.replace(EXPORT_META_RE, '$1')}\n}`
}

export async function checkFile(file) {
  const source = await readFile(file, 'utf8')
  try {
    new vm.Script(wrapSource(source), { filename: file })
    return { file, ok: true, error: null }
  } catch (err) {
    return { file, ok: false, error: err.message }
  }
}

// Compiling is not enough. `const plansDir = \`${WORKTREE}/...\`` placed above
// `const WORKTREE` compiles perfectly and throws "Cannot access 'WORKTREE'
// before initialization" the moment it RUNS — which cost a live milestone to
// discover, because vm.Script never executes anything.
//
// So run each script far enough to execute all of its top-level initialization,
// with stub harness globals, and stop at the first agent dispatch. Anything
// that throws before that sentinel is an init bug.
const FIRST_DISPATCH = Symbol('first-dispatch')

// Args that satisfy each script's own validation. They are fixtures, not
// config: the point is only to get past the argument checks and into the
// initialization that follows.
export const SMOKE_ARGS = {
  'orchestrator.js': {
    repo: 'o/n', repoDir: '/tmp/x', milestone: 1, baseBranch: 'main', nonce: 'n',
    taskScript: '/tmp/x/workflows/task.js', detectScript: '/tmp/x/scripts/detect.mjs',
    project: { id: 'PVT_1', fieldId: 'F_1',
      optionIds: { backlog: 'a', inProgress: 'b', inReview: 'c', done: 'd' } },
  },
  'task.js': {
    repo: 'o/n', repoDir: '/tmp/x', issue: 1, baseBranch: 'main',
    scriptsDir: '/tmp/x/scripts',
    project: { id: 'PVT_1', fieldId: 'F_1',
      optionIds: { backlog: 'a', inProgress: 'b', inReview: 'c', done: 'd' } },
    verification: { fullSuite: ['true'] },
  },
}

export async function smokeInit(file, args) {
  if (!args) return { file, ok: true, error: null, skipped: true }
  const stop = () => { throw FIRST_DISPATCH }
  const sandbox = {
    args,
    agent: stop,
    workflow: stop,
    log: () => {},
    phase: () => {},
    parallel: async (thunks) => Promise.all((thunks ?? []).map((t) => t())),
    pipeline: async () => [],
    console,
  }
  try {
    const script = new vm.Script(`${wrapSource(await readFile(file, 'utf8'))}\n__wrap()`)
    await script.runInNewContext(sandbox, { timeout: 5000 })
    return { file, ok: false, error: 'ran to completion without dispatching an agent — the stub should have stopped it' }
  } catch (err) {
    if (err === FIRST_DISPATCH) return { file, ok: true, error: null }
    return { file, ok: false, error: `initialization failed before the first dispatch: ${err && err.message ? err.message : err}` }
  }
}

export async function listWorkflowScripts(dir) {
  const entries = await readdir(dir)
  return entries
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(dir, name))
}

export async function checkWorkflows(targets, report = (line) => console.error(line)) {
  const results = []
  for (const file of targets) {
    const result = await checkFile(file)
    if (result.ok) {
      const smoke = await smokeInit(file, SMOKE_ARGS[path.basename(file)])
      if (!smoke.ok) { result.ok = false; result.error = smoke.error }
    }
    results.push(result)
    if (!result.ok) report(`FAIL ${file}: ${result.error}`)
  }
  return results
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const quiet = args.includes('--quiet')
  const named = args.filter((arg) => arg !== '--quiet')
  const targets = named.length ? named : await listWorkflowScripts(path.join(repoRoot, 'workflows'))
  const results = await checkWorkflows(targets)
  const failed = results.filter((r) => !r.ok)
  // --quiet hides only the success summary; a failing run stays fully diagnosable.
  if (!quiet || failed.length > 0) console.log(`checked ${results.length} workflow script(s); ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}
