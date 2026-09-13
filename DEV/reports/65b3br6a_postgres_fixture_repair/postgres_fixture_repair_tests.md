# BR6A test evidence

Baseline: `206b7499637e8040a7ac107fc84e15902ba6cfc2`.

| Gate | Result | Total | Passed | Failed | Skipped | Duration |
|---|---|---:|---:|---:|---:|---:|
| Original focused PostgreSQL attempt-store file | FAIL | 16 | 5 | 11 | 0 | 177.837686 ms |
| Final focused PostgreSQL attempt-store file | PASS | 50 | 50 | 0 | 0 | 365.748440 ms |
| npm run build | PASS | — | — | — | — | — |
| npm run typecheck | PASS | — | — | — | — | — |
| npm test | FAIL | 1034 | 1033 | 1 | 0 | 8743.295026 ms |
| git diff --check | PASS | — | — | — | — | — |

Focused execution used the existing hermetic TypeScript compile and test transpilation scripts, followed by:

```text
node --test .codex-test-tmp/tests/targetedVerifierPostgresAttemptStore.test.js
```

The full gate used the normal `npm test` runner. No test was skipped or disabled. The single remaining failure is in the unchanged worker test:

```text
maxAttempts=2 exhausts child one without creating child two
expected failureClassification: RETRY_EXHAUSTED
actual failureClassification: null
```

This failure predated BR6A, was unrelated to the repaired PostgreSQL fixtures, and belonged to the explicitly deferred retry/context work. BR6A therefore ended Outcome B with no commit or push. BR6B later closed the retry/context path; its separate report records the final passing combined-tree gates.

Executable fixture evidence covers trusted INACTIVE_CONFIRMED empty reasons, trusted RATE_LIMITED retry metadata, all 11 valid lifecycle/classification families, exact identities, provider rehydration without trusting caller object identity, current hash parity, legacy rejection, and 22 deliberately malformed states through both admission paths.

All PostgreSQL attempt-store tests and throttle regressions passed in the full suite. Production strictness was not weakened. Existing pending production changes were preserved. No migration was added.

LIVE OPENSEA REQUESTS = 0

API KEY READ = NO

PRODUCTION DB CONNECTIONS = 0

DB LISTING MUTATION = NO

ACTIVE LISTINGS = 0

authorityGranted = false

deactivationAuthorityGranted = false
