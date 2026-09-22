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
    // Known blind spot: this is a substring/adjacency match with no negation
    // awareness. A sentence that deliberately DENIES the claim — e.g. "a card
    // never reaches `done` on its own" — still contains the matched phrase and
    // would pass this assertion while being false. Not reachable by an
    // accidental regression, but worth recording rather than papering over
    // with a "cleverer" regex — this guard's history is three attempts, each
    // defeated in a new way.
    assert.match(source, /card(?:'s)? reach(?:es|ing)? `?done`?/i,
      `${name} must tie a card to reaching done, not just contain the bare word`)
  }
})

test('the skills no longer promise PR-based done and describe local-only completion', () => {
  // Task 8: moved DRIVE from PR-based completion to local-only ("verified and
  // committed to the local branch — nothing is pushed"). The Integrate phase
  // merges stories into one local branch; a human merges that into
  // main/master themselves.
  //
  // Each file's REAL retired phrasing was different, so one shared regex
  // checked against both files means at least one never actually got tested
  // against its own old text — setup-milestone said "reaches `done` when Ship
  // opens its PR"; setup-project said "reaching `done` reflects only that
  // Ship opened its PR" (verified against the pre-migration text at
  // `git show 7a77054:...SKILL.md`). A per-file table keeps each assertion
  // honest about what that specific file used to say.
  const oldPhrasings = [
    { name: 'setup-milestone', oldPhraseRegex: /reaches `?done`? when Ship opens its PR/i },
    { name: 'setup-project', oldPhraseRegex: /reaching `?done`? reflects only that Ship opened its PR/i },
  ]
  for (const { name, oldPhraseRegex } of oldPhrasings) {
    const source = read(name)
    assert.doesNotMatch(source, oldPhraseRegex, `${name} still promises PR-based done`)
    assert.match(source, /verified and committed|local branch/i, `${name} does not describe local-only completion`)
  }
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
  assert.match(source, /at most ONE blocker|one blocker per story/i)
  assert.match(source, /--blocked-by/)
  assert.match(source, /short id/i, 'short-id uniqueness within a milestone')
})

test('setup-milestone keeps the judgment that is the actual product', () => {
  const source = read('setup-milestone')
  // Cheap canaries for the sections a mechanical rewrite would strip.
  assert.match(source, /one subtask = one green (?:PR|local branch)/i)
  assert.match(source, /file-disjoint/i)
  assert.match(source, /Subtasks that ship no behavior/i)
})

test('setup-report reads the live board and records a snapshot', () => {
  const source = read('setup-report')
  assert.match(source, /brd tree/)
  assert.match(source, /docs\/board\//)
  assert.doesNotMatch(source, /Projects v2|board Status|sub-issue/i)
})

test('setup-report still gets PR and CI state from gh', () => {
  // The hybrid is the point — this would be wrong to "finish" migrating.
  assert.match(read('setup-report'), /gh pr checks/)
})
