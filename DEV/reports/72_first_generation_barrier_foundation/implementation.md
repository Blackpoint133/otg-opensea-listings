# Task 71G1 implementation

Implemented `initialGenerationBaseline.ts`, an ephemeral projection of one complete imported Active Listings snapshot into deterministic `OfflineLocalOrder` values. It preserves one-to-one SeenOrder identity, feeds `classifyOfflineCandidates` unchanged, requires one strictly canonical protocol address across a non-empty supported snapshot, and emits `active`/`isActive`/non-reconciling orders with null event history and null `createdAt`/`updatedAt`. Null timestamps prevent fabricated item_listed history and avoid post-snapshot timestamp self-conflict. No database writer or synthetic journal event is invoked.

Implemented `generationJournalWindowReader.ts`. Each capture uses a REPEATABLE READ, READ ONLY transaction and durable bigint `event_id` watermarks. The generation window is exactly `(startEventId, observedHighWaterEventId]`; historical rows are excluded. Supported order lifecycle events are collection-wide relevant, while transfers are relevant only when their canonical NFT identity matches the projected generation identity set. Specialized REST provenance receives no exemption: historical rows are excluded by the window and in-window relevant rows count normally.

Files changed: `src/reconciliation/initialGenerationBaseline.ts`, `src/reconciliation/generationJournalWindowReader.ts`, `tests/initialGenerationBaseline.test.ts`, `tests/generationJournalWindowReader.test.ts`, and the two Task 71G1 reports in this directory.

Baseline database persistence, migration 009, generation publication, verifier/shadow execution, Fence B, listing mutation, and authority were not implemented.
