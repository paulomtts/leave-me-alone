"""Template for a prompt benchmark harness. Copy this into the target repo
(e.g. `scripts/bench/bench_<prompt>.py`) and fill in the marked spots.

This drives ONE prompt directly against hand-built input and scores what the
model returns, over repeats. It is not a test and does not belong in a test
tier: it calls the real model, costs money per run, and is stochastic on
purpose — that's exactly why it exists. Nothing in a deterministic test suite
can tell you whether a prompt works, only whether the code around it does.

  uv run python scripts/bench/bench_<prompt>.py
  uv run python scripts/bench/bench_<prompt>.py --repeats 8 --case stale-anchor
"""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from typing import Callable, Union

REPEATS = 5

# --- 1. Wire in the real prompt call ---------------------------------------
#
# Import the actual prompt template / client call from the app, and write a
# thin async wrapper that: builds the prompt from a case's input, calls the
# model, and returns the parsed result. Nothing upstream (retrieval,
# candidate assembly, adapters) should run here — only the prompt and the
# model.
#
#   from app.adapters.agent.tools.respond import _REVIEW_TEMPLATE, call_llm
#
#   async def call_prompt_directly(case_input):
#       return await call_llm(_REVIEW_TEMPLATE, **case_input)


async def call_prompt_directly(case_input):  # placeholder — replace me
    raise NotImplementedError("wire this to the real prompt + model call")


# --- 2. Build small, readable stubs -----------------------------------------
#
# A `stub(...)` helper keeps cases declarative instead of repeating full
# input objects. Shape it to whatever the prompt actually consumes.
#
#   def stub(name, columns, *, rows=12):
#       return TableStub(name=name, columns=columns, entry_count=rows)


def stub(**kwargs):  # placeholder — replace me
    return dict(kwargs)


# --- 3. Cases ----------------------------------------------------------------

Expectation = Union[object, Callable[[object], bool]]


@dataclass
class Case:
    name: str
    input: object
    expect: Expectation
    why: str  # what this case is actually probing — read this before rewriting the prompt


def satisfies(expect: Expectation, result) -> bool:
    if callable(expect):
        return bool(expect(result))
    return result == expect


CASES: list[Case] = [
    # Case(
    #     name="stale-anchor-new-subject",
    #     input=stub(...),
    #     expect=lambda r: r.relevant is False,
    #     why="a table anchored from an earlier turn must not leak into an unrelated question",
    # ),
]


# --- 4. Repeat + verdict -----------------------------------------------------


async def run_case(case: Case, repeats: int) -> tuple[str, int, int]:
    results = await asyncio.gather(
        *(call_prompt_directly(case.input) for _ in range(repeats)),
        return_exceptions=True,
    )
    verdicts = [r for r in results if not isinstance(r, Exception)]
    errors = [r for r in results if isinstance(r, Exception)]
    if errors and not verdicts:
        # A transport failure (expired key, exhausted quota, network) is not
        # a verdict on the prompt. Reporting it as FAIL reads as a prompt
        # regression and sends the next debugging session to the wrong file.
        return "ERROR", 0, repeats
    score = sum(1 for r in verdicts if satisfies(case.expect, r))
    mark = "PASS" if score == len(verdicts) else ("FLAKY" if score else "FAIL")
    return mark, score, len(verdicts)


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeats", type=int, default=REPEATS)
    parser.add_argument("--case", default="", help="substring filter on case names")
    args = parser.parse_args()

    cases = [c for c in CASES if args.case in c.name]
    if not cases:
        print(f"no cases match --case={args.case!r}")
        return 1

    broken = False
    for case in cases:
        mark, score, total = await run_case(case, args.repeats)
        tally = "—" if mark == "ERROR" else f"{score}/{total}"
        print(f"{mark:6} {tally:5}  {case.name}  —  {case.why}")
        if mark != "PASS":
            broken = True

    return 1 if broken else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
