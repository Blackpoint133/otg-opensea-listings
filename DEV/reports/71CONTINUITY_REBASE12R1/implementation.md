# Task 71CONTINUITY-REBASE12R1

The continuity-loss rebaseline path was hardened without changing ordinary v1 adoption semantics.

* The missing-row INSERT now uses an explicit 33-column/33-expression contract. `$15` is the source, `$16` supplies `last_reconciled_at`, `created_at`, and `updated_at`, `$17` is JSON `null` for the required `raw_last_event`, `$18` is the protocol, `$19` is the adoption id, and `$20` is the trusted raw baseline JSON. Existing-row updates use the same positional contract.
* Replay is fenced from the exact recovery-entry journal high-water row (paired event id/received_at), not the generation stable watermark. This preserves events that arrived between replacement-epoch entry and adoption, including events already included in the stable watermark.
* Relevant replay events require a provable business timestamp. Events at or before `snapshotCompletedAt` are ignored as late arrivals; events strictly after it are reduced through the production normalizers/reducers; missing or invalid business time fails closed.
* Recovery anchors now require and bind the superseded sweep, verify the exact accepted/current publication, pair the journal high-water in one row, and capture all state in one repeatable-read, read-only transaction.
* The production CLI is directly executable, loads canonical credentials/configuration, captures the anchor before runtime construction, starts one real ingestion runtime, runs one real generation/publication, adopts once, verifies durably with a fail-closed verifier, checks lease continuity, and waits for runtime termination after success.
* `runContinuityLossGeneration` factors the audited Active Listings/evidence/evaluator/reconstruction/publication machinery for the continuity-loss path and records continuity-specific source provenance.
* The default post-adoption verifier checks receipt schema/payload, exact baseline provenance and membership, old/new publication bindings, unsafe journal status, and same-lease continuity. There is no permissive `verify ?? true` production fallback.

No production database, OpenSea endpoint, WebSocket, environment file, or production evidence was accessed or modified.
