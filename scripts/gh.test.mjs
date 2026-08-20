// Tests for the shared `gh` plumbing. These helpers are pure string logic, so
// they are called directly — nothing to inject, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstLine, truncate } from './gh.mjs'

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

test('text one character over the limit is cut and marked', () => {
  const got = truncate('abcdef', 5)
  assert.equal(got, 'abcde…')
  assert.ok(got.startsWith('abcde'))
  assert.ok(got.endsWith('…'))
})

test('the ellipsis is one character, not three dots', () => {
  const got = truncate('abcdefghij', 4)
  assert.equal(got, 'abcd…')
  assert.equal(got.length, 5) // max + 1, so U+2026 rather than "..."
  assert.equal(got.slice(-1), '…')
})

test('a non-string is coerced with String(...)', () => {
  assert.equal(truncate(12345, 10), '12345')
  assert.equal(truncate(12345, 3), '123…')
})

// ── firstLine ────────────────────────────────────────────────────────────────

test('the first line of multi-line text is returned', () => {
  // The mirror of lastLine: same splitting, opposite end.
  assert.equal(firstLine('first\nsecond\nthird'), 'first')
})

test('the returned first line is trimmed', () => {
  assert.equal(firstLine('  hello  \nworld'), 'hello')
  assert.equal(firstLine('\thello\t\nworld'), 'hello')
})

test('single-line text is returned whole, trimmed', () => {
  // No trailing-newline artifact, and no empty-string from the trailing split.
  assert.equal(firstLine('only\n'), 'only')
  assert.equal(firstLine('only'), 'only')
})

test('firstLine coerces a non-string with String(...)', () => {
  assert.equal(firstLine(12345), '12345')
  assert.equal(firstLine(0), '0')
})

test('firstLine turns null and undefined into an empty string', () => {
  assert.equal(firstLine(null), '')
  assert.equal(firstLine(undefined), '')
  assert.equal(firstLine(), '')
})
