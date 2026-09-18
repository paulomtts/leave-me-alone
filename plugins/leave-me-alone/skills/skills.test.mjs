import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = name => readFileSync(fileURLToPath(new URL(`./${name}/SKILL.md`, import.meta.url)), 'utf8')

// These guard against a retired mechanic reappearing. They cannot check that
// the prose is good — nothing can — but a stale instruction telling an operator
// to configure something that no longer exists is the realistic failure, and it
// is exactly what this catches.

test('setup-project no longer instructs the deleted board block', () => {
  const source = read('setup-project')
  assert.doesNotMatch(source, /optionIds|fieldId|statusField/,
    'the project id block was deleted in phase 2 and is now silently ignored')
  assert.doesNotMatch(source, /gh project (create|item-add|item-edit)/)
  assert.doesNotMatch(source, /sub_issues|addSubIssue/)
  assert.doesNotMatch(source, /read:project|-s project/)
})

test('setup-project documents brd init, the precondition everything depends on', () => {
  assert.match(read('setup-project'), /brd init/)
})

test('setup-milestone no longer instructs the retired conventions', () => {
  const source = read('setup-milestone')
  assert.doesNotMatch(source, /sub_issues|addSubIssue|database id/i)
  assert.doesNotMatch(source, /label.*\bsubtask\b|--label/)
  assert.doesNotMatch(source, /project: \{ number/)
})

test('the skills describe the status model that actually ships', () => {
  for (const name of ['setup-project', 'setup-milestone']) {
    const source = read(name)
    // Phase 2 retired in_review: ship writes `done`, because a run never
    // merges and "the PR is open" is the furthest state it can honestly
    // report. Case-insensitive — the previous guard was satisfied by
    // lowercasing while the claim stayed false.
    assert.doesNotMatch(source, /in[ _]review/i, `${name} still promises in_review`)
    assert.match(source, /\bdone\b/, `${name} must say cards reach done`)
  }
})

test('setup-milestone owns the two rules nothing in code enforces at creation', () => {
  const source = read('setup-milestone')
  assert.match(source, /at most ONE blocker|one blocker per story/i)
  assert.match(source, /--blocked-by/)
  assert.match(source, /short id/i, 'short-id uniqueness within a milestone')
})

test('setup-milestone keeps the judgment that is the actual product', () => {
  const source = read('setup-milestone')
  // Cheap canaries for the sections a mechanical rewrite would strip.
  assert.match(source, /one subtask = one green PR/i)
  assert.match(source, /file-disjoint/i)
  assert.match(source, /Subtasks that ship no behavior/i)
})
