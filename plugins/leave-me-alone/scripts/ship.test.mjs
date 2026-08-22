import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, titleFromIssue, buildBody, verifyError, ship } from './ship.mjs'

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

// ── verifyError ──────────────────────────────────────────────────────────────
// Added after seven live Ship runs all reported the content-free
// {"command":"./scripts/gate-frontend.sh","ok":false,"tail":"Command failed: ./scripts/gate-frontend.sh"}
// — ghError only reads err.stderr, which is right for gh/git (they always use
// it) but wrong for arbitrary repo verify commands: linters and gate scripts
// routinely print their diagnostic to STDOUT and exit non-zero, leaving
// stderr empty, so every one of those seven blocked a PR with nothing
// actionable to act on.

test('stderr is used when the command wrote to it', () => {
  const err = new Error('Command failed: npm test')
  err.stderr = '  \n1 failing\n  1) adds numbers\n'
  err.stdout = ''
  assert.equal(verifyError(err), '1) adds numbers')
})

test('stdout is used when stderr is empty — the gate-frontend.sh case', () => {
  const err = new Error('Command failed: ./scripts/gate-frontend.sh')
  err.stdout = 'Checking frontend assets...\nERROR: graph_canvas.js:241 unexpected token\n'
  err.stderr = ''
  assert.equal(verifyError(err), 'ERROR: graph_canvas.js:241 unexpected token')
})

test('stderr wins over stdout when both are present', () => {
  const err = new Error('Command failed')
  err.stdout = 'running suite...\nsummary: 4 tests\n'
  err.stderr = 'FATAL: config.toml not found\n'
  assert.equal(verifyError(err), 'FATAL: config.toml not found')
})

test('falls back to the bare error message when neither stream has content', () => {
  const err = new Error('spawn ENOENT')
  assert.equal(verifyError(err), 'spawn ENOENT')
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

test('a verify command that fails with diagnostics on stdout reports them, not just "Command failed"', async () => {
  const err = new Error('Command failed: ./scripts/gate-frontend.sh')
  err.stdout = 'Checking frontend assets...\nERROR: graph_canvas.js:241 unexpected token\n'
  err.stderr = ''
  const log = []
  const routes = OK.map(([n, r]) => n === 'npm test' ? [n, err] : [n, r])
  const got = await ship(parseArgs(ARGS), fake(routes, log))
  assert.equal(got.passed, false)
  assert.match(got.detail, /unexpected token/)
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

// ── retries: reads freely, writes carefully ──────────────────────────────────

const NOWAIT = () => Promise.resolve()

test('a flaky push is retried — pushing the same commits twice is a no-op', async () => {
  let pushes = 0
  const run = async (command, opts = {}) => {
    const joined = Array.isArray(command) ? command.join(' ') : command
    if (joined.includes('push')) { pushes += 1; if (pushes < 3) throw new Error('HTTP2 framing layer') }
    for (const [needle, reply] of OK) if (joined.includes(needle)) return { code: 0, stdout: reply, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const got = await ship(parseArgs(ARGS), run, NOWAIT)
  assert.equal(got.number, 77)
  assert.equal(pushes, 3)
})

test('a failed `pr create` does NOT retry — it asks what actually happened', async () => {
  // A lost response after a successful create would make a blind retry open a
  // SECOND PR for one branch, leaving the orchestrator two candidates.
  let creates = 0
  const run = async (command) => {
    const joined = Array.isArray(command) ? command.join(' ') : command
    if (joined.includes('pr create')) { creates += 1; throw new Error('timeout') }
    if (joined.includes('pulls?state=open')) return { code: 0, stdout: '["https://github.com/o/n/pull/91"]', stderr: '' }
    for (const [needle, reply] of OK) if (joined.includes(needle)) return { code: 0, stdout: reply, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const got = await ship(parseArgs(ARGS), run, NOWAIT)
  assert.equal(creates, 1, 'must not retry the mutation')
  assert.equal(got.number, 91, 'adopts the PR that already exists')
  assert.match(got.detail, /using it rather than opening a second/)
})

test('a failed `pr create` with no PR afterwards is reported as a failure', async () => {
  const run = async (command) => {
    const joined = Array.isArray(command) ? command.join(' ') : command
    if (joined.includes('pr create')) throw new Error('permission denied')
    if (joined.includes('pulls?state=open')) return { code: 0, stdout: '[]', stderr: '' }
    for (const [needle, reply] of OK) if (joined.includes(needle)) return { code: 0, stdout: reply, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const got = await ship(parseArgs(ARGS), run, NOWAIT)
  assert.equal(got.number, null)
  assert.equal(got.pushed, true)
  assert.match(got.detail, /no PR exists/)
})

test('verification commands are NEVER retried', async () => {
  // Retrying a test suite until it passes is how a flaky test ships.
  let runs = 0
  const run = async (command) => {
    const joined = Array.isArray(command) ? command.join(' ') : command
    if (joined.includes('npm test')) { runs += 1; throw new Error('1 failing') }
    return { code: 0, stdout: '', stderr: '' }
  }
  const got = await ship(parseArgs(ARGS), run, NOWAIT)
  assert.equal(runs, 1)
  assert.equal(got.passed, false)
})

test('captured output is flattened to printable text', async () => {
  // The failure this prevents: Node's test runner colours its output, the
  // script JSON-escaped the ESC bytes, the agent's structured output DECODED
  // them back to raw control characters, and JSON.parse rejected the report --
  // after the PR had already been opened.
  const ESC = String.fromCharCode(27)
  const coloured = `${ESC}[34m\u2139 duration_ms 302.9${ESC}[39m`
  const run = async (command) => {
    const joined = Array.isArray(command) ? command.join(' ') : command
    if (joined.includes('npm test')) return { code: 0, stdout: coloured, stderr: '' }
    for (const [needle, reply] of OK) if (joined.includes(needle)) return { code: 0, stdout: reply, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const got = await ship(parseArgs(ARGS), run, NOWAIT)
  assert.equal(got.verified[0].tail, '\u2139 duration_ms 302.9')
  // The report must survive being serialized and decoded, which is what the
  // round trip through an agent actually does.
  const roundTripped = JSON.parse(JSON.stringify(got))
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(roundTripped)))
  assert.equal(/[\u0000-\u001f\u007f]/.test(JSON.stringify(got)), false, 'no raw control characters anywhere')
})

test('a long tail is capped — it is a hint, not a payload', async () => {
  const run = async (command) => {
    const joined = Array.isArray(command) ? command.join(' ') : command
    if (joined.includes('npm test')) return { code: 0, stdout: 'x'.repeat(5000), stderr: '' }
    for (const [needle, reply] of OK) if (joined.includes(needle)) return { code: 0, stdout: reply, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const got = await ship(parseArgs(ARGS), run, NOWAIT)
  assert.ok(got.verified[0].tail.length <= 301, `tail was ${got.verified[0].tail.length}`)
})
