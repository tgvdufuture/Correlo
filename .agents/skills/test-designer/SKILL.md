---
name: test-designer
description: Designs a focused, executable test plan from a task's requirements, acceptance criteria, changed files, and review findings. Use when planning tests, mapping acceptance criteria to unit/integration/E2E/manual checks, choosing the right test level, identifying edge cases, assessing regression risk, or checking whether an implementation is actually verifiable. Does not implement or debug tests.
license: MIT
---

# Test Designer

Design the smallest set of tests that can prove whether one implementation satisfies its task.

AI-written code is cheap; unverified code is expensive. A change is not done until something concrete shows it works and that nothing critical broke. This skill covers the *design* step only, deliberately separate from implementation: deciding what to verify **before** writing tests stops an agent from reverse-engineering tests that merely restate whatever the code happens to do.

**Tradeoff:** this favors verifiable correctness over speed and over broad coverage. It produces a test plan for one task, not a testing strategy for the project.

## 0. Inspect the repository first

Answer your own intake questions from the code before asking the user:

- Test scripts and commands (`package.json`, `Makefile`, `pyproject.toml`, CI config)
- Test config and conventions (folders, naming, fixtures, factories, helpers)
- The files the task changed, and the tests nearest to them
- Existing tests covering the same area

Use the test command you find. Inventing a command that doesn't exist guarantees the plan can't run.

## 1. Intake

**Required** — if genuinely missing, state a labeled assumption rather than blocking:

- The task and the behavior it should produce
- Acceptance criteria (or an explicit "none given")
- Files changed / implementation summary
- The test framework and how to run it

**Optional** — use when present:

- PRD section, architecture plan, task plan
- Code review output
- Known risks, existing tests

If the expected behavior can't be determined even approximately, stop and ask. Tests designed against a guess confidently verify the wrong thing.

## 2. Test selection heuristics

Pick the **lowest level that can catch the failure you care about**. Higher levels cost more to run, break more often, and localize failures worse.

| Level       | Reach for it when…                                              | Watch out for |
|-------------|-----------------------------------------------------------------|---------------|
| Unit        | logic is isolated, pure, or cheap to instantiate                | tests coupled to internals |
| Integration | correctness depends on a boundary (DB, HTTP, filesystem, seam)  | slow/flaky setup, shared state |
| E2E         | the risk only appears in the assembled product / user-visible flow | slowest, most brittle; keep to critical paths |

**Oracle — assert observable behavior.** Write the assertion against what the task promises (return value, emitted event, persisted row, rendered text), not against how it's implemented. If a refactor that preserves behavior would break the test, the oracle is wrong.

**Determinism.** Control the four usual flake sources: time, randomness, network, and shared state. Inject a clock, seed generators, stub or record external calls, and isolate fixtures per test. A test that passes twice in a row and fails in CI is not passing.

**Test data.** Cover representative values plus the boundaries: empty, single item, min/max, off-by-one, duplicate, unicode, null/undefined. Name the data so a failure is readable.

**State & permissions.** Test transitions, not just a resting state: invalid input after valid input, retry after failure, and the unauthorized actor hitting the same endpoint.

**Waiting.** Never `sleep`. Wait on a condition (a DOM locator, a promise, polling an assertion) so the test fails fast and for the right reason.

**One reason to fail.** Each test should break for exactly one cause. A test asserting five things reports one unhelpful failure.

## 3. Workflow

1. Restate the behavior under test in one sentence.
2. Map every acceptance criterion to at least one test.
3. Choose a level for each using §2.
4. Identify critical edge cases and state transitions.
5. Pull regression risks from the code review or diff.
6. Confirm the framework and conventions from §0.
7. Split automatable checks from those that must stay manual.
8. Define data, expected results, and what a failure means.
9. Hand off the plan (see §6).

## 4. Output format

```txt
Test Plan — [Task Name]

Behavior under test:
[One sentence]

Test strategy:
- [Why these levels, in one or two lines]

Acceptance criteria coverage:
- AC1: TST-01
- AC2: TST-02

Automated tests:

TST-01 — [Specific test name]
Level: Unit / Integration / E2E
File: [path]
Proves: [what this catches]
Setup: [state, fixtures, controls]
Input: [values]
Expected: [observable result]
Failure means: [what a red run indicates]

Manual validation:

MAN-01 — [Check name]
Why not automated: [reason]
Steps: 1. … 2. …
Expected: [observable result]

Edge cases:
- [Case] → [Expected behavior]

Regression checks:
- [Existing behavior to re-verify]
```

## 5. Filled example

```txt
Test Plan — Chat message submit

Behavior under test:
Submitting the composer appends the message to the thread and clears the input;
an empty or whitespace-only message is rejected; a failed request shows a retryable error.

Test strategy:
- Unit for submit-guard logic (cheap, no DOM).
- Integration for the thread state update + API call.
- One E2E for the user-visible happy path only.

Acceptance criteria coverage:
- AC1 (valid message appears): TST-02, TST-04
- AC2 (empty blocked): TST-01, TST-03
- AC3 (error is recoverable): TST-05, MAN-01

Automated tests:

TST-01 — Whitespace-only input is rejected
Level: Unit | File: src/chat/composer.test.ts
Proves: AC2 guard handles trimming.
Setup: None. Controls: none (pure).
Input: "   "
Expected: submit() returns false; onChange not called.
Failure means: the compositor accepts blank messages.

TST-03 — Composer with empty input disables submit
Level: Integration | File: src/chat/Composer.test.tsx
Proves: AC2 at the UI boundary.
Setup: Render Composer with empty value.
Input: none
Expected: submit control is disabled; no request issued.
Failure means: UI bypasses the domain guard.

TST-02 — Valid message is appended and input cleared
Level: Integration | File: src/chat/thread.test.ts
Proves: AC1 core behavior.
Setup: Fake clock, empty thread, stubbed POST returning 201.
Input: "hello"
Expected: thread has one message {text:"hello"}; composer value "".
Failure means: message lost or input not cleared.

TST-05 — Failed POST surfaces a retryable error
Level: Integration | File: src/chat/thread.test.ts
Proves: AC3 error path.
Setup: Stubbed POST returning 500.
Input: "hello"
Expected: message marked failed; retry affordance present; input not cleared.
Failure means: silent data loss on network error.

TST-04 — Send a message end to end
Level: E2E | File: e2e/chat.spec.ts
Proves: the assembled product works, not just the units.
Setup: Seeded logged-in session.
Input: type "hello", click Send
Expected: message visible in the thread; composer empty.
Failure means: wiring/integration regression.

Manual validation:

MAN-01 — Reconnect recovery
Why not automated: requires a real dropped connection and re-auth.
Steps:
1. Enter a message while offline.
2. Submit, observe the failed state.
3. Reconnect and retry.
Expected: the message sends once, with no duplicate.

Edge cases:
- "" → rejected, no request
- 10k-char message → accepted or truncated per spec, never silently dropped
- rapid double-submit → exactly one message
- unicode/emoji → preserved byte-for-byte

Regression checks:
- Existing thread pagination still loads history on mount.
```

## 6. Handoff

End with the test plan and a recommended next skill, **if available** in this environment:

- a bug-fix skill when the plan reveals failures to fix
- a code-review skill when the plan exposes ambiguous expected behavior
- a release/review skill when everything passes and the phase closes

Use this prompt to hand the plan to an implementation or bug-fixing agent:

```txt
You are implementing validation for one change only.

Task:
[PASTE TASK]

Acceptance criteria:
[PASTE ACCEPTANCE CRITERIA]

Behavior under test:
[ONE SENTENCE]

Test plan:
[PASTE THE TEST PLAN, INCLUDING TEST IDS, LEVELS, FILES, INPUTS AND EXPECTED RESULTS]

Implementation summary / files changed:
[PASTE]

Test framework and command:
[PASTE THE COMMAND YOU FOUND IN THE REPO]

Known risks:
[PASTE]

Create the listed automated tests, preserving the IDs and file paths from the plan.
Run the detected test command. Report results per test ID, with the raw failure
output for any red test. Do not add tests beyond the plan; if the plan looks
incomplete, say so instead of expanding scope.
```

## 7. Done when

- The behavior under test is stated in one sentence.
- Every acceptance criterion maps to a test ID.
- Each planned test has a level, a concrete oracle, and a stated failure meaning.
- Edge cases and state transitions are listed.
- Regression checks are included.
- Manual checks appear only where automation is impractical, each with a reason.
- No test verifies behavior outside the task.
- No requirement was invented.

Forbidden placeholders, and why: "Test that it works", "Check the UI", "Validate backend", "Ensure everything is fine", "Test error handling". Each names an activity instead of an observable result, so the resulting test can only assert that time passed. Prefer: "Empty message does not submit", "Valid message appears in thread after submit", "API failure displays fallback error state".
