# Task 65B.3AR4 — Final durable evidence

Outcome A. Task-65B.3AR3 closed most worker semantic-evidence gaps, but its RETRY_EXHAUSTED branch asserted only COMPLETE and did not inspect the durable semantic status/hash record. Its fresh stable and changed-fingerprint assertions also relied on `run.record` rather than independently rereading the durable attempt.

This test-only remediation now rereads the original attempt for RETRY_EXHAUSTED and proves COMPLETE, `failureClassification = RETRY_EXHAUSTED`, provider/final status `TRANSPORT_FAILED`, and exact persisted semantic hash. The fresh stable and fresh journal-invalidation tests reread durable records and assert exact status separation, lifecycle, reason code, authority flags, and hash invariants.

Production behavior, accepted verifier/fence semantics, PostgreSQL store/throttle behavior, migrations, and listing state remain unchanged.

