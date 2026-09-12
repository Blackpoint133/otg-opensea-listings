# Task 62 production fence bridge matrix

The production bridge matrix uses trusted adapter/normalizer output and stateful PostgreSQL-reader simulation. Cases 1–5 use `PostgresJournalFenceSnapshotReader` and invoke `applyProductionJournalFence`; case 6 intentionally invokes the accepted `applyJournalFence` directly for watermark regression.

Case 1 unchanged: PASS, provider status preserved, no relevant-event reason, authority false.
Case 2 unrelated order/NFT: PASS, watermark advanced while relevant fingerprint remained equal and provider status was preserved.
Case 3 direct target order event: PASS, `RECONCILIATION_REQUIRED` with `RELEVANT_ORDER_EVENT_ACROSS_FENCE`.
Case 4 same-NFT transfer with null order hash: PASS, reconciliation required with relevant-event reason.
Case 5 different order on same NFT: PASS, reconciliation required with relevant-event reason.
Case 6 watermark regression: PASS, direct accepted fence returned `RECONCILIATION_REQUIRED` with `WATERMARK_REGRESSION`.

All cases preserve `authorityGranted=false` and `deactivationAuthorityGranted=false`. The production reader, accepted fence algorithm, operational worker, and exact-order verifier sources were unchanged. No live network, API key, production database, or listing mutation was used.
