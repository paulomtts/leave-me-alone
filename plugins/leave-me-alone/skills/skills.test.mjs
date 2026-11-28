import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = name => readFileSync(fileURLToPath(new URL(`./${name}/SKILL.md`, import.meta.url)), 'utf8')

// These guard against a retired mechanic reappearing. They cannot check that
// the prose is good — nothing can — but a stale instruction telling an operator
// to configure something that no longer exists is the realistic failure, and it
// is exactly what this catches.

test('setup-milestone no longer instructs the retired conventions', () => {
  const source = read('setup-milestone')
  assert.doesNotMatch(source, /sub_issues|addSubIssue|database id/i)
  assert.doesNotMatch(source, /label.*\bsubtask\b|--label/)
  assert.doesNotMatch(source, /project: \{ number/)
})

test('setup-milestone describes the status model that actually ships', () => {
  const source = read('setup-milestone')
  assert.doesNotMatch(source, /in[ _]review/i, 'still promises in_review')
  assert.match(source, /card(?:'s)? reach(?:es|ing)? `?done`?/i,
    'must tie a card to reaching done, not just contain the bare word')
  assert.doesNotMatch(source, /reaches `?done`? when Ship opens its PR/i)
  assert.match(source, /verified and committed|local branch/i, 'does not describe local-only completion')
})

test('setup-milestone drives am, not the removed workflows', () => {
  const source = read('setup-milestone')
  assert.match(source, /am run --milestone .*--dry-run/)
  assert.doesNotMatch(source, /orchestrator|setup-project|task\.js|detect\.mjs/i)
})

const root = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8')

test('the root README tells an operator to run brd init', () => {
  assert.match(root, /brd init/)
})

test('the root README no longer describes a board or a migration in flight', () => {
  assert.doesNotMatch(root, /Projects v2|read:project/)
  assert.doesNotMatch(root, /Phase 2|not yet migrated/i)
})

test('setup-milestone owns the two rules nothing in code enforces at creation', () => {
  const source = read('setup-milestone')
  assert.match(source, /merged base/i, 'what a second blocker costs')
  assert.match(source, /--blocked-by/)
  assert.match(source, /short id/i, 'short-id uniqueness within a milestone')
})

test('setup-milestone keeps the judgment that is the actual product', () => {
  const source = read('setup-milestone')
  // Cheap canaries for the sections a mechanical rewrite would strip.
  assert.match(source, /one subtask = one green (?:PR|local branch)/i)
  assert.match(source, /parallel lanes/i)
  assert.match(source, /conflict surfaces at Integrate/i)
  assert.match(source, /does not exist without A/i, 'per-edge blocked_by test')
  assert.match(source, /NOT for:/)
  assert.doesNotMatch(source, /file-disjoint/i)
  assert.match(source, /Subtasks that ship no behavior/i)
})
