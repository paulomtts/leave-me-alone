// Runs the REAL brd against a throwaway registry. Skipped when brd is absent,
// so the unit suite still runs on a machine without it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brd } from './brd.mjs'
import { findMilestone, flattenMilestone } from './census.mjs'

let hasBrd = true
try { execFileSync('brd', ['--help'], { stdio: 'ignore' }) } catch { hasBrd = false }

let root, repo, env
before(() => {
  if (!hasBrd) return
  root = mkdtempSync(path.join(tmpdir(), 'brd-census-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  env = { ...process.env, XDG_DATA_HOME: path.join(root, 'data') }
})
after(() => { if (root) rmSync(root, { recursive: true, force: true }) })

const brdCli = (...args) => execFileSync('brd', args, { cwd: repo, env, encoding: 'utf8' })
const cli = (...args) => JSON.parse(brdCli(...args)).data
const addCard = (title, opts = []) => cli('add', '--title', title, ...opts).id

test('census matches a real board, including inherited blocking', { skip: !hasBrd && 'brd not installed' }, async () => {
  cli('init', '--name', 'census-demo')
  const milestone = addCard('Milestone 12: CSV export')
  const storyA = addCard('Story: CSV writer', ['--parent', milestone])
  const storyB = addCard('Story: Document it', ['--parent', milestone])
  cli('block', storyB, '--by', storyA)
  const rows = addCard('feat: write rows', ['--parent', storyA])
  addCard('feat: quoting', ['--parent', storyA, '--blocked-by', rows])
  addCard('docs: usage', ['--parent', storyB])

  const roots = await brd(['tree'], { cwd: repo, run: async args => brdCli(...args) })

  // The raw tree must show brd's ancestor-inherited status: `docs: usage` carries
  // no blocker of its own, and is reported blocked purely through its parent story.
  // Asserting this BEFORE the collapse is the point of this test — the flattened
  // 'todo' below would look identical if brd had never inherited anything.
  const rawMilestone = findMilestone(roots, 'CSV export')
  const rawStoryB = rawMilestone.children.find(c => c.title === 'Story: Document it')
  const rawDocs = rawStoryB.children.find(c => c.title === 'docs: usage')
  assert.deepEqual(rawDocs.blocked_by, [], 'docs: usage must carry no blocker of its own')
  assert.equal(rawDocs.status, 'blocked', 'brd must report the inherited blocked status')

  const census = flattenMilestone(rawMilestone)

  assert.deepEqual(census.stories.map(s => s.title), ['Story: CSV writer', 'Story: Document it'])
  assert.deepEqual(census.stories[0].subtasks.map(s => s.title), ['feat: write rows', 'feat: quoting'])
  assert.deepEqual(census.stories[1].blockedBy, [storyA])
  // Collapsed counterpart of the raw assertion above: brd's inherited `blocked`
  // becomes `todo` here, because readiness is decided by the DAG walk.
  assert.equal(census.stories[1].subtasks[0].status, 'todo')
})
