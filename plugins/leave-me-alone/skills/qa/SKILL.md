---
name: qa
description: Stress-test one component or screen area — read its actual code first, plan a concrete list of interactions (happy path, edge cases, repeated/rapid/out-of-order actions) against expected behavior, drive them live via Claude's Chrome extension, and report findings with a recommendation. Use when the user says "/qa" or asks to stress-test, QA, or thoroughly test a specific component/feature/page (as opposed to verifying a just-delivered diff — see `smoke` for that).
---

# qa

Find out how a component actually breaks, not just whether the one path someone tried works. Predict failure modes from the code before touching a browser, then prove or disprove each one live.

## Steps

1. **Scope the target.** Identify the exact component or screen area under test — from the user's message, or by asking if it's ambiguous. Don't widen scope to "the whole page" unless asked; a focused pass finds more than a shallow sweep of everything.

2. **Acquire context.** Read the component's actual source before planning anything: its server component (`.py`/`.pjx` or framework equivalent), any co-located client JS/CSS, the routes/handlers it posts to, and any shared primitives it wraps (a popover/select/tooltip/modal primitive, a reactive-key wiring, an htmx trigger). The goal is to reason about its real state machine — what state it can be in, what triggers a transition — not just what it visually appears to do. This is where interaction-breaking bugs get predicted instead of stumbled into.

3. **Plan interactions before opening a browser.** Write a concrete list of `{action, expected}` pairs. Cover, at minimum:
   - **Happy path** — one clean pass end to end, so there's a working baseline to compare failures against.
   - **Boundary/edge states** — empty vs. populated, zero/one/many items, min/max-length input, the first item vs. the last item in a list.
   - **Repeated and rapid interactions** — reopen a panel after it already mutated state, double-click a toggle, submit twice, click the same control before its prior action's async work (a swap, a fetch) has settled. This is where stale-state and positional bugs hide — exactly the class of bug a single-pass functional check misses.
   - **Out-of-order / interrupted sequences** — cancel mid-flow, navigate away and back, browser back/forward, resize the viewport mid-interaction.
   List every planned interaction now. Don't improvise mid-session — improvised probing produces a report that says "seems fine" because it never tried the interaction that actually breaks it.

4. **Claim the shared-browser lock.** This uses the same Claude in Chrome extension and the same single shared browser as the `smoke` skill, with the same session-cookie collision risk. Reuse `smoke`'s lock file rather than a separate one — two skills racing two different lock files defeats the point:
   - Resolve the repo root: `git rev-parse --path-format=absolute --git-common-dir | xargs dirname`. Lock file is `<repo-root>/.claude/smoke.lock`.
   - `cat` it if present; if it names a still-active session, wait or ask the user how to sequence rather than proceeding.
   - If absent or stale, claim it: `session=<your session/job id>\nstarted_at=<date -u +%FT%TZ>\nstatus=active\n`.
   - Release it (delete, or set `status=released`) when the pass ends or is aborted — don't leave it dangling.

5. **Load the Claude in Chrome tools**, batched in one `ToolSearch` call before the first browser action:
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__javascript_tool`
   Call `tabs_context_mcp` first, then open a new tab — never reuse tab IDs from an earlier session.

6. **Execute the plan.** For each interaction: navigate/act (`computer`, `form_input`), then verify — don't stop at "does it look right" in a screenshot. Use `zoom` for pixel-level detail, and `javascript_tool` to pull `getBoundingClientRect()`/`getComputedStyle()`/DOM state when a claim is about position, sizing, or data, not just appearance. A screenshot can look plausible while the underlying element is 300px off from where it should be.
   - When something looks wrong, drill down before recording it: zoom into the exact region, inspect computed styles or network calls, and correlate against the source read in step 2 to name a suspected cause — not just "looks off."
   - If a fix hypothesis forms mid-pass, test it live first: inject a temporary `<style>` or DOM patch via `javascript_tool` and re-verify, before touching source. This confirms the theory cheaply and separates diagnosis from fixing.
   - Undo any state you created during testing (draft rows, chips, published field/config changes) so the app is left as found — unless the user asked you to fix forward. Check `read_network_requests` for the actual requests your interactions fired; don't assume a click did what it looked like it did.
   - If a page/element doesn't respond after 2-3 attempts, stop retrying that one interaction, record it as a finding, and move to the next rather than looping.

7. **Report.** One entry per planned interaction from step 3:
   ```
   ### <interaction>
   - **Status:** pass | fail
   - **Steps:** what was actually clicked/typed/navigated
   - **Expected:** ...
   - **Actual:** ...
   - **Evidence:** the shortest decisive proof — a computed-style value, a network status line, a zoomed screenshot region — not a full dump
   - **Root cause / file:line:** if failed, point at the likely source
   ```
   Order failures first; group by severity if there are several. Close with one paragraph: overall verdict and the single top recommendation — fix now, defer, or needs a product decision — with a one-line rationale. Don't pad passing entries with praise.

8. **Do not fix anything during the pass itself unless the user asks.** The deliverable is the report. Release the lock from step 4 as part of wrapping up, whether the pass finished cleanly or was aborted.

## Notes

- Not the same as `smoke`: `smoke` verifies that specific, already-known just-delivered flows still pass. `qa` is adversarial and exploratory — it invents its own interaction list from a component's actual state machine, aimed at surfacing what nobody thought to check yet. Use `smoke` after a fix ships; use `qa` when someone asks "is this component actually solid" or reports a vague "this feels flaky" complaint with no concrete repro yet.
- The interaction most likely to find a real bug is usually the one nobody would think to manually try twice in a row — reopening a panel after it mutated state, clicking a trigger before its own prior request settled, resizing mid-animation. Weight the plan in step 3 toward those over more happy-path variations.
