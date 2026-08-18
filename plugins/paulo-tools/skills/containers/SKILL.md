---
name: containers
description: Rebuild containers from the current worktree, watching out for port conflicts with other running stacks. Use when the user says "/containers" or asks to rebuild/restart containers for the worktree they're currently in.
---

# containers

Rebuild the current worktree's container stack without colliding with ports other worktrees/stacks already hold.

## Steps

1. Confirm cwd is inside a worktree (e.g. `.claude/worktrees/<topic>`), not the main checkout. If cwd is the main checkout, ask which worktree before touching anything — rebuilding there risks colliding with the user's live dev stack.
2. Find the compose file(s) in that worktree (`docker-compose.yml`, plus any `docker-compose.override.yml` / `docker-compose.smoke.yml` in play). Collect every `ports:` entry's `HOST` value.
3. Probe ports actually in use right now:
   - `ss -ltn` (or `lsof -iTCP -sTCP:LISTEN -P` if `ss` missing)
   - `docker ps --format '{{.Names}} {{.Ports}}'` — this also surfaces ports held by *other worktrees'* stacks (including this same worktree left up under a prior offset).
4. If this worktree's compose file already has a working, conflict-free offset (check its current host ports against step 3's list), skip straight to rebuild — don't re-shift ports that already work.
5. Otherwise pick an offset: start at +100, check whether every port in the file shifted by that offset is free per step 3. If any collide, try +200, +300, ... incrementing by 100 until a full offset has zero collisions. Don't default to +100 without checking.
6. Apply the offset to every `ports:` entry's `HOST` value only (`"8000:8000"` -> `"8100:8000"`), leaving `CONTAINER` untouched. Don't touch `expose:` entries or env var references. Show the diff before applying.
7. Rebuild and restart from the worktree root:
   ```
   docker compose build
   docker compose up -d
   ```
8. Report: which worktree, the offset used (or "none — reused existing"), and the host ports the services are now reachable on.

## Notes

- Multiple worktrees can be running stacks simultaneously — always probe live state (step 3), never assume a fixed port map per worktree.
- If `docker compose up` fails on a port taken between probe and up (race), report the conflict and re-probe rather than guessing another offset.
- If the user wants a worktree's stack torn down instead of rebuilt, that's out of scope here — confirm with them and run `docker compose down` explicitly.
