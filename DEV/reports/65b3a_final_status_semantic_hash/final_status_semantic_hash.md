# Task 65B.3A — Final status and semantic hash

Outcome A. The operational durable record now separates the provider-only `providerResultStatus` from the post-fence `finalResultStatus`. New and pre-fence records initialize both statuses and the semantic hash to null. Stable fencing copies the provider status into `finalResultStatus`; journal invalidation records `RECONCILIATION_REQUIRED`; the provider status is never overwritten.

`operationalSemanticMaterial` includes both statuses and the hash is computed from the actual persisted semantic record. Legacy payloads without `finalResultStatus` decode as null. PostgreSQL keeps the field payload-only; no migration was required.

Executable evidence covers stable and invalidated production fences, stale test fencing, RESPONSE_OBSERVED and PENDING_FENCE recovery, retry-child reset, retry exhaustion status preservation, hash differentiation and historical provider-status substitution regression, plus legacy decoding. Existing Task-65B.1/2, PostgreSQL store/throttle, and accepted verifier/fence tests remain passing.

No accepted verifier/fence semantic files, migrations, listing code, or worker orchestration beyond this status/hash correction were changed. Authority and deactivation authority remain false. No live requests or production database connections were used.

