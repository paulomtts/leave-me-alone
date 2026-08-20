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
  const targets = args.length ? args : await listWorkflowScripts(path.join(repoRoot, 'workflows'))
  const results = await checkWorkflows(targets)
  const failed = results.filter((r) => !r.ok)
  console.log(`checked ${results.length} workflow script(s); ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}
