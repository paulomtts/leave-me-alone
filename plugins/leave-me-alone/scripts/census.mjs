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

// brd derives `blocked` at read time from the dependency graph. The orchestrator
// decides readiness with its own DAG walk, and the two can legitimately disagree
// — brd counts a blocker satisfied only at stored status `done`, while a story's
// completeness also involves its subtasks and PR state. So the projection is
// flattened away HERE, in one place, rather than checked for everywhere.
function storedStatus(status) {
  return status === 'blocked' ? 'todo' : status
}

// `--milestone` used to be a small integer. A UUID is not typeable, so a title
// substring is accepted too — but never guessed at: two matches is an error.
export function findMilestone(roots, needle) {
  const wanted = String(needle ?? '').trim()
  const list = roots ?? []
  const byId = list.find(root => root.id === wanted)
  if (byId) return byId

  const lowered = wanted.toLowerCase()

  // An exact (case-insensitive) title match wins outright, with no ambiguity
  // check beyond this: it is unambiguous even when the needle also happens to
  // be a substring of some other card's title.
  const exact = list.find(root => String(root.title ?? '').toLowerCase() === lowered)
  if (exact) return exact

  // A numeric needle ("2") must not resolve via a longer digit run it merely
  // sits inside ("Milestone 12") — that is not the milestone the caller typed,
  // and silently resolving it turns a wrong READ into wrong branches, PRs and
  // status writes. So a numeric needle only matches a digit run of its own
  // length; anything longer is excluded from the candidate set entirely.
  const isNumeric = /^[0-9]+$/.test(wanted)
  const matches = list.filter(root => {
    const title = String(root.title ?? '').toLowerCase()
    const idx = title.indexOf(lowered)
    if (idx === -1) return false
    if (!isNumeric) return true
    let start = idx
    let end = idx + lowered.length
    while (start > 0 && /[0-9]/.test(title[start - 1])) start--
    while (end < title.length && /[0-9]/.test(title[end])) end++
    return (end - start) <= lowered.length
  })
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new Error(`no milestone card matching "${wanted}" — root cards are: ${list.map(r => r.title).join(', ') || '(none)'}`)
  }
  throw new Error(`ambiguous milestone "${wanted}" — matches: ${matches.map(m => m.title).join(', ')}`)
}

export function flattenMilestone(root) {
  const stories = orderSiblings(root.children ?? []).map(story => ({
    id: story.id,
    title: story.title,
    status: storedStatus(story.status),
    blockedBy: story.blocked_by ?? [],
    subtasks: orderSiblings(story.children ?? []).map(subtask => ({
      id: subtask.id,
      title: subtask.title,
      status: storedStatus(subtask.status),
    })),
  }))
  return { milestoneTitle: root.title, stories }
}
