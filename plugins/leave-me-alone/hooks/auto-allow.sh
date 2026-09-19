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

# grep -E is line-oriented: ^ and $ anchor per LINE, and -q succeeds if ANY
# line matches. That bounds where a match can START, but nothing about ^/$
# stops a SECOND command from riding along after a match on the same line —
# only an explicit tail restriction (no `&|;$`()<>` after the matched verb)
# does that. Every rule below is written to carry that tail restriction
# itself; this guard only rules out the separate multi-line case, where an
# unrelated line could ride along on a matching one in either order. No
# legitimate command these workflows emit spans lines, so refuse the whole
# class here rather than making every present and future rule remember this.
case "$cmd" in *$'\n'*) exit 0 ;; esac

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
# `git branch` and `git remote` are deliberately NOT in this list: both have
# destructive forms (`git branch -D main`, `git branch -f foo origin/x`,
# `git remote add evil https://...`) that are not read-only, and there is no
# safe way to admit only their read-only invocations without a separate,
# narrower rule than this one. Dropped rather than special-cased: a deferred
# command costs a prompt, a wrongly-allowed one does not.
#
# The trailing `[^&|;$`()<>]*$` mirrors the brd rule below: it bounds what
# can follow a matched verb on the same line, so nothing can be chained,
# substituted, or redirected after it.
if grep -qE '^(git (status|log|diff|show|rev-parse|fetch|stash list|blame|describe)|gh (auth (status|refresh)|issue (list|view)|pr (list|view|checks)|project (list|view|item-list)|label list|repo view)|docker (compose (build|up|down|ps|logs)|ps)|ss -ltn|lsof -iTCP)( |$)[^&|;$`()<>]*$' <<<"$cmd"; then
  allow "leave-me-alone: read-only/lifecycle command"
fi

# --- brd: the local board -------------------------------------------------
# These subcommands read or write a local SQLite database: no network, nothing
# outside the project's own board, so they are allowed rather than split by
# read/write.
#
# `brd delete` is deliberately NOT in the list. It satisfies that same "local
# board only" test, and it is still different in kind: it is IRREVERSIBLE, and
# `--cascade` takes a milestone's whole subtree with it. Nothing writes a board
# snapshot automatically (see setup-report), so there is no file to restore
# from afterwards. The asymmetry that decides every other rule in this file
# decides this one too, just in the other direction — a prompt costs one
# keystroke, a wrongly-allowed cascade costs the board.
#
# The list is an explicit enumeration rather than `brd <anything>` for the same
# reason: a subcommand brd gains later lands DEFERRED by default, so the tool
# growing a destructive verb cannot silently widen a permission already
# granted. The cost is editing this line when brd gains a benign subcommand.
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
if grep -qE '^(cd [^&|;$`()<>]+ && )?brd (init|prompt|projects|add|show|list|update|block|unblock|tree|next|import)( |$)[^&|;$`()<>]*$' <<<"$cmd"; then
  allow "leave-me-alone: brd (local board, no network)"
fi

# --- git merge/push/rebase, only when NOT targeting main/master ------------
# The tail restriction is applied BEFORE the main/master text check, so
# nothing can be chained after the branch name to ride along once that check
# passes (e.g. `git merge feature-x; rm -rf /tmp/zz` never reaches the
# main/master check at all — it fails the tail restriction first).
if grep -qE '^git (merge|push|rebase)( |$)[^&|;$`()<>]*$' <<<"$cmd"; then
  if grep -qE '\b(main|master)\b' <<<"$cmd"; then
    exit 0  # names main/master explicitly -> defer to normal prompt/classifier
  fi
  allow "leave-me-alone: git merge/push/rebase targeting a non-main/master branch"
fi

# --- gh pr merge: resolve the PR's actual base branch, don't trust the text -
# Same tail restriction, for the same reason: without it, whatever base
# `gh pr view` resolves to, a chained second command rides along for free.
if grep -qE '^gh pr merge( |$)[^&|;$`()<>]*$' <<<"$cmd"; then
  pr_ref="$(sed -E 's/^gh pr merge[[:space:]]+([^ ]+).*/\1/' <<<"$cmd")"
  [[ "$pr_ref" == -* || "$pr_ref" == "gh" ]] && pr_ref=""  # no positional arg -> current branch's PR
  base="$(gh pr view ${pr_ref:+"$pr_ref"} --json baseRefName -q .baseRefName 2>/dev/null || true)"
  if [ -n "$base" ] && [[ "$base" != "main" && "$base" != "master" ]]; then
    allow "leave-me-alone: gh pr merge targeting base branch '$base' (not main/master)"
  fi
  exit 0  # base is main/master, or lookup failed -> defer to normal prompt/classifier
fi

exit 0
