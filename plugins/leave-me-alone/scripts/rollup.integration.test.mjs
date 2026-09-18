// Runs the REAL brd against a throwaway registry. Skipped when brd is absent.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rollup } from './rollup.mjs'

let hasBrd = true
try { execFileSync('brd', ['--help'], { stdio: 'ignore' }) } catch { hasBrd = false }

let root, repo, repoBlocked, env
before(() => {
  if (!hasBrd) return
  root = mkdtempSync(path.join(tmpdir(), 'brd-rollup-'))
  repo = path.join(root, 'repo')
  mkdirSync(repo)
  repoBlocked = path.join(root, 'repo-blocked')
  mkdirSync(repoBlocked)
  env = { ...process.env, XDG_DATA_HOME: path.join(root, 'data') }
})
after(() => { if (root) rmSync(root, { recursive: true, force: true }) })

test('a subtask going done rolls its story and milestone up on a real board',
  { skip: !hasBrd && 'brd not installed' }, async () => {
    const brdCli = (...args) => execFileSync('brd', args, { cwd: repo, env, encoding: 'utf8' })
    const cli = (...args) => JSON.parse(brdCli(...args)).data
    const run = async args => brdCli(...args)

    cli('init', '--name', 'rollup-demo')
    const milestone = cli('add', '--title', 'Milestone').id
    const story = cli('add', '--title', 'Story', '--parent', milestone).id
    const first = cli('add', '--title', 'first', '--parent', story).id
    const second = cli('add', '--title', 'second', '--parent', story, '--blocked-by', first).id

    // One of two subtasks done: story is under way, milestone with it.
    await rollup({ card: first, status: 'done', cwd: repo, run })
    assert.equal(cli('show', story).status, 'in_progress')
    assert.equal(cli('show', milestone).status, 'in_progress')

    // Both done: story done, and the milestone follows.
    await rollup({ card: second, status: 'done', cwd: repo, run })
    assert.equal(cli('show', story).status, 'done')
    assert.equal(cli('show', milestone).status, 'done')
  })

test('a blocked sibling must not read as in-progress work at the milestone',
  { skip: !hasBrd && 'brd not installed' }, async () => {
    const brdCli = (...args) => execFileSync('brd', args, { cwd: repoBlocked, env, encoding: 'utf8' })
    const cli = (...args) => JSON.parse(brdCli(...args)).data
    const run = async args => brdCli(...args)

    cli('init', '--name', 'rollup-blocked')
    const milestone = cli('add', '--title', 'Milestone').id
    const storyA = cli('add', '--title', 'Story A', '--parent', milestone).id
    const storyB = cli('add', '--title', 'Story B', '--parent', milestone).id
    cli('block', storyB, '--by', storyA)
    const a1 = cli('add', '--title', 'a1', '--parent', storyA).id

    // brd must genuinely report the blocked status at this moment — assert it,
    // the way census.integration.test.mjs asserts its raw pre-collapse value.
    assert.equal(cli('show', storyB).status, 'blocked')

    // Nothing has started. Rolling a1 to todo walks up through story A (already
    // todo, no write) to the milestone, whose children read [todo, blocked].
    await rollup({ card: a1, status: 'todo', cwd: repoBlocked, run })

    // The milestone must stay todo. If the blocked value reached the rule
    // unflattened it would read as a mix and the milestone would go in_progress —
    // a board claiming work is under way when nothing has started.
    assert.equal(cli('show', milestone).status, 'todo')
  })
