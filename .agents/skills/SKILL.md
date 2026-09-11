---
name: karpathy-guidelines
description: Behavioral guidelines for careful, simple, verifiable coding. Use when writing, reviewing, or refactoring code to surface assumptions, make surgical changes, avoid overcomplication, define success criteria, and track project progress when a PRD exists.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

    [Step] → verify: [check]
    [Step] → verify: [check]
    [Step] → verify: [check]


Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Track PRD Progress

**When a project has a PRD, keep its progress visible and current.**

- At session start, look for the PRD and an existing progress tracker.
- If no tracker exists, create `PROGRESS.md` at the project root.
- Reuse `TODO.md`, `ROADMAP.md`, or an issue tracker if one is already authoritative - don't duplicate.
- Keep these sections up to date:

  ```md
  # Project Progress

  ## Done
  - [x] Verified completed work

  ## Remaining
  - [ ] Actionable unfinished work

  ## Ideas
  - Possible improvement or follow-up

    Update the tracker: at session start, after each meaningful task or milestone, and before ending a session.
    Record work as done only after verifying it (see §4). Move items from Remaining to Done as they complete.
    Use Remaining to build the plan required by §4.
    Capture ideas in Ideas without implementing them. Ideas need explicit user approval before becoming tasks.
    No PRD? Don't create a progress tracker for trivial tasks.
