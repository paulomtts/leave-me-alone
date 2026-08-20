#!/usr/bin/env node
// Deterministic replacement for the orchestrator's board-id lookup.
//
// GitHub's mutation API will not accept the friendly project number you see in
// the URL — it needs opaque node ids. This runs the two queries that translate
// one into the other and prints what they returned, VERBATIM.
//
//   bun scripts/resolve.mjs --owner you --number 13 --compact
//
// It deliberately does NOT decide which field or which options are the right
// ones. That matching is exact string equality against names the caller
// declares, it lives in the orchestrator's tested resolveBoardIds(), and there
// is no reason for two copies of it to exist.

import { ghRunner, ghError, jsonFrom, readFlags } from './gh.mjs'

const FIELDS = 'id title fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}'

export function parseArgs(argv) {
  const flags = readFlags(argv, { '--owner': 'value', '--number': 'value', '--compact': 'boolean' })
  const out = {
    owner: flags['--owner'],
    number: Number(flags['--number']),
    compact: flags['--compact'] === true,
  }
  if (typeof out.owner !== 'string' || out.owner.length === 0 || /\s/.test(out.owner)) {
    throw new Error('resolve needs --owner <login>')
  }
  if (!Number.isInteger(out.number) || out.number <= 0) {
    throw new Error('resolve needs --number <the small integer from the project URL>')
  }
  return out
}

export function query(scope) {
  return `query($o:String!,$n:Int!){${scope}(login:$o){projectV2(number:$n){${FIELDS}}}}`
}

// A project belongs to either a user or an organisation, and asking the wrong
// one returns null rather than an error — so the fallback is a genuine
// sequence, not a guess.
export async function resolveProject({ owner, number, run = ghRunner }) {
  const attempts = []
  for (const scope of ['user', 'organization']) {
    let payload
    try {
      payload = jsonFrom(await run(['api', 'graphql', '-f', `query=${query(scope)}`, '-f', `o=${owner}`, '-F', `n=${number}`]))
    } catch (err) {
      attempts.push(`${scope}: ${ghError(err)}`)
      continue
    }
    const project = payload?.data?.[scope]?.projectV2
    if (project && project.id) {
      return {
        found: true,
        scope,
        id: project.id,
        title: project.title ?? '',
        // Every single-select field, names exactly as GitHub returned them.
        fields: (project.fields?.nodes ?? [])
          .filter(node => node && node.id && typeof node.name === 'string')
          .map(node => ({
            id: node.id,
            name: node.name,
            options: (node.options ?? []).map(option => ({ id: option.id, name: option.name })),
          })),
      }
    }
    attempts.push(`${scope}: no project ${number} for "${owner}"`)
  }
  return { found: false, missing: attempts.join('; '), fields: [] }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const result = await resolveProject(options)
  process.stdout.write(`${options.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`)
  if (!result.found) process.exitCode = 1
}
