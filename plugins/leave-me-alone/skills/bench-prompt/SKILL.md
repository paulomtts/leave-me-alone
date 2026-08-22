---
name: bench-prompt
description: Build or extend a benchmark harness that drives an LLM prompt directly against hand-built synthetic input and scores what comes back over repeats — for validating prompt-engineering changes (wording, few-shot examples, output-shape rules) before or after landing them. Use when the user asks to benchmark a prompt, check whether a prompt change actually helped, or wants confidence a prompt behaves before shipping it — not for anything that belongs in the normal test tiers.
---

# bench-prompt

A prompt is the one part of an LLM pipeline the normal test suite can't grade: the code around
it can be fully covered and the prompt can still be vague, contradictory, or quietly broken by a
model swap. This skill is how to build (or extend) a harness that calls the real model against
synthetic cases and scores it, so a prompt change is *shown* to help rather than assumed to.

This is a **spike**, not a feature. If no such harness exists yet for the target prompt(s), treat
building one as bounded work: a short design (which prompts, how cases are driven, what a case
asserts) is enough — no spec file, no plan document. If the codebase has no synthetic-input
harness pattern of its own to imitate, this file is the pattern.

## When this applies, and when it doesn't

Reach for this when someone is iterating on prompt *wording* — instructions, examples, the shape
of what the model is asked to return — for a specific gate/step in an LLM-backed pipeline, and
wants evidence a change worked, not just that it "reads better."

It does not apply to:
- **Code bugs** in the pipeline around the prompt (parsing, retries, tool wiring) — that's
  `superpowers:systematic-debugging` and the normal test tiers.
- **One-off manual trying-things-in-a-chat-window** — fine for early exploration, but the moment
  the user wants to *compare* two wordings or guard against regression, build the harness.
- **Anything that should live in `tests/`.** A benchmark calls the real model, costs money per
  run, and is stochastic on purpose — repeats and FLAKY are the point. A test tier assumes
  deterministic, free, CI-safe. Never fold one into the other; say explicitly in the harness
  (README or module docstring) that it is not a test and does not belong in a tier.

## The shape of a harness

However many prompts exist in the target pipeline, drive **each one directly** — call the
function/template that builds the prompt and the client that sends it, with hand-built stub
input, bypassing everything upstream (retrieval, candidate assembly, adapters). What's under
test is the prompt's wording and the model's response to it, not the plumbing that feeds it —
plumbing already has its own tests.

For each prompt/gate in scope:

1. **A case list** — a small dataclass or plain dict per case: a name, the synthetic input
   (built with a small `stub(...)` helper so cases stay readable), and an **expectation**: either
   a fixed expected value, or a predicate function `(result) -> bool` when the correct answer has
   more than one acceptable shape (e.g. "the model must say the read failed," not "the model must
   say exactly these twelve words").
2. **A `why` field on every case.** State in one line what the case is actually probing —
   this is what lets a future reader (including you, a week later) tell a bad case from a bad
   prompt without re-deriving intent.
3. **A repeat loop.** Run each case `REPEATS` times (default 5; bump for a case you don't yet
   trust). Prompts are stochastic — a prompt right 2 times out of 3 is not fixed. Run repeats for
   one case **concurrently** (`asyncio.gather` or equivalent) so a full sweep stays fast; repeats
   exist to catch flakiness, not to serialize the run.
4. **A verdict, not a score.** Per case, after collecting repeat results:
   - **PASS** — every repeat satisfied the expectation.
   - **FLAKY** — some did, some didn't. Treat as failing — do not report a prompt as working
     because it passed most of the time.
   - **FAIL** — none did.
   - **ERROR** — the call never reached the model (expired key, exhausted quota, network,
     transport exception). Report this as its own category, distinct from FAIL — a transport
     failure printed as FAIL reads as a prompt regression and sends the next debugging session
     down the wrong path.
5. **A CLI** with at minimum `--repeats`, a way to select a subset of gates/prompts, and
   `--case <substring>` to filter to one case while iterating on it.

## Before claiming a case is wrong, suspect the case first

When a case comes back red, there are exactly two possibilities and they are not equally likely
on a fresh case: the prompt is wrong, **or the expectation is wrong**. Check the expectation
first. Read what the model actually returned before touching the prompt — a harness's own early
runs typically find more bad expectations than bad prompts, because writing a correct synthetic
expectation is itself easy to get wrong (an edge case that's genuinely ambiguous, a predicate
that's stricter than the real requirement, a case that assumed a code path the model doesn't
actually take). Only rewrite the prompt once you've confirmed the model's answer, not the case,
is what's wrong.

## Before claiming a prompt change helped

Run the **same cases against the prompt as it was**, not just the new wording:

```
git stash                                # or: git checkout <commit>~1 -- path/to/prompts.py
uv run python path/to/bench_x.py --gate N
git stash pop                            # or: git checkout HEAD -- path/to/prompts.py
```

A change that cannot fail the baseline has not been shown to do anything — some edits read like
improvements but are inert against every case you have, which means either the cases don't probe
what changed, or the change never mattered. Either way, that is a finding worth reporting, not a
result to bury: say plainly "baseline already passed this; the edit was reverted" rather than
letting a shipped-but-inert change stand uncredited for the fix.

## The model is part of what the scores describe

A prompt fix is a fix *for the model it was tuned against*. If the pipeline's model id changes
(a version bump, a provider swap), re-run the full benchmark before trusting old scores — a
prompt that scored 8/8 can collapse on a new model with zero wording changes, because the new
model reads instructions differently. Note the model id next to any score you report, and re-run
after any model change before relying on stale numbers.

## When a gate stays red under every rewording, look upstream

If a case fails no matter how many ways you phrase the prompt, stop rewriting and check what the
prompt is actually being handed. A common cause in retrieval/summarization pipelines: an upstream
step has already destroyed the information the prompt needs (e.g. a summarizer that collapses
rows to per-column statistics has thrown away the row-identity pairing a "which one" question
needs — no wording fixes that). The benchmark's real value here is *negative*: proving the prompt
isn't the bug, so the next debugging session starts in the right file.

## Worked structure (adapt names to the target pipeline)

```python
REPEATS = 5

@dataclass
class Case:
    name: str
    input: ...          # hand-built stub(s)
    expect: object       # fixed value, or predicate(result) -> bool
    why: str

CASES: list[Case] = [
    Case(name="...", input=stub(...), expect=..., why="..."),
    ...
]

async def run_case(case: Case, repeats: int) -> tuple[str, int, int]:
    results = await asyncio.gather(
        *(call_prompt_directly(case.input) for _ in range(repeats)),
        return_exceptions=True,
    )
    verdicts = [r for r in results if not isinstance(r, Exception)]
    errors = [r for r in results if isinstance(r, Exception)]
    if errors and not verdicts:
        return "ERROR", 0, repeats
    score = sum(1 for r in verdicts if satisfies(case.expect, r))
    mark = "PASS" if score == len(verdicts) else ("FLAKY" if score else "FAIL")
    return mark, score, len(verdicts)
```

Wire an `argparse` CLI around this that loops the selected cases, prints one line per case
(`mark  score/repeats  name  —  why`), and exits nonzero if anything is FAIL/FLAKY/ERROR so it
can gate a review pass without becoming a CI tier.

## Starting from a template

`reference.py` in this skill's own directory is a fillable copy of the worked structure above —
the same `Case`/`stub()`/`run_case`/CLI shape with the target-specific parts marked as
placeholders. Copy it into the target repo (e.g. `scripts/bench/bench_<prompt>.py`) and fill in
the marked spots: the real prompt-call wrapper, the `stub()` shape, and the case list. Prefer
copying and adapting it over inventing the harness shape from scratch each time.

## After the harness runs

Report verdicts plainly, gate by gate, with the `why` for anything red. If the user asked you to
land a prompt change, only report it as confirmed-helpful once you've done the baseline diff
above — "the new wording passes" is not the same claim as "the new wording fixed something the
old one didn't."
