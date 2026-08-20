# paulomtts-plugins

Personal Claude Code plugin marketplace.

## Requirements

| | why | if missing |
|---|---|---|
| **bun** | every helper script runs under it — the workflows literally invoke `bun <script>.mjs` | the run stops at its first trigger step |
| **superpowers** plugin | `superpowers:writing-plans` defines the plan format that Implement and Review both assume | **the run stops.** Plan reports whether it actually invoked the skill, and a plan written from memory is refused rather than treated as equivalent |
| **gh**, authenticated | issues, sub-issues, PRs, and Projects v2 board mutations | resolution fails at launch |
| **git** | worktrees, branches, stacked bases | — |

`gh auth status` must show the **`project`** scope — there is no boardless mode, so a run without
board access stops rather than silently skipping card moves:

```
gh auth refresh -s project,read:project
```

**Node is not needed to run a milestone**, only to run this repo's own test suite — and it must be
`node --test`, not `bun test`: the tests are written against `node:test`, which bun's runner cannot
execute.

Softer couplings, which degrade rather than stop: the `code-worker` agent is told to reach for
`superpowers:test-driven-development` and `superpowers:systematic-debugging`, and `setup-milestone`
assumes a spec produced by `superpowers:brainstorming`. Nothing enforces either.

Verified against superpowers 6.0.3 and 6.3.0 — the `docs/superpowers/{plans,specs}/` layout and the
spec/plan reviewer templates are unchanged across that bump.

## Install

```
/plugin marketplace add paulomtts/leave-me-alone
/plugin install leave-me-alone@paulomtts-plugins
```

## Update

Push changes to this repo, then in Claude Code:

```
/plugin marketplace update paulomtts-plugins
```

## Contents (leave-me-alone)

- `brief` — /brief, fast recap of conversation/task state
- `build` — rebuild worktree containers, dodging port conflicts
- `dispatch` — /dispatch, launch a subagent pinned to a specific model
- `explain` — /explain, plain-language explanation + ASCII architecture diagram
- `setup-project` — preps a repo's GitHub Projects v2 board for the orchestrator/task workflows
- `setup-milestone` — sets up a GitHub milestone with story issues + sub-issue subtasks
- `setup-report` — renders an in-flight-work progress dashboard as an Artifact
- `smoke` — /smoke, rebuild + drive the app in Chrome to smoke-test recent work

## Auto-allow hook

Plugins can't grant permissions or configure the auto-mode classifier directly —
that always has to live in your own `settings.json`. What a plugin *can* do is ship
a `PreToolUse` hook that auto-loads once the plugin is enabled, with no settings.json
edit required.

`hooks/auto-allow.sh` runs on every `Bash` call and auto-allows, without prompting
or invoking the classifier:

- **Read-only / lifecycle**: `git status|log|diff|show|branch|rev-parse|remote|fetch|stash list|blame|describe`,
  `gh auth status|refresh`, `gh issue/pr list|view`, `gh pr checks`, `gh project list|view|item-list`,
  `gh label list`, `gh repo view`, `docker compose build|up|down|ps|logs`, `docker ps`, `ss -ltn`, `lsof -iTCP`.
- **GitHub writes** used by `setup-milestone` / `setup-project`: `gh issue create`, `gh label create`,
  `gh project create`, `gh project item-add|item-edit`, `gh api graphql`, `gh api ... -X POST|PATCH|PUT`.
- **git merge/push/rebase and `gh pr merge`** — allowed *only* when the target branch is not `main`/`master`.
  For `git merge|push|rebase` this is a text check on the command; for `gh pr merge` (which often doesn't
  name the branch at all) the hook calls `gh pr view --json baseRefName` to resolve the PR's actual base
  before deciding.

Anything not matched falls through untouched — normal permission/classifier behavior applies. Everything
targeting `main`/`master` always falls through too, on purpose.
