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

const IMPURE_META =
  'meta must be a plain object literal with no variables, calls, spreads, or interpolation'

function skipQuoted(source, start) {
  const quote = source[start]
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1
      continue
    }
    if (source[i] === quote) return i
  }
  return source.length
}

// Slices the `{ ... }` that follows a top-level `export const meta =`, balancing
// braces while stepping over strings, template literals and comments.
export function extractMetaLiteral(source) {
  const match = EXPORT_META_RE.exec(source)
  if (!match) return null
  const eq = source.indexOf('=', match.index + match[0].length)
  if (eq === -1) return null
  const start = source.indexOf('{', eq)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipQuoted(source, i)
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      if (nl === -1) return null
      i = nl
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 1
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

// Runs the literal alone, in a context with no sandbox globals: a pure object
// literal resolves, a reference to an undefined free identifier throws. This
// alone does not catch calls to language built-ins (String, Math, JSON, ...) —
// a fresh vm context always carries those, they are intrinsic to any JS realm
// and cannot be stripped — so callers must run `hasImpureSyntax` first.
export function resolveMetaLiteral(literal) {
  const script = new vm.Script(`(${literal})`)
  return script.runInContext(vm.createContext(Object.create(null)), { timeout: 1000 })
}

// Beyond free-identifier references (caught by resolveMetaLiteral throwing), a
// pure object literal never legitimately needs `(`, `...` or a `${}` template
// substitution: reject all three syntactically, since a call to a built-in
// (String(), Math.max(), ...) or an interpolation of a constant would otherwise
// resolve silently in the empty vm context instead of throwing.
export function hasImpureSyntax(literal) {
  for (let i = 0; i < literal.length; i += 1) {
    const ch = literal[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipQuoted(literal, i)
      if (ch === '`' && literal.slice(i, end).includes('${')) return true
      i = end
      continue
    }
    if (ch === '/' && literal[i + 1] === '/') {
      const nl = literal.indexOf('\n', i)
      i = nl === -1 ? literal.length : nl
      continue
    }
    if (ch === '/' && literal[i + 1] === '*') {
      const end = literal.indexOf('*/', i + 2)
      i = end === -1 ? literal.length : end + 1
      continue
    }
    if (ch === '(' || (ch === '.' && literal[i + 1] === '.' && literal[i + 2] === '.')) {
      return true
    }
  }
  return false
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function validateMeta(source) {
  if (!EXPORT_META_RE.test(source)) return ['missing top-level "export const meta"']
  const literal = extractMetaLiteral(source)
  if (literal === null || hasImpureSyntax(literal)) return [IMPURE_META]
  let meta
  try {
    meta = resolveMetaLiteral(literal)
  } catch {
    return [IMPURE_META]
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return [IMPURE_META]

  const errors = []
  if (!isNonEmptyString(meta.name)) errors.push('meta.name must be a non-empty string')
  if (!isNonEmptyString(meta.description)) {
    errors.push('meta.description must be a non-empty string')
  }
  if ('phases' in meta) {
    if (!Array.isArray(meta.phases)) {
      errors.push('meta.phases must be an array')
    } else {
      meta.phases.forEach((phase, index) => {
        const isObject = typeof phase === 'object' && phase !== null && !Array.isArray(phase)
        if (!isObject || !isNonEmptyString(phase.title)) {
          errors.push(`meta.phases[${index}].title must be a non-empty string`)
        }
      })
    }
  }
  return errors
}

export async function checkFile(file) {
  const source = await readFile(file, 'utf8')
  try {
    new vm.Script(wrapSource(source), { filename: file })
  } catch (err) {
    return { file, ok: false, error: err.message, errors: [err.message] }
  }
  const errors = validateMeta(source)
  return {
    file,
    ok: errors.length === 0,
    error: errors.length === 0 ? null : errors.join('; '),
    errors,
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
    for (const message of result.errors) report(`FAIL ${file}: ${message}`)
  }
  return results
}

export function toJsonReport(results) {
  const mapped = results.map((result) => ({
    path: result.file,
    ok: result.ok,
    violations: result.errors,
  }))
  return { ok: mapped.every((entry) => entry.ok), results: mapped }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const quiet = args.includes('--quiet')
  const paths = args.filter((arg) => arg !== '--json' && arg !== '--quiet')
  const targets = paths.length ? paths : await listWorkflowScripts(path.join(repoRoot, 'workflows'))
  // `--json` wins over `--quiet`: JSON mode already drops both the FAIL lines and
  // the summary, so it is strictly quieter, and its document is the payload the
  // caller asked for — silencing it would leave nothing but an exit code. Both
  // modes suppress the per-file diagnostics with the same no-op `report`;
  // passing `undefined` keeps `checkWorkflows`'s `console.error` default.
  const results = await checkWorkflows(targets, json || quiet ? () => {} : undefined)
  const failed = results.filter((r) => !r.ok)
  if (json) {
    console.log(JSON.stringify(toJsonReport(results), null, 2))
  } else {
    console.log(`checked ${results.length} workflow script(s); ${failed.length} failed`)
  }
  process.exit(failed.length > 0 ? 1 : 0)
}
