---
name: smoke
description: Smoke test features just delivered — rebuild containers (dodging port conflicts), drive the app through Claude's Chrome extension, and produce a fix-ready report. Use when the user says "/smoke" or asks to smoke test, verify in-browser, or sanity-check something just shipped.
---

# smoke

Verify recently delivered work actually works, live, in the browser — not just tests passing.

## Steps

1. **Scope the smoke.** Figure out what was "just delivered": check `.claude/ledger/BOARD.md` for cards in `In Review`/`Verifying`, or `git log`/`git diff` against the target branch if the user names one. List concrete user-facing flows to exercise (page X loads, button Y does Z, form W validates). If scope is ambiguous, ask.

2. **Claim the shared-browser lock.** The Claude in Chrome extension drives one shared browser, and localhost cookies aren't port-scoped — two concurrent smoke sessions hitting different ports on the same host can still stomp each other's session cookies, causing spurious mid-flow logouts that look like app bugs but aren't. Before rebuilding containers or touching `mcp__claude-in-chrome__*`:
   - Resolve the repo root: `git rev-parse --path-format=absolute --git-common-dir | xargs dirname`. Lock file lives at `<repo-root>/.claude/smoke-test.lock`.
   - `cat` it if present. If it names a session/job that's still active (ask the user if unsure — they can see their job list), do not proceed to browser driving; either wait or ask the user how to sequence with that session.
   - If absent, or present but stale/released, claim it: write `session=<your session name or job id>\nstarted_at=<date -u +%FT%TZ>\nstatus=active\n` to the file.
   - When your smoke pass finishes (report delivered, or you're aborting), release it: either delete the file or overwrite with `status=released`. Don't leave it dangling — a stale "active" lock blocks the next session for no reason.
   - This is advisory, not enforced — it only works if every smoke run checks it. If you discover another session mid-run despite the lock (e.g. the user tells you), stop driving the browser and hand off/serialize rather than racing further requests.

3. **Rebuild containers.** Invoke the `rebuild` skill (or run its steps directly: bump host ports +100 in `docker-compose.yml`, `docker compose build`, `docker compose up -d`) to dodge port conflicts with any stack already running. Report the resulting host ports.
   - If `docker compose up` fails because a shifted port is still taken, report the conflict — don't keep guessing offsets.
   - Watch container logs for startup errors before treating the stack as ready:
     ```
     docker compose logs --tail=100
     ```

4. **Load the Claude in Chrome tools.** Before any `mcp__claude-in-chrome__*` call, load them in one batched `ToolSearch`:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests`
   Call `tabs_context_mcp` first, then open a new tab pointed at the rebuilt stack's shifted port — never reuse tab IDs from an earlier session.

5. **Drive each flow from step 1.** For every flow: navigate, interact (click/type/submit) via `computer`/`form_input`, then verify with `read_page` and `read_console_messages` (filter with a `pattern` for the relevant component/module rather than reading everything). Check `read_network_requests` for failed/unexpected calls (4xx/5xx, missing HTMX OOB swaps). Avoid triggering JS `alert`/`confirm`/`prompt` dialogs — they block the extension.
   - If a page/element doesn't respond after 2-3 attempts, stop retrying that flow, note it as a finding, and move to the next flow rather than looping.

6. **Report.** Produce a findings report the agent can act on directly — one entry per flow tested:
   ```
   ### <flow name>
   - **Status:** pass | fail | partial
   - **Steps:** what was clicked/typed/navigated
   - **Expected:** ...
   - **Actual:** ...
   - **Evidence:** console/network excerpt (shortest decisive line, not a full dump) or screenshot
   - **Suspected cause / file:line:** if failed, point at the likely source
   ```
   Order failures first. Don't include praise or narration for passing flows beyond the one-line status.

7. Do not fix anything during the smoke pass itself unless the user asks — this skill's deliverable is the report. Iterating on fixes is a separate step after the report lands.
   Release the lock from step 2 as part of wrapping up, whether you finished cleanly or aborted.

## Notes

- This is browser-driven verification, not a replacement for the test suite — it catches integration/rendering issues tests miss (real container wiring, real HTMX swaps, real console errors).
- If containers were already running before this skill started (i.e. no rebuild was needed), skip step 2 but still confirm the stack is healthy via `docker compose ps`.
