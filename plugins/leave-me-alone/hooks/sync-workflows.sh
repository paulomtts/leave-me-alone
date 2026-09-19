#!/usr/bin/env bash
# Install this plugin's Workflow scripts into ~/.claude/workflows/.
#
# Plugins do not distribute workflows: the harness scans ~/.claude/workflows/*.js
# directly and nothing feeds it from a plugin. Skills, commands, agents and
# hooks ship natively; workflows do not. So this hook copies them on session
# start, which is what makes `orchestrator` and `task` appear on a fresh machine
# with nothing but the plugin installed.
#
# The plugin is the source of truth and OVERWRITES: a local edit to
# ~/.claude/workflows/orchestrator.js is discarded on the next session. Edit the
# plugin, not the copy.
#
# The helper scripts go to ~/.claude/workflows/scripts/ so that every path a run
# needs lives under one root, rather than being split between ~/.claude and a
# version-stamped plugin cache directory that moves on every upgrade.
set -euo pipefail

src="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT is not set}"
dest="${HOME}/.claude/workflows"
mkdir -p "${dest}/scripts"

changed=0
copy() {
  # cmp first so an unchanged file is not rewritten — keeps mtimes stable and
  # makes "changed" mean something.
  if ! cmp -s "$1" "$2" 2>/dev/null; then
    cp "$1" "$2"
    changed=$((changed + 1))
  fi
}

workflow_names=()
for f in "${src}"/workflows/*.js; do
  [ -e "$f" ] || continue
  copy "$f" "${dest}/$(basename "$f")"
  workflow_names+=("$(basename "$f")")
done

# Runtime helpers only. Tests and the dev-time checker stay in the plugin: they
# are not needed to RUN a milestone, and copying them would put a second,
# silently diverging copy of the test suite on every machine.
script_names=()
for f in "${src}"/scripts/*.mjs; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    *.test.mjs|check-workflows.mjs) continue ;;
  esac
  copy "$f" "${dest}/scripts/$(basename "$f")"
  script_names+=("$(basename "$f")")
done

# Remove files this plugin no longer ships.
#
# Copying alone made the destination a UNION of every version ever installed,
# not a copy of the current one: `resolve.mjs` was deleted from the plugin and
# still sat in ~/.claude/workflows/scripts/ afterwards, orphaned but present.
# The plugin is the declared source of truth (see the header) — that has to
# mean absent as well as different.
#
# Only `*.js` at the root and `*.mjs` under scripts/ are considered, so the
# README, the plans/ directory and the version stamp are left alone: this hook
# never put them there and must not take them away.
removed=0
prune() {
  # $1 = directory, $2 = glob, rest = basenames that SHOULD be present.
  local dir="$1" pattern="$2"
  shift 2
  # Nothing to compare against means the source list came back empty — see the
  # guard at the call site. Refuse rather than treat "shipped nothing" as
  # "delete everything".
  [ "$#" -gt 0 ] || return 0
  local keep=" $* " existing base
  for existing in "${dir}"/${pattern}; do
    [ -e "$existing" ] || continue
    base="$(basename "$existing")"
    case "${keep}" in
      *" ${base} "*) continue ;;
    esac
    rm -f "$existing"
    removed=$((removed + 1))
  done
}

# Guarded on a NON-EMPTY source list in both cases. A misconfigured
# CLAUDE_PLUGIN_ROOT, or a plugin layout that moved, yields no source files —
# and pruning against an empty list would wipe a working installation on the
# strength of a bad path. Syncing nothing is recoverable; deleting everything
# during session start is not.
if [ "${#workflow_names[@]}" -gt 0 ]; then
  prune "${dest}" '*.js' "${workflow_names[@]}"
fi
if [ "${#script_names[@]}" -gt 0 ]; then
  prune "${dest}/scripts" '*.mjs' "${script_names[@]}"
fi

# Warn if the hard dependencies are missing.
#
# Claude Code has no plugin dependency mechanism -- no `dependencies` key exists
# in any plugin.json or marketplace.json, including Anthropic's own -- so this
# is the earliest honest place to notice.
#
# It is a WARNING, never a failure: this hook runs at session start and has no
# business stopping a session over something the user may not be about to do.
# The real guarantee lives where it can be exact -- Plan reports whether it
# actually invoked writing-plans, and task.js stops the run if it did not.
#
# The superpowers check is a proxy: a cache directory is not proof the skill
# resolves. It can produce a false "all clear" if the plugin is installed but
# broken, so it is phrased as a pointer, not a guarantee.
if ! command -v bun >/dev/null 2>&1; then
  echo "leave-me-alone: bun is not on PATH — every helper script runs as \`bun <script>.mjs\`,"
  echo "  so orchestrator/task will stop at their first step. https://bun.sh"
fi

if ! compgen -G "${HOME}/.claude/plugins/cache/*/superpowers/*/skills/writing-plans" >/dev/null 2>&1; then
  echo "leave-me-alone: the superpowers skill 'writing-plans' was not found."
  echo "  task.js REFUSES a plan written without it, so a milestone will stop at Plan."
  echo "  /plugin install superpowers@claude-plugins-official"
fi

# Stamp what was synced, and say so when it moved.
#
# Skills and agents are plugin components: an update switches them over at once.
# Workflows are not — they are copied by THIS hook, which has already run by the
# time an update lands. So for the rest of that session you are running new
# skills and new agent types against the OLD workflow scripts, and an old
# orchestrator.js has no idea it is old.
#
# The stamp cannot close that gap: a hook cannot run before the update it reacts
# to. What it does is make the gap visible, so "restart before running a
# milestone" is something you are told rather than something you must remember.
version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "${src}/.claude-plugin/plugin.json" 2>/dev/null | head -1)"
stamp="${dest}/.synced-version"
previous="$(cat "${stamp}" 2>/dev/null || true)"

if [ -n "${version}" ]; then
  printf '%s\n' "${version}" > "${stamp}"
fi

if [ "${removed}" -gt 0 ]; then
  echo "leave-me-alone: removed ${removed} file(s) from ${dest} that v${version:-unknown} no longer ships"
fi

if [ "${changed}" -gt 0 ]; then
  echo "leave-me-alone: synced ${changed} workflow file(s) to ${dest} (v${version:-unknown})"
  if [ -n "${previous}" ] && [ "${previous}" != "${version}" ]; then
    echo "leave-me-alone: workflows moved v${previous} -> v${version:-unknown}. If you updated the"
    echo "  plugin during the PREVIOUS session, anything you ran then used the older scripts."
  fi
elif [ -n "${previous}" ] && [ "${previous}" != "${version}" ]; then
  # Files identical but the version moved: the plugin changed in ways that did
  # not touch workflows/. Worth one line, because it confirms the sync is live.
  echo "leave-me-alone: plugin v${previous} -> v${version:-unknown}; workflow scripts unchanged"
fi
