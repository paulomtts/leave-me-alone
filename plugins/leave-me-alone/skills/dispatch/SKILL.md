---
name: dispatch
description: Dispatch a subagent (Sonnet by default, or a model passed as an argument) to investigate and fix something, or to do the task described in the arguments. Use when the user says "/dispatch", or asks to "dispatch a subagent (with model X) to do Y" / "spin up an agent on <model>".
---

# dispatch

Launch a single subagent running a task described in plain language. The model defaults to **Sonnet**; pass a model name first to override it. Unless the arguments say otherwise, the subagent's main goal is to **investigate and fix** the problem described.

## Parsing the arguments

Input is `[<model>] <description>`. The model is optional. It is often typed as a quoted, multi-word
name (`"Fable 5"`, `"Opus 5"`, `"Claude Opus 5"`) — extracting it is NOT simply
"the first whitespace-separated token," which would grab `"Fable` (stray quote,
missing `5`) and match nothing.

1. Extract the model name:
   - If the arguments start with a quoted string (`"..."`), that whole quoted
     string — quotes stripped — is the model name, regardless of how many words
     it contains. Everything after the closing quote is the description.
   - Otherwise, the model name is the first whitespace-separated token only.
2. Normalize before matching: lowercase, strip surrounding whitespace, and strip
   any internal spaces/dots/hyphens (`"Opus 5"`, `"opus-5"`, `"opus.5"` all fold
   to `opus5`). Then map to the Agent tool's `model` param:
   - `sonnet` / `sonnet5` / `claudesonnet5` → `sonnet`
   - `opus` / `opus5` / `claudeopus5` → `opus`
   - `haiku` / `haiku45` / `claudehaiku45` → `haiku`
   - `fable` / `fable5` / `claudefable5` → `fable`
   - If the arguments do not start with a quoted string and the first token does
     not match any model above, there is no model argument: use `sonnet` and treat
     the entire input as the description.
   - If the arguments start with a quoted string that is not a known model, ask
     the user to clarify rather than guessing.
3. Everything after the extracted model name (or the whole input, when no model
   was given) is the description — pass it
   through as the agent's task, expanded with any context from the current
   conversation the subagent would otherwise lack (file paths, prior findings,
   constraints already discussed). Don't invent scope the user didn't ask for.

If the description is missing (only a model name given, or nothing at all), ask what the subagent should do.

## Default goal: investigate and fix

Unless the description explicitly asks for something else (e.g. "only review", "just report", "write a plan", "research X"), frame the agent's prompt so it:
1. Investigates the root cause (reproduce, read the relevant code, confirm the cause rather than guessing).
2. Fixes it with the smallest change that addresses the cause, verifying with the repo's tests or checks.
3. Reports what it found, what it changed (file:line), and how it verified the fix.

If the description is read-only in nature, respect that and do not add the fix step.

## Dispatching

Call the Agent tool with:
- `model`: the mapped value from step 2, or `sonnet` when none was given
- `prompt`: the expanded description
- `subagent_type`: `general-purpose` unless the description clearly matches a more specific agent type already available (e.g. `Explore` for a pure search task)
- `description`: a short 3-5 word label for the task

Default to `run_in_background: true` (the Agent tool's default) unless the user's phrasing implies they need the result before continuing this turn (e.g. "and tell me what it finds" in the same breath as other blocking work) — then pass `run_in_background: false`.

## Examples

User: `/dispatch login redirects to /undefined after OAuth callback`

→ `Agent({ model: "sonnet", description: "Fix OAuth redirect bug", prompt: "Investigate why login redirects to /undefined after the OAuth callback. Find the root cause, fix it with the smallest change, verify with the relevant tests, and report findings, changes (file:line) and verification." })`

User: `/dispatch opus review the auth middleware in src/auth.py for security issues`

→ `Agent({ model: "opus", description: "Review auth middleware security", prompt: "Review src/auth.py's auth middleware for security issues. Report findings with file:line references." })`

## Common mistakes

- Treating the first word of the description as a model name when none was given (`/dispatch login is broken` has no model: default to `sonnet`).
- Dropping the fix step: the default goal is investigate **and fix**, not just report.
- Guessing at a model name that isn't in the enum (`sonnet`, `opus`, `haiku`, `fable`) instead of asking — this silently falls back to the wrong model.
- Taking "first whitespace-separated token" literally when the model is a quoted multi-word name (`"Fable 5"`) — that grabs `"Fable` and fails to match, so the dispatch silently drops the model override. Strip quotes and internal spaces before matching, per the parsing rule above.
- Passing the raw description straight through when it depends on context only visible in this conversation (e.g. "fix the bug we just found") — the subagent starts with no memory of this conversation, so resolve such references before dispatching.
