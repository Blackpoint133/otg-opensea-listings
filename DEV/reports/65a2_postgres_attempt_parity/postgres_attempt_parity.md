# Task 65A.2 PostgreSQL attempt parity

Outcome A for the scoped durable attempt-store layer. `PostgresTargetedVerifierAttemptStore` now writes indexed operational columns together with the normalized payload, including safe JSON nulls during reclaim. Claim, CAS, terminal, retry, and expired recovery transitions preserve lease ownership and provider/retry evidence. The direct stateful simulator executes the store SQL and maintains indexed and payload state.

Covered contract: create/get idempotency; NOT_STARTED and recovery claims; wrong/expired/stale-owner CAS; saveResponse, complete, fail, scheduleRetry; listDue lease filtering; REQUEST_PENDING fail-closed reclaim; RESPONSE_OBSERVED and PENDING_FENCE evidence-preserving reclaim; provider and retry metadata preservation; parity after successful mutations. Task-65A.1 throttle behavior remains unchanged.

Scope exclusions: worker orchestration, permit ordering, fence injection, semantic final-result model, and retry orchestration remain deferred. No live network, API key, production database, or listing mutation was used.
