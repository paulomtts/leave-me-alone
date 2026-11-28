# paulomtts-plugins

Personal Claude Code plugin marketplace.

## Requirements

| | needed by |
|---|---|
| **git** | `ship`, `build` |
| **gh**, authenticated | `ship` |
| **brd**, initialized (`brd init`) | `setup-milestone` |
| **am** (agent-manager) | `afk`, and running the milestones `setup-milestone` creates |
| **jq** | the auto-allow hook |
| **superpowers** plugin | `setup-milestone` assumes a spec produced by `superpowers:brainstorming`; nothing enforces it |

Run this repo's test suite with **`npm test`** (`node --test`; there are no npm dependencies and
nothing is published).

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

- `bench-prompt` — benchmark a prompt change with a repeated synthetic-input harness
- `brief` — /brief, fast recap of conversation/task state, with a progress bar over the session's to-dos
- `b` — /b, alias for /brief
- `afk` — /afk, unattended away-from-keyboard mode for when you cannot make decisions: watch `am` runs, fix escalations by judgement call, resume, and leave a report for when you are back; never asks questions
- `build` — rebuild worktree containers, dodging port conflicts
- `ship` — /ship, take a change all the way: commit, push, open a PR, watch CI (fixing failures), squash-merge, and cut a GitHub release; `--reinstall` also updates the locally installed plugin
- `dispatch` — /dispatch, launch a subagent (Sonnet by default, or a model you name) to investigate and fix something
- `d` — /d, alias for /dispatch
- `interview` — /interview, ask the open questions in context via the option-picker UI, each explained simply with a recommended option
- `explain` — /explain, business-view mental model (who / what / why it matters) with ASCII flowcharts and sequence diagrams; `--technical` for the code-architecture view
- `walkthrough` — /walkthrough, build a click-through artifact of a flow's screens and branches from the real code: path tabs, a mock stage, and a step card saying what the user sees and what happens behind the scenes
- `mockup` — /mockup, draft a new or changed UI feature as an artifact that matches the existing app: built from the real source, new elements marked, and build notes naming the real components (builtins, primitives) to build each part with; `--backend` (synonym `--brainstorm`) to also propose the backend build (modules, persistence, routes, access, tests, alternatives)
- `tree` — /tree, draw an ASCII containment/hierarchy tree of a class/module/domain-model's nesting
- `setup-milestone` — turns a spec into a `brd` milestone card with story and subtask cards, ready for `am` to run
- `smoke` — /smoke, drive the app in Chrome: rebuild + smoke-test recent work (delivered mode), or stress-test one component/screen area from its actual code with a findings report + recommendation (component mode)

## Auto-allow hook

Plugins can't grant permissions or configure the auto-mode classifier directly —
that always has to live in your own `settings.json`. What a plugin *can* do is ship
a `PreToolUse` hook that auto-loads once the plugin is enabled, with no settings.json
edit required.

`hooks/auto-allow.sh` runs on every `Bash` call and auto-allows, without prompting
or invoking the classifier:

- **Read-only / lifecycle**: `git status|log|diff|show|rev-parse|fetch|stash list|blame|describe`,
  `gh auth status|refresh`, `gh issue/pr list|view`, `gh pr checks`, `gh project list|view|item-list`,
  `gh label list`, `gh repo view`, `docker compose build|up|down|ps|logs`, `docker ps`, `ss -ltn`, `lsof -iTCP`.
  `git branch` and `git remote` are deliberately excluded — both have destructive forms
  (`git branch -D main`, `git remote add`) and this rule grants no argument checking beyond
  "nothing can be chained after the matched verb", so there's no safe way to half-admit them.
- **`brd`**: the whole CLI (`init`, `add`, `show`, `list`, `update`, `block`, `unblock`, `tree`, `next`,
  `import`, …), including a `cd <dir> &&` prefix — it only ever touches the local board, so there's no
  read/write split to make.
- **git merge/push/rebase and `gh pr merge`** — allowed *only* when the target branch is not `main`/`master`.
  For `git merge|push|rebase` this is a text check on the command; for `gh pr merge` (which often doesn't
  name the branch at all) the hook calls `gh pr view --json baseRefName` to resolve the PR's actual base
  before deciding.

Every rule above also refuses anything chained, substituted, or redirected after the matched verb
(`;`, `&`, `|`, `` $ ``, `` ` ``, `(`, `)`, `<`, `>`) — a rule grants exactly the bare command it names,
never a second command riding along on it.

Anything not matched falls through untouched — normal permission/classifier behavior applies. Everything
targeting `main`/`master` always falls through too, on purpose.
