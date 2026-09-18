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
  // The one that makes "by progress" concrete: a done sibling does not win.
  assert.equal(rollupStatus([kid('todo'), kid('done')]), 'in_progress')
  assert.equal(rollupStatus([kid('todo'), kid('in_progress')]), 'in_progress')
  assert.equal(rollupStatus([kid('done'), kid('in_progress')]), 'in_progress')
})

test('a blocked child counts as todo, not as a fourth state', () => {
  assert.equal(rollupStatus([kid('blocked'), kid('todo')]), 'todo')
  assert.equal(rollupStatus([kid('blocked')]), 'todo')
  assert.equal(rollupStatus([kid('blocked'), kid('done')]), 'in_progress')
})

import { parseArgs, rollup } from './rollup.mjs'

const SUB = 'aaaaaaaa-0000-4000-8000-000000000000'
const STORY = 'bbbbbbbb-0000-4000-8000-000000000000'
const MILE = 'cccccccc-0000-4000-8000-000000000000'

// A fake brd: routes on a distinctive fragment of the argv it is handed.
const fakeBrd = (routes, log = []) => {
  const run = async (args) => {
    log.push(args.join(' '))
    for (const [needle, reply] of routes) {
      if (args.join(' ').includes(needle)) {
        return JSON.stringify({ ok: true, data: typeof reply === 'function' ? reply() : reply })
      }
    }
    throw new Error(`unrouted brd call: ${args.join(' ')}`)
  }
  run.log = log
  return run
}

test('parseArgs requires a card and a status', () => {
  const ok = parseArgs(['--card', SUB, '--status', 'done', '--repo-dir', '/abs/repo'])
  assert.equal(ok.card, SUB)
  assert.equal(ok.status, 'done')
  assert.throws(() => parseArgs(['--status', 'done']), /needs --card/)
  assert.throws(() => parseArgs(['--card', SUB]), /needs --status/)
})

test('refuses to write blocked — it is derived, never stored', () => {
  assert.throws(() => parseArgs(['--card', SUB, '--status', 'blocked']), /derived/)
})

test('writes the card, then the parent when the rollup changes it', async () => {
  let subStatus = 'todo'
  const run = fakeBrd([
    [`update ${SUB}`, () => { subStatus = 'done'; return { id: SUB } }],
    [`show ${SUB}`, () => ({ id: SUB, parent_id: STORY })],
    [`tree ${STORY}`, () => [{ id: STORY, status: 'in_progress', children: [{ id: SUB, status: subStatus }] }]],
    [`update ${STORY}`, { id: STORY }],
    [`show ${STORY}`, { id: STORY, parent_id: null }],
  ])
  const written = await rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run })
  assert.deepEqual(written, [{ card: SUB, status: 'done' }, { card: STORY, status: 'done' }])
})

test('does not write an unchanged parent, even while continuing the walk', async () => {
  // The story stays in_progress because a sibling is still todo. When we walk
  // to its parent (the milestone), it's already correct, so we read it but don't
  // write it. Crucially, we continue past it instead of stopping — because a
  // stale grandparent might exist upstream.
  const run = fakeBrd([
    [`update ${SUB}`, { id: SUB }],
    [`show ${SUB}`, { id: SUB, parent_id: STORY }],
    [`tree ${STORY}`, [{ id: STORY, status: 'in_progress',
      children: [{ id: SUB, status: 'done' }, { id: 'other', status: 'todo' }] }]],
    [`show ${STORY}`, { id: STORY, parent_id: MILE }],
    [`tree ${MILE}`, [{ id: MILE, status: 'in_progress',
      children: [{ id: STORY, status: 'in_progress' }] }]],
    [`show ${MILE}`, { id: MILE, parent_id: null }],
  ])
  const written = await rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run })
  assert.deepEqual(written, [{ card: SUB, status: 'done' }])
  // Story and milestone are not written because their statuses don't change
  assert.ok(!run.log.some(call => call.startsWith('update ') && call.includes(STORY)), `story was written`)
  assert.ok(!run.log.some(call => call.startsWith('update ') && call.includes(MILE)), `milestone was written`)
  // But we do read the milestone (walk continues)
  assert.ok(run.log.some(call => call.includes(`show ${STORY}`)), `story not read`)
  assert.ok(run.log.some(call => call.includes(`tree ${MILE}`)), `milestone tree not read`)
})

test('a brd failure aborts rather than leaving a half-written ancestry', async () => {
  const run = async () => '{"ok": false, "error": {"type": "CardNotFoundError", "message": "no card"}}'
  await assert.rejects(rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run }), /CardNotFoundError/)
})

test('every brd call is given the repo-dir as cwd', async () => {
  const seen = []
  const run = async (args, opts) => {
    seen.push(opts && opts.cwd)
    return JSON.stringify({ ok: true, data: args[0] === 'show' ? { parent_id: null } : { id: SUB } })
  }
  await rollup({ card: SUB, status: 'in_progress', cwd: '/abs/repo', run })
  assert.ok(seen.length > 0 && seen.every(cwd => cwd === '/abs/repo'), `cwds: ${JSON.stringify(seen)}`)
})

test('self-healing: a stale ancestor is repaired on the next rollup walk', async () => {
  // Scenario: an earlier rollup was interrupted. The story is correctly in_progress
  // (its subtask is done and a sibling is todo), but the milestone is stale at
  // 'todo' when it should be 'in_progress'. This rollup sees the story's status
  // is unchanged (so doesn't write it), but continues upward and discovers the
  // stale milestone, correcting it.
  const run = fakeBrd([
    [`update ${SUB}`, { id: SUB }],
    [`show ${SUB}`, { id: SUB, parent_id: STORY }],
    [`tree ${STORY}`, [{ id: STORY, status: 'in_progress',
      children: [{ id: SUB, status: 'done' }, { id: 'other', status: 'todo' }] }]],
    [`show ${STORY}`, { id: STORY, parent_id: MILE }],
    [`tree ${MILE}`, [{ id: MILE, status: 'todo', // Stale! Should be in_progress
      children: [{ id: STORY, status: 'in_progress' }] }]],
    [`update ${MILE}`, { id: MILE }],
    [`show ${MILE}`, { id: MILE, parent_id: null }],
  ])
  const written = await rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run })
  // Story is unchanged and not written, but milestone is repaired
  assert.deepEqual(written, [{ card: SUB, status: 'done' }, { card: MILE, status: 'in_progress' }])
})

test('depth guard: a corrupted parent chain throws rather than hanging', { timeout: 1000 }, async () => {
  const run = fakeBrd([
    [`update ${SUB}`, { id: SUB }],
    [`show ${SUB}`, { id: SUB, parent_id: STORY }],
    [`tree ${STORY}`, [{ id: STORY, status: 'in_progress', children: [{ id: SUB, status: 'done' }] }]],
    [`update ${STORY}`, { id: STORY }],
    [`tree`, [{ id: 'parent', status: 'in_progress', children: [] }]], // All non-specific trees
    [`show`, { id: 'x', parent_id: 'y' }], // All non-specific shows: infinite parent chain
  ])
  await assert.rejects(
    rollup({ card: SUB, status: 'done', cwd: '/abs/repo', run }),
    /exceeded maximum ancestry depth/
  )
})
