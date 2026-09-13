# Task 65B.3BR6B test and gate evidence

Baseline: `206b7499637e8040a7ac107fc84e15902ba6cfc2`.

| Gate | Result | Total | Passed | Failed | Skipped | Duration |
|---|---|---:|---:|---:|---:|---:|
| Selected retry/context/recovery worker tests | PASS | 6 | 6 | 0 | 0 | 1633.491408 ms |
| Complete worker test file | PASS | 41 | 41 | 0 | 0 | 2225.814734 ms |
| PostgreSQL attempt-store test file | PASS | 50 | 50 | 0 | 0 | 387.012316 ms |
| `npm run build` | PASS | - | - | - | - | - |
| `npm run typecheck` | PASS | - | - | - | - | - |
| `npm test` | PASS | 1037 | 1037 | 0 | 0 | 7255.930572 ms |
| `git diff --check` | PASS | - | - | - | - | - |

The selected focused run covered the original maxAttempts=2 failure, advanced child snapshot regression, createAttempt pre mismatch, local fence recovery, thrown context resolver, and resolver pre-snapshot mismatch.

The PostgreSQL fixture suite remains 50/50 and continues to exercise valid worker-reachable lifecycle families plus malformed InMemory/raw-PostgreSQL admission cases. PostgreSQL throttle regressions pass in the full suite.

Acceptance evidence:

- createAttempt pre/context mismatch rejection: PASS
- local cached pre binding: PASS
- resolver pre binding before snapshot read: PASS
- advanced child pre watermark `200` / post watermark `150` regression: PASS
- maxAttempts=1 child absent: PASS
- maxAttempts=2 attempt 1 RETRY_EXHAUSTED and attempt 2 absent: PASS
- non-retryable child absent: PASS
- strict lifecycle/provider/final-result matrix: PASS
- local fence provider-evidence matrix and no fabricated fence evidence: PASS
- local fence recovery delta: `0 / 0 / 0 / 1`
- context failure provider-evidence matrix and no fabricated fence evidence: PASS
- context failure delta: `0 / 0 / 0 / 0`
- authorityGranted: `false`
- deactivationAuthorityGranted: `false`
- Migration 007: NO

Safety declaration:

```text
LIVE OPENSEA REQUESTS = 0
API KEY READ = NO
PRODUCTION DB CONNECTIONS = 0
DB LISTING MUTATION = NO
ACTIVE LISTINGS = 0
```
