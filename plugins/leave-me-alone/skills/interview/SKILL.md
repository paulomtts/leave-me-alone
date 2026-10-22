---
name: interview
description: Interview the user about the open questions, ambiguities and undecided choices in the immediate context, one at a time, using the AskUserQuestion option-picker UI, with a plain-language explanation and a recommended option for each. Use when the user says "/interview", "interview me", "ask me the open questions", "what do you still need to know", or wants to settle decisions before work starts.
---

# interview

Surface the open questions in the current context and settle them with the user through the `AskUserQuestion` tool (the multiple-choice question UI). The output is a set of decisions, not a document.

## 1. Find the open questions

Look only at the immediate context: the conversation so far, the task at hand, and the files or specs in play. Collect what is genuinely undecided and would change what you do next:

- ambiguities in the request or spec
- choices between approaches with real trade-offs
- assumptions you would otherwise have to guess
- conflicts between what was asked and what the code or docs show

Resolve anything you can from the code, docs or sensible defaults yourself, and skip it. Do not ask about conventional choices or facts you can verify. If there are no real open questions, say so and stop.

Order the questions so earlier answers inform later ones (foundational decisions first). If an answer makes a later question moot, drop it.

## 2. Ask with AskUserQuestion

`AskUserQuestion` may be a deferred tool: load its schema with `ToolSearch` (`select:AskUserQuestion`) before the first call.

Ask 1-4 related questions per call; use further calls for later or dependent questions. For every question:

- **Explain first, for a beginner.** The `question` text must say, in plain words and without jargon, what the decision is about and why it matters. If a term is unavoidable, define it in a few words. Lead with the consequence ("This decides whether X happens automatically or only when you ask"), not the mechanism.
- **Make options concrete.** 2-4 distinct options. Each `description` states what happens if chosen and its main trade-off, in plain language. Do not add an "Other" option; the UI provides it.
- **Always recommend one.** Put the recommended option first and end its label with `(Recommended)`. Begin its description with a short reason ("Simplest, and fits what you described").
- Use `header` for a short tag (max 12 chars) and `multiSelect: true` only when choices are not mutually exclusive.
- If no option is clearly better, still pick one and say why it is only a slight edge.

## 3. Close the loop

After each answer, check whether it opens or closes other questions, and adjust the list. When all are answered, give a brief recap: each question and the decision, one line each. Then continue with the original task using those decisions, unless the user only wanted the interview.

## Common mistakes

- Asking questions you could answer by reading the code or using a sensible default.
- Jargon-heavy question text; assume the reader is new to the topic.
- Listing options with no recommendation, or putting the recommended option anywhere but first.
- Dumping every question at once instead of ordering them so answers inform the next ones.
- Writing the questions out as chat text instead of using `AskUserQuestion`.
