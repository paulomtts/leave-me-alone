// plugins/leave-me-alone/hooks/sync-workflows.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = fileURLToPath(new URL('./sync-workflows.sh', import.meta.url))

// The hook reads CLAUDE_PLUGIN_ROOT for its source and $HOME for its
// destination, so a fake plugin plus a fake HOME exercises the real script
// end to end without touching the developer's own ~/.claude/workflows.
function makePlugin({ workflows = {}, scripts = {}, version = '9.9.9' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lma-plugin-'))
  mkdirSync(join(root, 'workflows'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'leave-me-alone', version }))
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(root, 'workflows', name), body)
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(root, 'scripts', name), body)
  return root
}

function sync(pluginRoot, home) {
  return execFileSync('bash', [HOOK], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, HOME: home },
    encoding: 'utf8',
  })
}

test('a file the plugin no longer ships is removed, not left orphaned', () => {
  const home = mkdtempSync(join(tmpdir(), 'lma-home-'))
  const before = makePlugin({
    workflows: { 'orchestrator.js': 'v1' },
    scripts: { 'detect.mjs': 'v1', 'resolve.mjs': 'v1' },
  })
  sync(before, home)
  const resolved = join(home, '.claude', 'workflows', 'scripts', 'resolve.mjs')
  assert.ok(existsSync(resolved), 'precondition: the old version installed resolve.mjs')

  // The next release drops resolve.mjs, exactly as the brd migration did.
  const after = makePlugin({
    workflows: { 'orchestrator.js': 'v2' },
    scripts: { 'detect.mjs': 'v2' },
  })
  sync(after, home)
  assert.equal(existsSync(resolved), false, 'resolve.mjs survived a release that does not ship it')
  assert.ok(existsSync(join(home, '.claude', 'workflows', 'scripts', 'detect.mjs')))
  assert.equal(readFileSync(join(home, '.claude', 'workflows', 'orchestrator.js'), 'utf8'), 'v2')

  rmSync(home, { recursive: true, force: true })
  rmSync(before, { recursive: true, force: true })
  rmSync(after, { recursive: true, force: true })
})

test('pruning never touches files this hook did not install', () => {
  const home = mkdtempSync(join(tmpdir(), 'lma-home-'))
  const plugin = makePlugin({ workflows: { 'task.js': 'x' }, scripts: { 'gh.mjs': 'x' } })
  sync(plugin, home)

  // README.md, plans/ and the version stamp live alongside the synced files
  // and belong to the user, not to this hook.
  const dest = join(home, '.claude', 'workflows')
  writeFileSync(join(dest, 'README.md'), 'mine')
  mkdirSync(join(dest, 'plans'), { recursive: true })
  writeFileSync(join(dest, 'plans', 'note.md'), 'mine')

  sync(plugin, home)
  assert.ok(existsSync(join(dest, 'README.md')), 'README.md was deleted by pruning')
  assert.ok(existsSync(join(dest, 'plans', 'note.md')), 'plans/ was deleted by pruning')

  rmSync(home, { recursive: true, force: true })
  rmSync(plugin, { recursive: true, force: true })
})

test('an empty source list prunes nothing — a bad plugin root must not wipe an install', () => {
  // The dangerous shape: pruning against "the plugin ships nothing" would read
  // every installed file as removable. A misconfigured CLAUDE_PLUGIN_ROOT has
  // to be a no-op, not a deletion.
  const home = mkdtempSync(join(tmpdir(), 'lma-home-'))
  const real = makePlugin({ workflows: { 'orchestrator.js': 'v1' }, scripts: { 'detect.mjs': 'v1' } })
  sync(real, home)

  const empty = makePlugin()   // no workflows, no scripts
  sync(empty, home)
  assert.ok(existsSync(join(home, '.claude', 'workflows', 'orchestrator.js')),
    'an empty plugin root deleted an installed workflow')
  assert.ok(existsSync(join(home, '.claude', 'workflows', 'scripts', 'detect.mjs')),
    'an empty plugin root deleted an installed script')

  rmSync(home, { recursive: true, force: true })
  rmSync(real, { recursive: true, force: true })
  rmSync(empty, { recursive: true, force: true })
})

test('tests and the dev-time checker are still never installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'lma-home-'))
  const plugin = makePlugin({
    workflows: { 'orchestrator.js': 'x' },
    scripts: { 'detect.mjs': 'x', 'detect.test.mjs': 'x', 'check-workflows.mjs': 'x' },
  })
  sync(plugin, home)
  const scripts = join(home, '.claude', 'workflows', 'scripts')
  assert.ok(existsSync(join(scripts, 'detect.mjs')))
  assert.equal(existsSync(join(scripts, 'detect.test.mjs')), false)
  assert.equal(existsSync(join(scripts, 'check-workflows.mjs')), false)

  rmSync(home, { recursive: true, force: true })
  rmSync(plugin, { recursive: true, force: true })
})
