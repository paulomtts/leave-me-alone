---
name: smoke
description: Drive the app live through Claude's Chrome extension and produce a fix-ready report, in one of two modes. Delivered mode (default) smoke tests what was just shipped — rebuild containers (dodging port conflicts) and exercise the known flows. Component mode stress-tests one named component or screen area — read its code, plan adversarial interactions (edge cases, repeated/rapid/out-of-order actions), then prove or disprove each. Use when the user says "/smoke" or "/qa", or asks to smoke test, verify in-browser, or sanity-check something just shipped (delivered mode), or to stress-test, QA, or thoroughly test a specific component/feature/page, or says it "feels flaky" (component mode).
---

# smoke

Verify the app actually works, live, in the browser — not just tests passing.

## Pick the mode

- **Delivered** (default) — the request is about work just shipped (a diff, a branch, done cards). Checks known flows still pass.
- **Component** — the request names one component/screen to stress-test, or reports a vague "feels flaky" with no repro. Adversarial: invents its own interaction list from the component's state machine.

If the request fits neither clearly, ask.

## Steps

1. **Scope.**
   - *Delivered:* find what was just delivered. If the repo has a `brd` board, `brd list --status done` lists delivered cards; `git log`/`git diff` the matching branch against the target branch for what changed. The brd lookup is optional — without a board, or if the user names a branch, go straight to `git log`/`git diff` against the target branch. List concrete user-facing flows to exercise (page X loads, button Y does Z, form W validates).
   - *Component:* identify the exact component or screen area under test. Don't widen scope to "the whole page" unless asked; a focused pass finds more than a shallow sweep of everything.
   If scope is ambiguous, ask.

2. **Component mode only: read the source, then plan.**
   - Read the component's actual source before planning anything: its server component (`.py`/`.pjx` or framework equivalent), any co-located client JS/CSS, the routes/handlers it posts to, and any shared primitives it wraps (a popover/select/tooltip/modal primitive, a reactive-key wiring, an htmx trigger). Reason about its real state machine — what states it can be in, what triggers each transition — not just what it visually appears to do.
   - Write a concrete list of `{action, expected}` pairs before opening a browser. Cover, at minimum:
     - **Happy path** — one clean pass end to end, as the baseline to compare failures against.
     - **Boundary/edge states** — empty vs. populated, zero/one/many items, min/max-length input, first vs. last item in a list.
     - **Repeated and rapid interactions** — reopen a panel after it already mutated state, double-click a toggle, submit twice, click a control before its prior async work (a swap, a fetch) has settled. Stale-state and positional bugs hide here.
     - **Out-of-order / interrupted sequences** — cancel mid-flow, navigate away and back, browser back/forward, resize the viewport mid-interaction.
   - Weight the plan toward interactions nobody would manually try twice in a row over more happy-path variations. Don't improvise mid-session — improvised probing reports "seems fine" because it never tried the interaction that breaks it.

3. **Claim the shared-browser lock.** The Claude in Chrome extension drives one shared browser, and localhost cookies aren't port-scoped — two concurrent sessions hitting different ports on the same host can stomp each other's session cookies, causing spurious mid-flow logouts that look like app bugs but aren't. Before touching containers or `mcp__claude-in-chrome__*`:
   - Resolve the repo root: `git rev-parse --path-format=absolute --git-common-dir | xargs dirname`. Lock file lives at `<repo-root>/.claude/smoke.lock`.
   - `cat` it if present. If it names a session/job that's still active (ask the user if unsure — they can see their job list), do not proceed to browser driving; either wait or ask the user how to sequence with that session.
   - If absent, or present but stale/released, claim it: write `session=<your session name or job id>\nstarted_at=<date -u +%FT%TZ>\nstatus=active\n` to the file.
   - Advisory, not enforced — it only works if every run checks it. If you discover another session mid-run despite the lock (e.g. the user tells you), stop driving the browser and hand off/serialize rather than racing further requests.

4. **Get a running stack.**
   - *Delivered:* rebuild. Invoke the `build` skill (or run its steps directly: bump host ports +100 in `docker-compose.yml`, `docker compose build`, `docker compose up -d`) to dodge port conflicts with any stack already running. Report the resulting host ports.
   - *Component:* don't rebuild by default. Confirm the stack is up and healthy via `docker compose ps`; invoke `build` only if it isn't.
   - If `docker compose up` fails because a shifted port is still taken, report the conflict — don't keep guessing offsets.
   - Watch container logs for startup errors before treating a freshly started stack as ready: `docker compose logs --tail=100`.

5. **Load the Claude in Chrome tools.** Before any `mcp__claude-in-chrome__*` call, load them in one batched `ToolSearch`:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__javascript_tool`
   Call `tabs_context_mcp` first, then open a new tab pointed at the stack's port — never reuse tab IDs from an earlier session.

6. **Drive.** Delivered: each flow from step 1. Component: each planned interaction from step 2, in order.
   - Navigate, interact (click/type/submit) via `computer`/`form_input`, then verify with `read_page` and `read_console_messages` (filter with a `pattern` for the relevant component/module rather than reading everything). Check `read_network_requests` for the requests your interactions actually fired — failed/unexpected calls (4xx/5xx, missing HTMX OOB swaps) — rather than assuming a click did what it looked like.
   - Avoid triggering JS `alert`/`confirm`/`prompt` dialogs — they block the extension.
   - If a page/element doesn't respond after 2-3 attempts, stop retrying that item, record it as a finding, and move to the next rather than looping.
   - *Component mode additionally:*
     - Don't stop at "looks right" in a screenshot. Use `zoom` for pixel-level detail, and `javascript_tool` to pull `getBoundingClientRect()`/`getComputedStyle()`/DOM state when a claim is about position, sizing, or data. A screenshot can look plausible while the element is 300px off.
     - When something looks wrong, drill down before recording it: zoom into the exact region, inspect computed styles or network calls, and correlate against the source from step 2 to name a suspected cause.
     - If a fix hypothesis forms mid-pass, test it live: inject a temporary `<style>` or DOM patch via `javascript_tool` and re-verify, before touching source.
     - Undo any state you created (draft rows, chips, published field/config changes) so the app is left as found — unless the user asked you to fix forward.

7. **Report.** One entry per flow (delivered) or planned interaction (component):
   ```
   ### <flow or interaction>
   - **Status:** pass | fail | partial
   - **Steps:** what was actually clicked/typed/navigated
   - **Expected:** ...
   - **Actual:** ...
   - **Evidence:** the shortest decisive proof — a console/network line, a computed-style value, a zoomed screenshot region — not a full dump
   - **Suspected cause / file:line:** if failed, point at the likely source
   ```
   Order failures first; group by severity if there are several. No praise or narration for passing entries beyond the one-line status.
   *Component mode:* close with one paragraph — overall verdict and the single top recommendation (fix now, defer, or needs a product decision) with a one-line rationale.

8. **Do not fix anything during the pass unless the user asks** — the deliverable is the report; iterating on fixes is a separate step after it lands. Release the lock from step 3 (delete the file or overwrite with `status=released`) whether the pass finished cleanly or was aborted — a stale "active" lock blocks the next session for no reason.

## Notes

- This is browser-driven verification, not a replacement for the test suite — it catches integration/rendering issues tests miss (real container wiring, real HTMX swaps, real console errors).
