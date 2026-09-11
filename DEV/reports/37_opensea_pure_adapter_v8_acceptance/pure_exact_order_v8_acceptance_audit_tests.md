# Task 37 — executable verification

Added independent tests in `tests/task37RawInputRobustnessAudit.test.ts` for
malformed raw metadata not covered by the earlier Task-35/36 vectors. Production
header hardening remains green through the existing adversarial matrix; new tests
reproduce uncaught exceptions for Symbol-valued `httpStatus` and `body`.

The full repository gates completed without altering tests to conceal failures:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 883 tests, 883 passed, 0 failed, 0 skipped,
  duration 8378.664326 ms
- `git diff --check`: PASS

Relative to the baseline, only the new audit test and the two Task-37 reports are
changed. Production `src/` is byte-identical to baseline. Immutable Task-32
OpenAPI snapshot and generated fixture are unchanged.

The raw-input exceptions are documented as MEDIUM findings; HTTP transport remains
unauthorized until a separate remediation closes them.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
