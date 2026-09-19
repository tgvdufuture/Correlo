---
name: test-reviewer
description: Audits an entire existing test suite and safely refactors it in small, verified batches. Use when reviewing test quality, finding flaky or brittle tests, removing duplication or dead tests, improving assertions, reducing test runtime, checking missing edge cases, comparing coverage or mutation scores, or refactoring tests without losing behavioral protection. Use test-designer for a new feature or isolated implementation.
---

# Test Reviewer

Audit and improve the existing test suite without reducing its ability to detect regressions.

This skill handles **suite-wide review and refactoring**. It works in small batches, records objective before/after evidence, and stops when safety signals worsen.

Use `test-designer` when a new feature, bug fix, or isolated implementation needs a fresh test plan.

## Operating rules

- Audit first; do not edit during the initial reconnaissance.
- Refactor one cohesive batch at a time.
- Preserve observable behavior and test intent.
- Prefer fewer, stronger, deterministic tests over more weak tests.
- Never claim that coverage was preserved without before/after evidence.
- Do not change production code to make a test pass.
- Do not expand the scope to unrelated features.

## 1. Repository reconnaissance

Inspect the repository before making recommendations.

Find:

- Test commands in `package.json`, `pyproject.toml`, `Makefile`, CI files, or equivalent.
- Test frameworks and configuration.
- Unit, integration, API, component, and E2E test directories.
- Fixtures, factories, mocks, helpers, snapshots, and shared setup.
- Coverage commands and thresholds.
- Mutation-testing commands, if available.
- Test tags, projects, sharding, retries, and timeouts.
- CI-only tests and known quarantined or skipped tests.

Build an inventory containing:

```txt
Test file:
Test level:
Framework:
Number of tests:
Approximate duration:
Fixtures and external dependencies:
Coverage command:
Known failures or skips:
Suspected smells:
```

Run the existing suite before editing.

Record the exact commands, environment, result, duration, test count, skipped tests, coverage, and mutation score when available.

If the baseline suite is failing, classify each failure as:

- Existing and unrelated
- Relevant to the current batch
- Environment or infrastructure failure
- Unknown

Do not hide baseline failures inside the refactor.

## 2. Smell taxonomy

Report evidence, not vague opinions. Every finding must include a file, test name or line, observed behavior, risk, and suggested action.

### Flaky or brittle tests

Examples:

- Intermittent failures across repeated runs or CI.
- Shared mutable state between tests.
- Dependence on execution order.
- Arbitrary timeouts or unstable selectors.
- Real network, clock, randomness, or external-service dependence.
- Tests that pass locally but fail under parallel execution.

Prefer isolated fixtures, controlled clocks, deterministic data, condition-based waiting, and stable user-facing locators.

### Implementation-coupled assertions

Examples:

- Asserting private fields, internal helper calls, exact call order, or framework state.
- Mocking the entire unit under test.
- Tests that fail after an implementation-preserving refactor.

Replace these with assertions about observable behavior: returned values, persisted data, emitted events, rendered output, HTTP responses, or user-visible state.

### Duplication

Examples:

- Multiple tests proving the same behavior.
- Repeated setup that hides the actual scenario.
- Copy-pasted fixtures with small variations.
- Duplicate tests across unit and integration levels without additional protection.

Remove duplication only after confirming that the tests do not cover different boundaries, roles, data, or failure modes.

### No-op or tautological tests

Examples:

- Tests with no meaningful assertion.
- Assertions against values created by the same code under test.
- Mocks that guarantee the expected result.
- Tests that only verify a function was called without verifying the resulting behavior.
- Snapshots accepted without checking meaningful content.

Do not keep a test merely because it passes. Explain what regression it would catch.

### Giant tests with many reasons to fail

Examples:

- One test covering many unrelated workflows.
- Long setup followed by many unrelated assertions.
- A failure does not identify the broken behavior.
- A single test mixes permissions, persistence, UI, and notifications.

Split by behavior or failure reason. Preserve shared setup only when it remains readable and isolated.

### Sleeps and arbitrary timing

Examples:

- `sleep`, `waitForTimeout`, fixed delays, or retry loops without a condition.
- Tests that pass only because the environment is slow enough.

Replace delays with condition-based waits, explicit promises, polling assertions, or framework-native auto-waiting.

### Slow tests

Investigate:

- Unnecessary E2E coverage for isolated logic.
- Repeated application startup.
- Real external services where a contract or integration test is sufficient.
- Serial execution caused by shared state.
- Large fixtures created for every test.

Reduce cost without lowering the test level required by the risk.

### Dead tests

Examples:

- Tests for removed behavior.
- Permanently skipped or quarantined tests without an owner.
- Tests unreachable from the configured command.
- Duplicate files not loaded by the framework.
- Tests whose fixtures or production paths no longer exist.

Never delete a test whose purpose is unclear. First identify its intent, search for related coverage, and document the decision.

### Missing edge cases

Look for boundaries involving:

- Empty, null, undefined, or missing input.
- Minimum, maximum, and off-by-one values.
- Duplicate values.
- Unicode, whitespace, and unusual formatting.
- Invalid transitions and retries.
- Timeouts and partial failures.
- Authentication, authorization, and tenant isolation.
- Concurrent or repeated submissions.
- Pagination and empty collections.

Use `test-designer` to create tests for important missing behavior.

## 3. Prioritization rubric

Score every finding using the same criteria.

### Risk: 0–4

- `0`: Cosmetic or low-impact issue.
- `1`: Local maintenance problem.
- `2`: Can hide a normal regression.
- `3`: Can hide a user-visible or integration regression.
- `4`: Can hide data loss, security, billing, authorization, or critical workflow failure.

### Instability: 0–3

- `0`: Deterministic.
- `1`: Slow or mildly environment-sensitive.
- `2`: Repeated intermittent failure.
- `3`: Known CI or production-blocking flake.

### Maintenance cost: 0–3

- `0`: Easy to understand and change.
- `1`: Some duplication or coupling.
- `2`: Frequently breaks during normal changes.
- `3`: Expensive or dangerous to modify.

### Reach: 0–2

- `0`: Rare or isolated path.
- `1`: Important module or shared fixture.
- `2`: Critical path or widely reused setup.

Calculate:

```txt
Score = (Risk × 3) + (Instability × 2) + Maintenance cost + Reach
```

Priorities:

- `P0`: 18+ or any critical-path test that gives false confidence.
- `P1`: 12–17.
- `P2`: 6–11.
- `P3`: 0–5.

Resolve P0 and P1 findings before cosmetic improvements.

## 4. Batch strategy

A batch must be small enough to revert and understand.

Use one of these boundaries:

- One cohesive test file.
- One module or feature directory.
- Five to ten unit or integration tests.
- One to three E2E tests.
- One shared fixture or helper plus its direct consumers.

Avoid mixing unrelated features or framework migrations in one batch.

For every batch:

1. List the exact files, tests, and findings in scope.
2. Run the targeted baseline command.
3. Record pass/fail, duration, coverage, mutation score, and skips.
4. Refactor only the selected tests and supporting test utilities.
5. Do not weaken assertions or remove unclear tests.
6. Run the same targeted command again.
7. Run affected dependent tests.
8. Repeat suspected flaky tests at least three times.
9. Run the full suite before closing a high-risk batch or at the end of each work session.
10. Compare objective before/after metrics.
11. Write a batch report.
12. Continue only if all safety gates pass.

Suggested order:

1. P0 flaky, false-confidence, and security/authorization issues.
2. P1 brittle assertions, sleeps, and giant tests.
3. P1 slow shared fixtures and duplicated high-risk coverage.
4. P2 duplication and readability improvements.
5. P2/P3 dead tests and cosmetic cleanup.

## 5. Objective safety gates

Use the same command, environment, database state, and configuration before and after each batch.

Record:

- Tests passed, failed, skipped, and timed out.
- Runtime.
- Line, statement, function, and branch coverage.
- Mutation score, killed mutants, and surviving mutants when available.
- Repeated-run results for suspected flaky tests.

A batch passes only when:

- No new test failure, skip, timeout, or flake appears.
- Targeted behavior remains covered.
- Coverage for affected modules does not decrease.
- Global coverage does not decrease.
- Mutation score does not decrease when mutation testing is available.
- The same or stronger observable assertions remain.
- The full suite remains within the accepted runtime budget.

If coverage or mutation score drops:

1. Stop the batch.
2. Do not rationalize the drop as harmless.
3. Restore the previous state or add equivalent protection.
4. Re-run the baseline and post-change commands.
5. Report the cause.

If neither coverage nor mutation testing exists, only perform non-semantic, reversible refactors until an objective baseline is available. Do not delete tests or claim that coverage was preserved.

## 6. Safety guardrails

- Never delete a test whose purpose is unclear.
- Never weaken an assertion to make a test pass.
- Never replace a specific assertion with `toBeTruthy`, a vague snapshot, or a weaker status check without justification.
- Never add arbitrary sleeps, retries, or global timeouts to hide flakiness.
- Never change production behavior as part of a test cleanup.
- Never remove a mock without checking the boundary it protects.
- Never merge duplicate tests before comparing their behavior, data, permissions, and test levels.
- Never rewrite the entire suite in one batch.
- Never mark a test as fixed when it was only skipped or quarantined.
- Stop when a batch causes unexplained failures, coverage loss, mutation loss, or new flakiness.

## 7. Report format

Produce one report per batch:

```txt
Test Review Report — Batch [ID]

Scope:
- Files:
- Tests:
- Test level:
- Findings addressed:

Baseline:
- Command:
- Result:
- Passed / failed / skipped:
- Duration:
- Coverage:
- Mutation score:
- Repeated-run result:

Changes:
- [Finding ID] [Change made]
- [Finding ID] [Change made]

Verification:
- Targeted command:
- Affected tests:
- Full-suite command:
- Full-suite result:
- Coverage diff:
- Mutation diff:
- Flake check:

Safety assessment:
- Assertions preserved or strengthened:
- Tests deleted: none / list with justification
- Residual risks:
- Rollback required: yes / no

Next batch:
- [Recommended scope and reason]
```

## 8. Filled example batch report

```txt
Test Review Report — Batch B-03

Scope:
- Files: tests/chat/Composer.test.tsx
- Tests: 8
- Test level: Integration
- Findings addressed: F-12 sleep, F-13 implementation-coupled assertion,
  F-14 duplicated setup

Baseline:
- Command: pnpm vitest run tests/chat/Composer.test.tsx --coverage
- Result: passed
- Passed / failed / skipped: 8 / 0 / 0
- Duration: 11.8s
- Coverage: 91.2% lines, 84.0% branches
- Mutation score: 78.0%
- Repeated-run result: 24 / 24 passed across three runs

Changes:
- F-12: Replaced a 1000ms sleep with a condition-based DOM assertion.
- F-13: Replaced an internal state assertion with a rendered error message.
- F-14: Extracted isolated render setup without removing scenario coverage.
- No tests deleted.

Verification:
- Targeted command: passed, 8 / 8
- Affected tests: passed
- Full-suite command: pnpm test
- Full-suite result: passed, 428 / 428
- Coverage diff: lines +0.0%, branches +0.0%
- Mutation diff: +1.5%
- Flake check: 24 / 24 targeted runs passed

Safety assessment:
- Assertions preserved or strengthened: yes
- Tests deleted: none
- Residual risks: network retry behavior is covered by another batch
- Rollback required: no

Next batch:
- Review tests/chat/thread.test.ts for duplicated API fixtures and
  missing rapid-submit coverage.
```

## 9. Done when

The review is complete only when:

- The entire test suite has been inventoried.
- Every test directory and framework has a recorded baseline.
- All P0 and P1 findings are fixed, accepted, or documented with an owner.
- Refactors were completed in isolated batches.
- Every batch has a report.
- No unclear test was deleted.
- No assertion was weakened.
- No new flakiness was introduced.
- Affected coverage did not decrease.
- Mutation score did not decrease when available.
- The full suite passes.
- Remaining P2/P3 findings and missing edge cases are documented.
- The final report states residual risk and the next recommended action.
