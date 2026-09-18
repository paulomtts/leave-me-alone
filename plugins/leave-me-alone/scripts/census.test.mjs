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

import { findMilestone, flattenMilestone } from './census.mjs'

const ID = n => `${n}0000000-0000-4000-8000-000000000000`.slice(0, 36)
const node = (n, title, extra = {}) => ({
  id: ID(n), title, status: 'todo', blocked_by: [], created_at: `2026-01-0${n}T00:00:00Z`,
  children: [], ...extra,
})

const TREE = node(1, 'Milestone 12: CSV export', {
  children: [
    node(2, 'Story: CSV writer', {
      children: [node(4, 'feat: write rows'), node(5, 'feat: quoting', { blocked_by: [ID(4)] })],
    }),
    node(3, 'Story: Document it', { blocked_by: [ID(2)], status: 'blocked',
      children: [node(6, 'docs: usage', { status: 'blocked' })] }),
  ],
})

test('findMilestone matches a root card by exact id', () => {
  assert.equal(findMilestone([TREE], ID(1)).title, 'Milestone 12: CSV export')
})

test('findMilestone matches by case-insensitive title substring', () => {
  assert.equal(findMilestone([TREE], 'csv export').id, ID(1))
})

test('findMilestone fails loudly when nothing matches', () => {
  assert.throws(() => findMilestone([TREE], 'nonexistent'), /no milestone card/)
})

test('findMilestone fails loudly on ambiguity rather than guessing', () => {
  const other = node(9, 'Milestone 13: CSV import')
  assert.throws(() => findMilestone([TREE, other], 'csv'), /ambiguous/)
})

test('flattenMilestone produces stories with ordered subtasks', () => {
  const census = flattenMilestone(TREE)
  assert.equal(census.milestoneTitle, 'Milestone 12: CSV export')
  assert.deepEqual(census.stories.map(s => s.title), ['Story: CSV writer', 'Story: Document it'])
  assert.deepEqual(census.stories[0].subtasks.map(s => s.title), ['feat: write rows', 'feat: quoting'])
})

test('story blockedBy carries card ids through', () => {
  assert.deepEqual(flattenMilestone(TREE).stories[1].blockedBy, [ID(2)])
})

test('a derived "blocked" status is read as "todo"', () => {
  // brd projects blocked at read time; readiness is the orchestrator's DAG walk,
  // so blocked must not survive into the census as a distinct state.
  const census = flattenMilestone(TREE)
  assert.equal(census.stories[1].status, 'todo')
  assert.equal(census.stories[1].subtasks[0].status, 'todo')
})

test('in_progress and done are passed through untouched', () => {
  const tree = node(1, 'M', { children: [node(2, 'S', { status: 'done',
    children: [node(3, 'T', { status: 'in_progress' })] })] })
  const story = flattenMilestone(tree).stories[0]
  assert.equal(story.status, 'done')
  assert.equal(story.subtasks[0].status, 'in_progress')
})
