import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brdData, brd, BrdError } from './brd.mjs'

test('brdData returns the data payload of a successful call', () => {
  assert.deepEqual(brdData('{"ok": true, "data": [{"id": "a"}]}'), [{ id: 'a' }])
})

test('an ok:false body throws with the error type, and never returns a value', () => {
  const body = '{"ok": false, "error": {"type": "CardNotFoundError", "message": "no card with id nope"}}'
  assert.throws(() => brdData(body), err => {
    assert.ok(err instanceof BrdError)
    assert.equal(err.type, 'CardNotFoundError')
    assert.match(err.message, /no card with id nope/)
    return true
  })
})

test('a tool-manager banner above the JSON is tolerated', () => {
  assert.deepEqual(brdData('mise tools: brd@0.1.0\n{"ok": true, "data": 1}'), 1)
})

test('brd() passes argv and cwd through to the injected runner', async () => {
  const calls = []
  const run = async (args, opts) => {
    calls.push({ args, opts })
    return '{"ok": true, "data": {"title": "Milestone"}}'
  }
  const data = await brd(['tree'], { cwd: '/abs/repo', run })
  assert.deepEqual(data, { title: 'Milestone' })
  assert.deepEqual(calls, [{ args: ['tree'], opts: { cwd: '/abs/repo' } }])
})
