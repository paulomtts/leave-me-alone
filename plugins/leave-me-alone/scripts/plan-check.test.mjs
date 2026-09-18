import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, matchesCard, pickPlan, planCheck, VALIDATED_MARKER } from './plan-check.mjs'

test('parseArgs takes an 8-character hex card id', () => {
  assert.equal(parseArgs(['--repo-dir', '/abs/repo', '--card', 'a32af745']).card, 'a32af745')
  assert.equal(parseArgs(['--repo-dir', '/abs/repo', '--card', 'a32af745']).plansDir, '/abs/repo/.claude/plans')
  assert.equal(parseArgs(['--repo-dir', '/abs/repo', '--card', 'a32af745', '--plans-dir', '/p']).plansDir, '/p')
  assert.throws(() => parseArgs(['--card', 'a32af745']), /--repo-dir/)
  assert.throws(() => parseArgs(['--repo-dir', 'rel', '--card', 'a32af745']), /--repo-dir/)
  assert.throws(() => parseArgs(['--repo-dir', '/abs/repo', '--card', '42']), /--card/)
  assert.throws(() => parseArgs(['--repo-dir', '/abs/repo']), /--card/)
})

test('a plan matches when the short id is its final segment', () => {
  assert.equal(matchesCard('task-write-rows-a32af745.md', 'a32af745'), true)
  assert.equal(matchesCard('task-a32af745.md', 'a32af745'), true)
})

test('one card\'s plan never answers for another', () => {
  // The hazard the old non-digit boundary could not express: hex ids may be
  // preceded by hex characters.
  assert.equal(matchesCard('task-deadbeefa32af745.md', 'a32af745'), false)
  assert.equal(matchesCard('task-rows-a32af746.md', 'a32af745'), false)
  assert.equal(matchesCard('task-rows-a32af745-old.md', 'a32af745'), false)
})

test('only .md files match', () => {
  assert.equal(matchesCard('task-rows-a32af745.txt', 'a32af745'), false)
})

test('the newest matching plan wins', () => {
  // A re-planned subtask leaves the old file behind; the stale one must not
  // decide whether Spec/Plan/Validate re-run.
  assert.equal(
    pickPlan(['2026-01-task-rows-a32af745.md', '2026-08-task-rows-a32af745.md', 'task-other-deadbeef.md'], 'a32af745'),
    '2026-08-task-rows-a32af745.md',
  )
  assert.equal(pickPlan(['task-other-deadbeef.md'], 'a32af745'), null)
  assert.equal(pickPlan(null, 'a32af745'), null)
})

const fakeFs = (files) => ({
  list: async (dir) => { if (!(dir in files)) throw new Error('ENOENT'); return Object.keys(files[dir]) },
  read: async (path) => {
    const [dir, name] = [path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1)]
    const v = files[dir]?.[name]
    if (v === undefined) throw new Error('ENOENT')
    if (v instanceof Error) throw v
    return v
  },
})

test('a missing plans directory is a normal answer, not a failure', async () => {
  const got = await planCheck({ plansDir: '/p', card: 'a32af745', ...fakeFs({}) })
  assert.deepEqual(got, { found: false, path: '', validated: false })
})

test('validated only when the marker is literally present', async () => {
  const fs = fakeFs({ '/p': {
    'task-rows-a32af745.md': `# plan\n${VALIDATED_MARKER}\nsteps`,
    'task-rows-deadbeef.md': '# plan\nno marker',
  } })
  assert.equal((await planCheck({ plansDir: '/p', card: 'a32af745', ...fs })).validated, true)
  assert.equal((await planCheck({ plansDir: '/p', card: 'deadbeef', ...fs })).validated, false)
})

test('a plan that merely DISCUSSES the marker still counts — literal, not clever', async () => {
  // Documented deliberately: the check is a substring test. A plan quoting the
  // marker in prose reads as validated. That is the accepted cost of never
  // mistaking a real marker for prose, which is the failure that matters.
  const fs = fakeFs({ '/p': { 'task-rows-a32af745.md': `explains that ${VALIDATED_MARKER} means signed off` } })
  assert.equal((await planCheck({ plansDir: '/p', card: 'a32af745', ...fs })).validated, true)
})

test('an unreadable plan is found but not validated, and says why', async () => {
  const fs = fakeFs({ '/p': { 'task-rows-a32af745.md': new Error('EACCES') } })
  const got = await planCheck({ plansDir: '/p', card: 'a32af745', ...fs })
  assert.equal(got.found, true)
  assert.equal(got.validated, false)
  assert.match(got.error, /EACCES/)
})
