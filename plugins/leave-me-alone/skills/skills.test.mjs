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
