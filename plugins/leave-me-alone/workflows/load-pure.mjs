// Load the pure region of a Workflow script as a real module.
//
// Workflow scripts execute in a sandbox with no module resolution, so they
// cannot `import` a shared library — but their decision logic is plain,
// side-effect-free JavaScript worth testing. Each script marks that logic with
// PURE:BEGIN / PURE:END; this slices the region out and evaluates it as an ES
// module, so tests run against the SAME bytes the workflow runs. No duplicated
// copy to drift, and nothing added to the script's runtime.

import { readFile } from 'node:fs/promises'

const BEGIN = '// PURE:BEGIN'
const END = '// PURE:END'

// Names are exported by appending an export statement, because the pure region
// deliberately contains no export syntax of its own — it has to stay valid
// inside the workflow script, where `export` is only legal for `meta`.
export async function loadPure(scriptPath, names) {
  const source = await readFile(scriptPath, 'utf8')

  const begin = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (begin === -1 || end === -1) {
    throw new Error(`${scriptPath}: missing ${begin === -1 ? BEGIN : END} marker`)
  }
  if (end < begin) {
    throw new Error(`${scriptPath}: ${END} appears before ${BEGIN}`)
  }

  const region = source.slice(begin + BEGIN.length, end)

  // Guard the contract rather than trusting it: a harness global that sneaks
  // into this region would throw a confusing ReferenceError at import time, so
  // name the actual problem instead.
  //
  // Comments and string literals are stripped first. Without that the guard
  // flags the very comment above PURE:BEGIN that lists these names, and any
  // error message that happens to mention one — a check that cannot survive
  // being described is not a useful check.
  const code = region
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/([^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'])*'/g, "''")
    .replace(/"(?:\\.|[^\\"])*"/g, '""')

  // Only a CALL or a bare read counts; `.log`, `foo.args` and `{ log: x }` are
  // ordinary property names and must not trip this.
  const forbidden = ['args', 'agent', 'log', 'phase', 'pipeline', 'workflow']
    .filter(name => new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm').test(code))
  if (forbidden.length > 0) {
    throw new Error(
      `${scriptPath}: the PURE region calls harness global(s) ${forbidden.join(', ')}. `
      + 'Everything between the markers must be a pure function of its arguments.')
  }

  const module = `${region}\nexport { ${names.join(', ')} }\n`
  return import(`data:text/javascript;base64,${Buffer.from(module).toString('base64')}`)
}
