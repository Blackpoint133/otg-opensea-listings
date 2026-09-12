# Task 54 targeted verifier operational wiring

Outcome: A (offline/read-only operational worker implemented).

Baseline: `630e5ec546a2e29db1a4831dd6317efe086e5394`

The new operational layer is `src/reconciliation/verifier/targetedVerifierOperationalWorker.ts`. It consumes the accepted candidate/generation context and eligibility function, creates a durable attempt record, claims it with a lease token, invokes one injected verifier execution, records the normalized result, runs the supplied post-verification fence, and completes/fails the attempt. It never applies a listing state change.

The durable lifecycle is `NOT_STARTED -> REQUEST_PENDING -> RESPONSE_OBSERVED/PENDING_FENCE -> COMPLETE` or `FAILED`. An expired request lease is reclaimed as `FAILED` with `REQUEST_OUTCOME_UNCERTAIN`; this is deliberately fail-closed when a request may have occurred before a crash. Retryable normalized results retire the current attempt and create a deterministic next attempt number with a delayed `nextAttemptAt`; no hidden request loop exists.

Idempotency is the SHA-256 of sweep, order, candidate artifact, barrier artifact, provider contract version, and attempt number. Exact duplicate evidence converges on the same row; a new generation or retry attempt has a distinct identity. Claims use compare-and-set lease tokens in memory and in the PostgreSQL store. A stale token cannot complete, fail, or schedule an attempt after reclaim.

Operational defaults are conservative: 1,000 ms minimum spacing, two concurrent attempts, 60,000 ms rate-limit delay, 5,000 ms transient-transport delay, three maximum attempts, and 120,000 ms leases. All are configurable and validated. Credentials enter only through the execution-time provider, are not included in records, payloads, hashes, or events, and tests use a fake credential.

Semantic evidence uses the existing canonical evidence and `semanticEvidenceMaterial` functions. Fence watermarks, relevant fingerprints, result status, and reason codes are included in the semantic hash. Authority fields are literal `false` for every lifecycle and provider result, including confirmed statuses. No mutation/deactivation capability is accepted by the worker.

The narrowly scoped migration `sql/004_create_targeted_verifier_attempts.sql` adds only an attempt ledger and due-work index. It does not alter authoritative listing rows. The PostgreSQL store uses parameterized CAS updates and stores only sanitized operational JSON.

The accepted exact-order transport, adapter, provider contract, normalizer, policy, parser, and evidence graph remain semantically unchanged: transport v1, adapter v11, provider v3, normalizer v5, policy v8. No network client, alternate OpenSea client, `.env` read, API-key literal, Active Listings call, or listing mutation was added. No live request or database connection was made.

Self-review: BLOCKER 0, HIGH 0, MEDIUM 0, LOW 0.
