#!/usr/bin/env bash
# PreToolUse hook for Bash: auto-allows the command patterns leave-me-alone's skills
# (containers, milestone, github-project-setup, smoke, orchestrator/task workflows)
# routinely need, so the auto-mode classifier doesn't re-litigate them every session.
#
# Anything not matched below falls through untouched (no JSON emitted) so normal
# permission/classifier behavior applies.
set -euo pipefail

input="$(cat)"
cmd="$(jq -r '.tool_input.command // empty' <<<"$input")"
[ -z "$cmd" ] && exit 0

allow() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# --- read-only / lifecycle commands ---------------------------------------
if grep -qE '^(git (status|log|diff|show|branch|rev-parse|remote|fetch|stash list|blame|describe)\b|gh (auth (status|refresh)|issue (list|view)|pr (list|view|checks)|project (list|view|item-list)|label list|repo view)\b|docker (compose (build|up|down|ps|logs)|ps)\b|ss -ltn\b|lsof -iTCP\b)' <<<"$cmd"; then
  allow "leave-me-alone: read-only/lifecycle command"
fi

# --- brd: the local board -------------------------------------------------
# Every subcommand reads or writes a local SQLite database: no network, nothing
# outside the project's own board, so the whole CLI is allowed rather than a
# read/write split.
#
# The `cd <dir> && ` prefix is matched explicitly because task.js's trigger
# steps pin brd's working directory that way (brd resolves its project by
# walking up from the cwd), and every pattern in this file is ^-anchored — a
# bare `brd` rule would never match the commands that actually run.
#
# The prefix is deliberately narrow: no `;`, `&`, `|`, `$`, backtick, parens,
# `<` or `>` inside the path or the trailing arguments, so it cannot become a
# way to smuggle a second command — via chaining, command substitution, or
# output/input redirection — through. This will also defer a legitimate brd
# argument that happens to contain one of these characters (e.g. a card title
# with a literal `>` in it); that's the correct trade-off — a deferred command
# costs the user a prompt, an over-matched one grants a permission they never
# approved.
if grep -qE '^(cd [^&|;$`()<>]+ && )?brd (init|projects|add|show|list|update|block|unblock|tree|next|import)( |$)[^&|;$`()<>]*$' <<<"$cmd"; then
  allow "leave-me-alone: brd (local board, no network)"
fi

# --- git merge/push/rebase, only when NOT targeting main/master ------------
if grep -qE '^git (merge|push|rebase)\b' <<<"$cmd"; then
  if grep -qE '\b(main|master)\b' <<<"$cmd"; then
    exit 0  # names main/master explicitly -> defer to normal prompt/classifier
  fi
  allow "leave-me-alone: git merge/push/rebase targeting a non-main/master branch"
fi

# --- gh pr merge: resolve the PR's actual base branch, don't trust the text -
if grep -qE '^gh pr merge\b' <<<"$cmd"; then
  pr_ref="$(sed -E 's/^gh pr merge[[:space:]]+([^ ]+).*/\1/' <<<"$cmd")"
  [[ "$pr_ref" == -* || "$pr_ref" == "gh" ]] && pr_ref=""  # no positional arg -> current branch's PR
  base="$(gh pr view ${pr_ref:+"$pr_ref"} --json baseRefName -q .baseRefName 2>/dev/null || true)"
  if [ -n "$base" ] && [[ "$base" != "main" && "$base" != "master" ]]; then
    allow "leave-me-alone: gh pr merge targeting base branch '$base' (not main/master)"
  fi
  exit 0  # base is main/master, or lookup failed -> defer to normal prompt/classifier
fi

exit 0
