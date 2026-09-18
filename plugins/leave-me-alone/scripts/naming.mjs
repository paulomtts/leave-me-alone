// A card's identity in every derived name: branches, plan files, spec files.
//
// The two halves are not equal. The short id is load-bearing and the slug is
// decoration: a card's title can be edited after its PR is open, and if
// matching keyed on the slug that edit would orphan the PR — the run would
// report finished work as not done. So everything that MATCHES uses the id, and
// the slug exists only so `git branch` and PR lists are readable.
//
// Eight hex characters matches the Plan-Hash convention already used in this
// repo, and collides with probability that does not matter inside one milestone.

export function shortId(cardId) {
  const hex = String(cardId ?? '').replace(/-/g, '')
  if (!/^[0-9a-f]{8,}$/i.test(hex)) throw new Error(`not a card id: ${JSON.stringify(cardId)}`)
  return hex.slice(0, 8).toLowerCase()
}

export function slugify(title, max = 24) {
  const flat = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (flat.length <= max) return flat
  // Cut at a word boundary rather than mid-word: a trailing "-uv" fragment
  // makes a branch name harder to read, not easier.
  const cut = flat.slice(0, max)
  const lastDash = cut.lastIndexOf('-')
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '')
}

export function taskStem(card) {
  const slug = slugify(card && card.title)
  const id = shortId(card && card.id)
  return slug ? `${slug}-${id}` : id
}

export function taskBranch(branchPrefix, card) {
  return `${branchPrefix}/task-${taskStem(card)}`
}

export function refMatchesCard(ref, cardId) {
  return String(ref ?? '').includes(shortId(cardId))
}
