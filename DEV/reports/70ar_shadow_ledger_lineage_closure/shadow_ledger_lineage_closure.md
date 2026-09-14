# Task 70AR — Shadow ledger lineage closure

70A established the append-only persistence architecture and source cross-checks, but its reads did not validate predecessor existence/immediacy and its test harness did not model transaction-local visibility, locks, or rollback. This remediation adds explicit immediate-predecessor validation for `get`, full-chain validation for `listForAttempt`, and corrupt-head refusal before append or replay.

The store remains INSERT-only. The source attempt row remains the serialization lock, persisted decisions remain audit facts, and SHADOW_ELIGIBLE grants no authority. Migration 008 is unchanged; no scheduler, Fence B, Active Listings persistence, deactivation, or listing mutation was added.
