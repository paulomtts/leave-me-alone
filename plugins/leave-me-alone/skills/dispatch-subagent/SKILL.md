---
name: dispatch-subagent
description: Dispatch a subagent with a specific model and a set of instructions passed as arguments. Use when the user says "/dispatch-subagent", or asks to "dispatch a subagent with model X to do Y" / "spin up an agent on <model>" with an explicit model name and task description.
---

# dispatch-subagent

Launch a single subagent pinned to a specific model, running a task described in plain language.

## Parsing the arguments

Input is `<model> <description>`. The model is often typed as a quoted, multi-word
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
   - Anything still unrecognized after normalizing: ask the user to clarify
     rather than guessing.
3. Everything after the extracted model name is the description — pass it
   through as the agent's task, expanded with any context from the current
   conversation the subagent would otherwise lack (file paths, prior findings,
   constraints already discussed). Don't invent scope the user didn't ask for.

If the description is missing (only a model name given), ask what the subagent should do.

## Dispatching

Call the Agent tool with:
- `model`: the mapped value from step 1
- `prompt`: the expanded description
- `subagent_type`: `general-purpose` unless the description clearly matches a more specific agent type already available (e.g. `Explore` for a pure search task)
- `description`: a short 3-5 word label for the task

Default to `run_in_background: true` (the Agent tool's default) unless the user's phrasing implies they need the result before continuing this turn (e.g. "and tell me what it finds" in the same breath as other blocking work) — then pass `run_in_background: false`.

## Example

User: `/dispatch opus review the auth middleware in src/auth.py for security issues`

→ `Agent({ model: "opus", description: "Review auth middleware security", prompt: "Review src/auth.py's auth middleware for security issues. Report findings with file:line references." })`

## Common mistakes

- Guessing at a model name that isn't in the enum (`sonnet`, `opus`, `haiku`, `fable`) instead of asking — this silently falls back to the wrong model.
- Taking "first whitespace-separated token" literally when the model is a quoted multi-word name (`"Fable 5"`) — that grabs `"Fable` and fails to match, so the dispatch silently drops the model override. Strip quotes and internal spaces before matching, per the parsing rule above.
- Passing the raw description straight through when it depends on context only visible in this conversation (e.g. "fix the bug we just found") — the subagent starts with no memory of this conversation, so resolve such references before dispatching.
