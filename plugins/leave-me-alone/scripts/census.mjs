// Reshaping `brd tree` into the flat census the orchestrator's graph code
// already expects. Pure functions only: no CLI, no I/O.

// Execution order for one card's children.
//
// Order used to be parsed out of an ordinal prefix in the title. It now comes
// from the blocked_by edges between the siblings themselves, so the board
// states the order rather than encoding it in text. Edges pointing OUTSIDE the
// sibling set are ignored here — a subtask blocked by another story's card is a
// dispatch concern, not a sibling-ordering one. Independent siblings keep
// creation order.
export function orderSiblings(cards) {
  const list = cards ?? []
  if (list.length === 0) return []

  const byId = new Map(list.map(card => [card.id, card]))
  const indegree = new Map(list.map(card => [card.id, 0]))
  const unlocks = new Map(list.map(card => [card.id, []]))

  for (const card of list) {
    for (const blockerId of card.blocked_by ?? []) {
      if (!byId.has(blockerId)) continue
      unlocks.get(blockerId).push(card.id)
      indegree.set(card.id, indegree.get(card.id) + 1)
    }
  }

  const earliestFirst = (a, b) =>
    String(byId.get(a).created_at ?? '').localeCompare(String(byId.get(b).created_at ?? ''))
    || String(a).localeCompare(String(b))

  const ready = list.filter(card => indegree.get(card.id) === 0).map(card => card.id).sort(earliestFirst)
  const ordered = []
  while (ready.length > 0) {
    const id = ready.shift()
    ordered.push(byId.get(id))
    for (const next of unlocks.get(id)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
    ready.sort(earliestFirst)
  }

  if (ordered.length !== list.length) {
    const stuck = list.filter(card => !ordered.includes(card)).map(card => card.id)
    throw new Error(`census: ${stuck.length} card(s) could not be ordered — cyclic blocked_by among siblings: ${stuck.join(', ')}`)
  }
  return ordered
}
