import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storedStatus, rollupStatus } from './rollup.mjs'

const kid = status => ({ status })

test('blocked reads as todo, everything else passes through', () => {
  assert.equal(storedStatus('blocked'), 'todo')
  assert.equal(storedStatus('todo'), 'todo')
  assert.equal(storedStatus('in_progress'), 'in_progress')
  assert.equal(storedStatus('done'), 'done')
})

test('a card with no children rolls up nothing', () => {
  assert.equal(rollupStatus([]), null)
  assert.equal(rollupStatus(undefined), null)
})

test('every child todo means todo', () => {
  assert.equal(rollupStatus([kid('todo'), kid('todo')]), 'todo')
})

test('every child done means done', () => {
  assert.equal(rollupStatus([kid('done'), kid('done')]), 'done')
  assert.equal(rollupStatus([kid('done')]), 'done')
})

test('any mix means in_progress — by progress, not by the least-advanced sibling', () => {
  assert.equal(rollupStatus([kid('todo'), kid('done')]), 'in_progress')
  assert.equal(rollupStatus([kid('todo'), kid('in_progress')]), 'in_progress')
  // The one that makes "by progress" concrete: a done sibling does not win.
  assert.equal(rollupStatus([kid('done'), kid('in_progress')]), 'in_progress')
})

test('a blocked child counts as todo, not as a fourth state', () => {
  assert.equal(rollupStatus([kid('blocked'), kid('todo')]), 'todo')
  assert.equal(rollupStatus([kid('blocked')]), 'todo')
  assert.equal(rollupStatus([kid('blocked'), kid('done')]), 'in_progress')
})
