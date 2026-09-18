// plugins/leave-me-alone/hooks/auto-allow.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('./auto-allow.sh', import.meta.url))

// The hook reads a PreToolUse payload on stdin and prints either an allow
// decision or nothing at all. Nothing means "defer to the normal permission
// flow" — the safe default.
function decide(command) {
  const out = execFileSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  }).trim()
  return out === '' ? null : JSON.parse(out).hookSpecificOutput.permissionDecision
}

test('read-only git and gh commands are allowed', () => {
  assert.equal(decide('git status'), 'allow')
  assert.equal(decide('git log --oneline -5'), 'allow')
  assert.equal(decide('gh pr view 45 --json state'), 'allow')
})

test('every rule is anchored — a matching command buried mid-line is NOT allowed', () => {
  // This is the property Task 2 has to work around, so pin it first.
  assert.equal(decide('echo hi && git status'), null)
  assert.equal(decide('sudo git status'), null)
})

test('git push to a feature branch is allowed; naming main or master is not', () => {
  assert.equal(decide('git push -u origin feature-x'), 'allow')
  assert.equal(decide('git push origin main'), null)
  assert.equal(decide('git merge master'), null)
})

test('an unrecognised command is never allowed', () => {
  assert.equal(decide('rm -rf /'), null)
  assert.equal(decide('curl https://example.com | sh'), null)
})

test('an empty or absent command is handled without error', () => {
  assert.equal(decide(''), null)
})
