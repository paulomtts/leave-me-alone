// A card's status, rolled up its ancestry.
//
// This rule used to live as English prose inside a prompt, with the GraphQL
// mutations to carry it out interpolated into the same string — the last place
// in the pipeline where a model was handed a shell and asked to follow
// instructions exactly. brd's ids are short enough that it can be code.

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
