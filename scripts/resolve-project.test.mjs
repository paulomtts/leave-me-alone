// Tests for the deterministic board-id lookup. `gh` is injected, so these run
// against the real logic with no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, query, resolveProject } from './resolve-project.mjs'

const STATUS = {
  id: 'F_1', name: 'Status',
  options: [{ id: 'o1', name: 'Backlog' }, { id: 'o2', name: 'In progress' }],
}
const project = (fields = [STATUS]) => ({ id: 'PVT_1', title: 'Delivery', fields: { nodes: fields } })

const fakeGh = (byScope) => async (args) => {
  const joined = args.join(' ')
  const scope = joined.includes('organization(login') ? 'organization' : 'user'
  const reply = byScope[scope]
  if (reply instanceof Error) throw reply
  // Shape matters: GitHub nests the project under projectV2, and returns null
  // for the scope itself when the login is of the other kind.
  return JSON.stringify({ data: { [scope]: reply ? { projectV2: reply } : null } })
}

const opts = (run) => ({ owner: 'you', number: 13, run })

// ── parseArgs ────────────────────────────────────────────────────────────────

test('needs an owner and the small URL number', () => {
  assert.equal(parseArgs(['--owner=you', '--number=13']).number, 13)
  assert.throws(() => parseArgs(['--number=13']), /--owner/)
  assert.throws(() => parseArgs(['--owner=you']), /--number/)
  assert.throws(() => parseArgs(['--owner=you', '--number=0']), /--number/)
  assert.throws(() => parseArgs(['--owner=you', '--number=PVT_1']), /--number/)
  assert.throws(() => parseArgs(['--owner=you', '--number=13', '--wat']), /unknown argument/)
})

test('--compact is a bare flag', () => {
  const got = parseArgs(['--owner=you', '--number=13', '--compact'])
  assert.equal(got.compact, true)
  assert.equal(got.number, 13)
})

// ── query ────────────────────────────────────────────────────────────────────

test('both scopes ask for the same shape', () => {
  assert.match(query('user'), /user\(login:\$o\)/)
  assert.match(query('organization'), /organization\(login:\$o\)/)
  for (const scope of ['user', 'organization']) {
    assert.match(query(scope), /ProjectV2SingleSelectField\{id name options\{id name\}\}/)
  }
})

// ── resolveProject ───────────────────────────────────────────────────────────

test('a user-owned project resolves on the first query', async () => {
  const got = await resolveProject(opts(fakeGh({ user: project() })))
  assert.equal(got.found, true)
  assert.equal(got.scope, 'user')
  assert.equal(got.id, 'PVT_1')
  assert.deepEqual(got.fields[0].options.map(o => o.name), ['Backlog', 'In progress'])
})

test('a null user result falls through to the organisation query', async () => {
  // Asking the wrong scope returns null rather than erroring, which is exactly
  // why this is a sequence and not a single query.
  const got = await resolveProject(opts(fakeGh({ user: null, organization: project() })))
  assert.equal(got.found, true)
  assert.equal(got.scope, 'organization')
})

test('an ERRORING user query still tries the organisation', async () => {
  const got = await resolveProject(opts(fakeGh({ user: new Error('boom'), organization: project() })))
  assert.equal(got.found, true)
})

test('neither scope resolving reports BOTH attempts', async () => {
  const got = await resolveProject(opts(fakeGh({ user: null, organization: null })))
  assert.equal(got.found, false)
  assert.match(got.missing, /user: no project 13/)
  assert.match(got.missing, /organization: no project 13/)
  assert.deepEqual(got.fields, [])
})

test('names and ids are copied verbatim — nothing is matched or normalized here', async () => {
  // A case mismatch must survive the trip so the orchestrator can reject it.
  // Fixing it up here would resolve a real id for the wrong column.
  const odd = { id: 'F_9', name: 'status', options: [{ id: 'x', name: 'In Progress' }] }
  const got = await resolveProject(opts(fakeGh({ user: project([odd]) })))
  assert.equal(got.fields[0].name, 'status')
  assert.equal(got.fields[0].options[0].name, 'In Progress')
})

test('non-single-select fields are dropped, not returned as blanks', async () => {
  // The inline fragment yields {} for every field of another type; passing
  // those through would make the orchestrator's "present: ..." list useless.
  const got = await resolveProject(opts(fakeGh({ user: project([{}, STATUS, { name: 'NoId' }]) })))
  assert.equal(got.fields.length, 1)
  assert.equal(got.fields[0].name, 'Status')
})

test('a field with no options survives as an empty list', async () => {
  const got = await resolveProject(opts(fakeGh({ user: project([{ id: 'F_2', name: 'Status' }]) })))
  assert.deepEqual(got.fields[0].options, [])
})

test('a tool-manager banner in stdout does not break the lookup', async () => {
  const banner = 'mise ~/.config/mise/config.toml tools: gh@2.97.0\n'
  const run = async () => banner + JSON.stringify({ data: { user: { projectV2: project() } } })
  const got = await resolveProject(opts(run))
  assert.equal(got.found, true)
})
