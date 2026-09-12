# Task 58 test evidence

The executable `journalFenceSnapshotReader.test.ts` runs the production PostgreSQL reader against a stateful transactional `DbPool` simulator. It models BEGIN, repeatable-read visibility, watermark/event queries, COMMIT/ROLLBACK, concurrent insertion, empty journals, direct-order and same-NFT relevance, unrelated filtering, and malformed event rejection.

Gates: build PASS; typecheck PASS; npm test PASS (947 total, 947 passed, 0 failed, 0 skipped, 6684.520798 ms); git diff --check PASS. The operational worker and accepted verifier semantic files are unchanged. The first snapshot excludes an event inserted after its captured high-water; a subsequent snapshot includes it.
