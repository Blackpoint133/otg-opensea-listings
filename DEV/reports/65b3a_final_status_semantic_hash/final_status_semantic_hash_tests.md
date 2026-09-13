# Task 65B.3A — Test evidence

The 65B.2R2 recovery test previously proved only a non-STALE outcome; this task requires and verifies the durable semantic status/hash invariant. The current tests also prove the provider-only status cannot be replaced by the fence result during hashing. The test suite includes 990 tests: 990 passed, 0 failed, 0 skipped, duration 9204.722666 ms.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: 990 total, 990 passed, 0 failed, 0 skipped, 9204.722666 ms
- `git diff --check`: PASS

Evidence highlights:

- `finalResultStatus` exists and is null for new, RESPONSE_OBSERVED pre-fence, and PENDING_FENCE pre-fence records.
- Stable fence persists `finalResultStatus === providerResultStatus`; invalidation persists `RECONCILIATION_REQUIRED` while preserving provider status; stale test fencing persists `STALE` while preserving provider status.
- Persisted `semanticEvidenceHash` equals `operationalSemanticEvidenceHash` of the returned durable record.
- Provider-status and final-status perturbations independently change the hash; the historical temporary-provider-status substitution differs from a correctly separated record.
- RESPONSE_OBSERVED and PENDING_FENCE production recovery complete through the accepted fence with provider permit, credential, and executor counts of zero, and preserve post-fence evidence/status/hash.
- Retry source semantic status is retained; retry child status and hash start null; RETRY_EXHAUSTED does not replace final status.
- Missing legacy `finalResultStatus` decodes to null.

Authority flags are false. LIVE OPENSEA REQUESTS = 0; API KEY READ = NO; PRODUCTION DB CONNECTIONS = 0; DB LISTING MUTATION = NO; ACTIVE LISTINGS = 0.
