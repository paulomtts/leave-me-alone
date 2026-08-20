import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, titleFromIssue, buildBody, ship } from './ship.mjs'

const ARGS = ['--repo=o/n', '--issue=23', '--branch=m2/task-23', '--base=main',
              '--worktree=/wt', '--verify=npm test']

test('every required argument is checked at the door', () => {
  assert.equal(parseArgs(ARGS).issue, 23)
  for (const drop of ['--repo=o/n', '--issue=23', '--branch=m2/task-23', '--base=main', '--worktree=/wt']) {
    assert.throws(() => parseArgs(ARGS.filter(a => a !== drop)), /ship needs/, `dropping ${drop}`)
  }
  assert.throws(() => parseArgs([...ARGS, '--wat']), /unknown argument/)
})

test('--verify repeats, and an empty suite is refused outright', () => {
  const got = parseArgs([...ARGS, '--verify=npm run lint'])
  assert.deepEqual(got.verify, ['npm test', 'npm run lint'])
  // The same stop task.js makes upstream, repeated because this script is also
  // usable standalone: zero commands would make every check below vacuous.
  assert.throws(() => parseArgs(ARGS.filter(a => a !== '--verify=npm test')),
    /refusing to open a PR nothing verified/)
})

test('the ordinal prefix is stripped from the PR title', () => {
  assert.equal(titleFromIssue('21.1 feat: --json output'), 'feat: --json output')
  assert.equal(titleFromIssue('L2.3.1 fix: thing'), 'fix: thing')
  assert.equal(titleFromIssue('feat: no ordinal here'), 'feat: no ordinal here')
  assert.equal(titleFromIssue(''), '')
})

test('the body is built from the branch commits, and always closes the issue', () => {
  const body = buildBody(['feat: a', '', 'test: b'], 23)
  assert.match(body, /- feat: a/)
  assert.match(body, /- test: b/)
  assert.match(body, /Closes #23/)
  assert.doesNotMatch(body, /- \n/)              // blank subjects dropped
  assert.match(buildBody([], 23), /no commit subjects found/)
})

// A fake shell: matches on a fragment of the command, records order.
const fake = (routes, log = []) => async (command, opts = {}) => {
  const joined = Array.isArray(command) ? command.join(' ') : command
  log.push(joined)
  for (const [needle, reply] of routes) {
    if (joined.includes(needle)) {
      if (reply instanceof Error) throw reply
      return { code: 0, stdout: reply, stderr: '' }
    }
  }
  return { code: 0, stdout: '', stderr: '' }
}
const OK = [
  ['status --porcelain', ''],
  ['npm test', 'ok\n'],
  ['issue view', '{"title":"23.1 feat: thing"}'],
  ['log origin/main..HEAD', 'feat: thing\ntest: thing\n'],
  ['pr create', 'https://github.com/o/n/pull/77\n'],
]

test('the happy path verifies, pushes, then opens the PR — in that order', async () => {
  const log = []
  const got = await ship(parseArgs(ARGS), fake(OK, log))
  assert.equal(got.passed, true)
  assert.equal(got.pushed, true)
  assert.equal(got.number, 77)
  const order = log.map(c => c.includes('npm test') ? 'verify' : c.includes('push') ? 'push'
    : c.includes('pr create') ? 'pr' : null).filter(Boolean)
  assert.deepEqual(order, ['verify', 'push', 'pr'])
})

test('a dirty worktree stops before anything runs', async () => {
  const log = []
  const got = await ship(parseArgs(ARGS), fake([['status --porcelain', ' M src/a.js'], ...OK], log))
  assert.equal(got.passed, false)
  assert.match(got.detail, /worktree is dirty/)
  assert.equal(log.filter(c => c.includes('push')).length, 0)
})

test('a RED command means nothing is pushed', async () => {
  // The guarantee the old prose version could only ask for.
  const log = []
  const routes = OK.map(([n, r]) => n === 'npm test' ? [n, new Error('1 failing')] : [n, r])
  const got = await ship(parseArgs(ARGS), fake(routes, log))
  assert.equal(got.passed, false)
  assert.equal(got.pushed, false)
  assert.equal(log.filter(c => c.includes('push') || c.includes('pr create')).length, 0)
  assert.match(got.detail, /verification failed: npm test/)
})

test('a later command failing still stops the push', async () => {
  const args = parseArgs([...ARGS, '--verify=npm run lint'])
  const routes = [...OK, ['npm run lint', new Error('lint error')]]
  const log = []
  const got = await ship(args, fake(routes.map(([n, r]) => n === 'npm run lint' ? [n, new Error('x')] : [n, r]), log))
  assert.equal(got.passed, false)
  assert.equal(log.filter(c => c.includes('push')).length, 0)
})

test('--head is always passed explicitly', async () => {
  // Without it gh infers the head from the cwd; once opened a PR carrying five
  // commits of unrelated work under this subtask's title.
  const log = []
  await ship(parseArgs(ARGS), fake(OK, log))
  const create = log.find(c => c.includes('pr create'))
  assert.match(create, /--head m2\/task-23/)
  assert.match(create, /--base main/)
})

test('an explicit --title overrides the derived one, and skips the issue lookup', async () => {
  const log = []
  const got = await ship(parseArgs([...ARGS, '--title=fix: explicit']), fake(OK, log))
  assert.equal(got.number, 77)
  assert.match(log.find(c => c.includes('pr create')), /fix: explicit/)
  assert.equal(log.filter(c => c.includes('issue view')).length, 0)
})

test('a push that succeeds but yields no PR URL is reported, not silently passed', async () => {
  const routes = OK.map(([n, r]) => n === 'pr create' ? [n, 'something went sideways'] : [n, r])
  const got = await ship(parseArgs(ARGS), fake(routes))
  assert.equal(got.passed, true)
  assert.equal(got.pushed, true)
  assert.equal(got.number, null)
  assert.match(got.detail, /no usable PR URL/)
})
