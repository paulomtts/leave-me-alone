# paulomtts-plugins

Personal Claude Code plugin marketplace.

## Install

```
/plugin marketplace add paulomtts/claude-plugins
/plugin install paulo-tools@paulomtts-plugins
```

## Update

Push changes to this repo, then in Claude Code:

```
/plugin marketplace update paulomtts-plugins
```

## Contents (paulo-tools)

- `brief` — /brief, fast recap of conversation/task state
- `containers` — rebuild worktree containers, dodging port conflicts
- `dispatch` — /dispatch, launch a subagent pinned to a specific model
- `explain` — /explain, plain-language explanation + ASCII architecture diagram
- `github-project-setup` — preps a repo's GitHub Projects v2 board for the orchestrator/task workflows
- `layout` — maps a UI surface's component/layout tree
- `milestone` — sets up a GitHub milestone with story issues + sub-issue subtasks
- `progress` — renders an in-flight-work progress dashboard as an Artifact
- `smoke` — /smoke, rebuild + drive the app in Chrome to smoke-test recent work
