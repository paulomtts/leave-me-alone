// Tests for the shared `gh` plumbing. These helpers are pure string logic, so
// they are called directly — nothing to inject, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncate } from './gh.mjs'

// ── truncate ─────────────────────────────────────────────────────────────────

test('text shorter than the limit comes back untouched', () => {
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(truncate('', 10), '')
})

test('text exactly at the limit comes back untouched', () => {
  // "at most max" is <=, not <: no ellipsis at the boundary.
  assert.equal(truncate('abcde', 5), 'abcde')
})

test('null becomes an empty string, not "null"', () => {
  assert.equal(truncate(null, 5), '')
})

test('undefined becomes an empty string, not "undefined"', () => {
  assert.equal(truncate(undefined, 5), '')
  assert.equal(truncate(), '')
})

test('newlines and whitespace are preserved, not collapsed', () => {
  // Unlike lastLine/ghError, truncate does no trimming or line splitting.
  const text = '  first\n\nsecond  '
  assert.equal(truncate(text, 100), text)
})
