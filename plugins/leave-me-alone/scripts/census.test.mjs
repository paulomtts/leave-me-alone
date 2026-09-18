import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderSiblings } from './census.mjs'

const card = (id, created_at, blocked_by = []) => ({
  id: `${id}0000000-0000-4000-8000-000000000000`.slice(0, 36),
  title: id, status: 'todo', blocked_by: blocked_by.map(b => `${b}0000000-0000-4000-8000-000000000000`.slice(0, 36)),
  created_at, children: [],
})
const titles = cards => cards.map(c => c.title)

test('a chain runs in dependency order, not creation order', () => {
  // b was created first but is blocked by a: a must come first.
  const b = card('b', '2026-01-01T00:00:00Z', ['a'])
  const a = card('a', '2026-01-02T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([b, a])), ['a', 'b'])
})

test('independent siblings keep creation order', () => {
  const a = card('a', '2026-01-02T00:00:00Z')
  const b = card('b', '2026-01-01T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([a, b])), ['b', 'a'])
})

test('a three-card chain resolves fully', () => {
  const c = card('c', '2026-01-01T00:00:00Z', ['b'])
  const b = card('b', '2026-01-02T00:00:00Z', ['a'])
  const a = card('a', '2026-01-03T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([c, b, a])), ['a', 'b', 'c'])
})

test('an edge pointing outside the sibling set does not order siblings', () => {
  // Blocked by a card in another story: irrelevant to ordering HERE.
  const a = card('a', '2026-01-01T00:00:00Z', ['z'])
  const b = card('b', '2026-01-02T00:00:00Z')
  assert.deepEqual(titles(orderSiblings([a, b])), ['a', 'b'])
})

test('an empty list is an empty list, not a throw', () => {
  assert.deepEqual(orderSiblings([]), [])
  assert.deepEqual(orderSiblings(undefined), [])
})

test('cards are never silently dropped', () => {
  // Defensive: a cycle cannot be persisted by brd, but truncating the list
  // would silently remove subtasks from a milestone.
  const a = card('a', '2026-01-01T00:00:00Z', ['b'])
  const b = card('b', '2026-01-02T00:00:00Z', ['a'])
  assert.throws(() => orderSiblings([a, b]), /could not be ordered/)
})
