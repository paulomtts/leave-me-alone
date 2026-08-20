import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, matchesIssue, pickPlan, planCheck, VALIDATED_MARKER } from './plan-check.mjs'

test('needs an absolute repo dir and a real issue number', () => {
  assert.equal(parseArgs(['--repo-dir=/r', '--issue=23']).issue, 23)
  assert.equal(parseArgs(['--repo-dir=/r', '--issue=23']).plansDir, '/r/.claude/plans')
  assert.equal(parseArgs(['--repo-dir=/r', '--issue=23', '--plans-dir=/p']).plansDir, '/p')
  assert.throws(() => parseArgs(['--issue=23']), /--repo-dir/)
  assert.throws(() => parseArgs(['--repo-dir=rel', '--issue=23']), /--repo-dir/)
  assert.throws(() => parseArgs(['--repo-dir=/r', '--issue=0']), /--issue/)
})

test('a longer number does not answer for a shorter one', () => {
  // Same rule as branch refs: issue-123.md is not issue 23's plan.
  assert.equal(matchesIssue('2026-issue-23.md', 23), true)
  assert.equal(matchesIssue('issue-23.md', 23), true)
  assert.equal(matchesIssue('issue-123.md', 23), false)
  assert.equal(matchesIssue('issue-23.txt', 23), false)
  assert.equal(matchesIssue('issue-23-old.md', 23), false)
})

test('the newest matching plan wins', () => {
  // A re-planned subtask leaves the old file behind; the stale one must not
  // decide whether Spec/Plan/Validate re-run.
  assert.equal(pickPlan(['2026-01-issue-23.md', '2026-08-issue-23.md', 'issue-9.md'], 23), '2026-08-issue-23.md')
  assert.equal(pickPlan(['issue-9.md'], 23), null)
  assert.equal(pickPlan(null, 23), null)
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
  const got = await planCheck({ plansDir: '/p', issue: 23, ...fakeFs({}) })
  assert.deepEqual(got, { found: false, path: '', validated: false })
})

test('validated only when the marker is literally present', async () => {
  const fs = fakeFs({ '/p': {
    'issue-23.md': `# plan\n${VALIDATED_MARKER}\nsteps`,
    'issue-24.md': '# plan\nno marker',
  } })
  assert.equal((await planCheck({ plansDir: '/p', issue: 23, ...fs })).validated, true)
  assert.equal((await planCheck({ plansDir: '/p', issue: 24, ...fs })).validated, false)
})

test('a plan that merely DISCUSSES the marker still counts — literal, not clever', async () => {
  // Documented deliberately: the check is a substring test. A plan quoting the
  // marker in prose reads as validated. That is the accepted cost of never
  // mistaking a real marker for prose, which is the failure that matters.
  const fs = fakeFs({ '/p': { 'issue-23.md': `explains that ${VALIDATED_MARKER} means signed off` } })
  assert.equal((await planCheck({ plansDir: '/p', issue: 23, ...fs })).validated, true)
})

test('an unreadable plan is found but not validated, and says why', async () => {
  const fs = fakeFs({ '/p': { 'issue-23.md': new Error('EACCES') } })
  const got = await planCheck({ plansDir: '/p', issue: 23, ...fs })
  assert.equal(got.found, true)
  assert.equal(got.validated, false)
  assert.match(got.error, /EACCES/)
})
