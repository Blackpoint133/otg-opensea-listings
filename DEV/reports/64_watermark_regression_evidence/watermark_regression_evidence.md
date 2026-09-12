# Task 64 watermark regression evidence

The dedicated executable Case 6 test now calls the accepted `applyJournalFence` path with an immutable pre snapshot and an equivalent-fingerprint post snapshot whose watermark event ID is lower. It asserts `RECONCILIATION_REQUIRED`, `WATERMARK_REGRESSION`, no relevant-event reason, and both authority flags false.

Cases 1–5 production bridge evidence remains unchanged and passing. No production code, operational worker, or historical report was modified. No live network, API key, production database, or listing mutation was used.
