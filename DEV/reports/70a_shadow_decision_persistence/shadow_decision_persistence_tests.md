# Task 70A — Test evidence

The stateful test harness exercises transactional append, source-attempt admission, durable generation cross-binding, idempotent replay, ordered listing, SQL/payload corruption rejection, and the append-only migration contract. The persisted `SHADOW_ELIGIBLE` decision remains audit-only with all authority flags false. Migration 008 is the only migration added.
