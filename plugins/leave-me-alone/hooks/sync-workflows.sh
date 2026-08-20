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

for f in "${src}"/workflows/*.js; do
  [ -e "$f" ] || continue
  copy "$f" "${dest}/$(basename "$f")"
done

# Runtime helpers only. Tests and the dev-time checker stay in the plugin: they
# are not needed to RUN a milestone, and copying them would put a second,
# silently diverging copy of the test suite on every machine.
for f in "${src}"/scripts/*.mjs; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    *.test.mjs|check-workflows.mjs) continue ;;
  esac
  copy "$f" "${dest}/scripts/$(basename "$f")"
done

if [ "${changed}" -gt 0 ]; then
  echo "leave-me-alone: synced ${changed} workflow file(s) to ${dest}"
fi
