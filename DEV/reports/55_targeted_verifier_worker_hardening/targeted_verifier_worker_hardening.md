# Task 55 targeted verifier worker hardening

Outcome: A.

Baseline: `7e17b0d19166f4b61968fc9cfe27781de4ef144f`.

Six operational defects were remediated without changing the accepted exact-order stack (transport v1, adapter v11, provider v3, normalizer v5, policy v8).

1. Lease recovery now distinguishes uncertainty from durable response recovery. Expired `REQUEST_PENDING` becomes fail-closed `REQUEST_OUTCOME_UNCERTAIN`; expired `RESPONSE_OBSERVED` and `PENDING_FENCE` lose their lease and can resume local fencing without a provider execution. Terminal rows are never reclaimed.
2. Every in-memory and PostgreSQL lease CAS requires the matching attempt/token, mutable lifecycle, and `lease_expires_at > operationAt`. Failed CAS results are surfaced as `STALE_LEASE` with the current durable row.
3. PostgreSQL transitions update payload and indexed lease/lifecycle fields together. Claim, response, completion, failure, retry, and recovery preserve lease/timestamp fields rather than allowing payload drift.
4. Idempotency material now includes sweep, generation root, order, candidate, barrier, provider contract, and attempt number. A generation-root change cannot collapse attempts.
5. The executor now returns only the trusted adapter observation. The worker invokes `interpretOpenSeaExactOrderObservation` itself; callers cannot inject a ProviderResult. Transport metadata is copied directly from the observation, including 5xx HTTP versus reset distinctions.
6. A shared scheduling permit store enforces concurrency and spacing across worker instances. The in-memory store is deterministic for tests; PostgreSQL uses an advisory-lock-protected permit table. Permits are acquired before credential retrieval and released after execution.

Post-fence exceptions build failure state from the current durable record, preserving all provider evidence already saved. Retry exhaustion is explicitly classified as `RETRY_EXHAUSTED`; retry cycles use new attempt numbers and identities. `maxAttempts` is enforced at attempt creation. Authority and deactivation authority remain literal `false` on every record and path.

Migration `sql/005_add_targeted_verifier_permits.sql` is additive and creates only the operational permit table/index. No authoritative listing table is changed. No network client, `.env` read, API key access, Active Listings call, or mutation capability was added.

Severity: BLOCKER 0, HIGH 0, MEDIUM 0, LOW 0.
