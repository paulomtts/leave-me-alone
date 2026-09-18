// A card's status, rolled up its ancestry.
//
// This rule used to live as English prose inside a prompt, with the GraphQL
// mutations to carry it out interpolated into the same string — the last place
// in the pipeline where a model was handed a shell and asked to follow
// instructions exactly. brd's ids are short enough that it can be code.

import { brd, brdRunner } from './brd.mjs'
import { readFlags } from './gh.mjs'

// brd derives `blocked` at read time and refuses to store it. The orchestrator
// decides readiness from its own DAG walk, so `blocked` is flattened here the
// same way census.mjs flattens it: one place, not a check at every comparison.
export function storedStatus(status) {
  return status === 'blocked' ? 'todo' : status
}

// By PROGRESS, not by the least-advanced sibling: one done child among
// unstarted ones means the parent is under way, not unstarted.
export function rollupStatus(children) {
  const statuses = (children ?? []).map(child => storedStatus(child && child.status))
  if (statuses.length === 0) return null
  if (statuses.every(status => status === 'todo')) return 'todo'
  if (statuses.every(status => status === 'done')) return 'done'
  return 'in_progress'
}

export function parseArgs(argv) {
  const flags = readFlags(argv, {
    '--card': 'value', '--status': 'value', '--repo-dir': 'value', '--compact': 'boolean',
  })
  const out = {
    card: String(flags['--card'] ?? '').trim(),
    status: String(flags['--status'] ?? '').trim(),
    cwd: flags['--repo-dir'],
    compact: flags['--compact'] === true,
  }
  if (out.card.length === 0) throw new Error('rollup needs --card <card id>')
  if (out.status.length === 0) throw new Error('rollup needs --status <todo|in_progress|done>')
  // brd rejects this too, but failing here names the caller's mistake rather
  // than surfacing it as a CLI error three frames away.
  if (out.status === 'blocked') {
    throw new Error('rollup: "blocked" is derived from the dependency graph and is never stored')
  }
  if (typeof out.cwd !== 'string' || !out.cwd.startsWith('/')) {
    throw new Error('rollup needs --repo-dir <absolute path>')
  }
  return out
}

// Set a card's status, then walk upward recomputing each ancestor.
//
// Read-then-write per level rather than writing blind: sibling stories run in
// parallel lanes, so this process's view of a shared ancestor can be stale by
// the time it gets here. A parent that does not change ends the walk — if the
// parent's status is unchanged, nothing above it can have changed either.
export async function rollup({ card, status, cwd, run = brdRunner }) {
  const written = []
  await brd(['update', card, '--status', status], { cwd, run })
  written.push({ card, status })

  let child = card
  for (;;) {
    const detail = await brd(['show', child], { cwd, run })
    const parent = detail && detail.parent_id
    if (!parent) return written

    const tree = await brd(['tree', parent], { cwd, run })
    const node = Array.isArray(tree) ? tree[0] : tree
    const target = rollupStatus(node && node.children)
    if (target === null || storedStatus(node.status) === target) return written

    await brd(['update', parent, '--status', target], { cwd, run })
    written.push({ card: parent, status: target })
    child = parent
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2))
  const written = await rollup(options)
  process.stdout.write(`${options.compact ? JSON.stringify(written) : JSON.stringify(written, null, 2)}\n`)
}
