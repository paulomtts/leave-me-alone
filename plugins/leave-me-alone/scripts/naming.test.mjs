// plugins/leave-me-alone/scripts/naming.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortId, slugify, taskStem, taskBranch, refMatchesCard } from './naming.mjs'

const CARD = { id: 'a32af745-15ef-45cd-b52c-64c19ae82c17', title: '40.1 feat: write rows' }

test('shortId is the first 8 hex characters, dashes ignored, lowercased', () => {
  assert.equal(shortId(CARD.id), 'a32af745')
  assert.equal(shortId('A32AF745-15EF-45CD-B52C-64C19AE82C17'), 'a32af745')
})

test('shortId rejects anything that is not a card id rather than returning junk', () => {
  assert.throws(() => shortId(''), /not a card id/)
  assert.throws(() => shortId(undefined), /not a card id/)
  assert.throws(() => shortId('nope'), /not a card id/)
})

test('slugify lowercases, collapses punctuation to single dashes, and trims them', () => {
  assert.equal(slugify('40.1 feat: write rows'), '40-1-feat-write-rows')
  assert.equal(slugify('  Hello,   World!  '), 'hello-world')
})

test('slugify truncates without leaving a trailing dash', () => {
  assert.equal(slugify('abcdefghij klmnopqrst uvwxyz', 24), 'abcdefghij-klmnopqrst')
})

test('taskStem is slug then short id, so the id is a stable suffix', () => {
  assert.equal(taskStem(CARD), '40-1-feat-write-rows-a32af745')
})

test('a card whose title slugifies to nothing still gets a usable stem', () => {
  assert.equal(taskStem({ id: CARD.id, title: '???' }), 'a32af745')
})

test('taskBranch prefixes the stem', () => {
  assert.equal(taskBranch('m12', CARD), 'm12/task-40-1-feat-write-rows-a32af745')
})

test('matching keys on the short id, so an edited title still finds its PR', () => {
  const branch = taskBranch('m12', CARD)
  const renamed = { ...CARD, title: 'completely different title' }
  assert.equal(refMatchesCard(branch, renamed.id), true)
})

test('matching does not confuse two different cards', () => {
  assert.equal(refMatchesCard('m12/task-quoting-03a6dc10', CARD.id), false)
})
