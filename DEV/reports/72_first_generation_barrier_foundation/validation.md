# Task 71G1 validation

- Isolated `BASELINE + 71G1` build: PASS.
- Isolated typecheck: PASS.
- Focused projection tests: 15 passed, 0 failed, 0 skipped. Focused generation-window tests: 12 passed, 0 failed, 0 skipped. Combined focused tests: 27 passed, 0 failed, 0 skipped.
- Direct build: PASS. Direct typecheck: PASS. Hermetic suite: 1138 tests, 1138 passed, 0 failed, 0 skipped. No new or changed failures were observed.
- Projection matrix covers canonical success, null/malformed/noncanonical/ambiguous protocol, empty, duplicates, identity mismatch, unsupported scope, deterministic ordering, ephemeral timestamps, and no writer path.
- Barrier matrix covers canonical projection-bound scope construction, scope fingerprint determinism/change, arbitrary NFT-key rejection, repeatable-read transaction usage, zero watermark, exact `(S,H]` membership, historical 1233 reconciliation-required exclusion, historical 13 specialized pending exclusion, in-window specialized pending, in-window lifecycle counters, matching versus unrelated transfers, new-listing lifecycle admission, malformed identity rollback, watermark regression, and unknown status.
- Historical 1233 reconciliation-required regression: PASS. Historical 13 specialized REST pending regression: PASS. New-listing race: PASS. Same transaction snapshot: PASS. Protocol matrix A-I: PASS.
- Generation-window scope: DIRECTLY_DERIVED_FROM_COMPLETE_INITIAL_PROJECTION. Arbitrary canonical identity list: NOT_ACCEPTED_BY_PUBLIC_PRODUCTION_API. Projection/candidate identity set: ONE_TO_ONE_PROVEN. Scope fingerprint: PASS. Watermark regression: FAIL_CLOSED.
- Generation-window scope provenance: RUNTIME_OPAQUE_AND_PROJECTION_BOUND. Structurally forged subset: REJECTED / PASS. Correct-fingerprint forged subset: REJECTED / PASS. Spread clone: REJECTED / PASS. JSON roundtrip: REJECTED / PASS. Original trusted scope: ACCEPTED / PASS.
- Historical 13 specialized pending: ACTUAL_EVENT_IDS_LE_START / EXCLUDED / PASS. In-window specialized pending: MATCHING_NFT / BLOCKING / PASS. Two-NFT real projection matching transfer: BLOCKING / PASS. Omission through public API: IMPOSSIBLE / PASS. Projection tampering: FAIL_CLOSED / PASS.
- `git diff --check`: PASS.

No OpenSea requests, API-key reads, production database access or writes, generation publication, verifier attempt, shadow decision, listing mutation, or authority grant occurred.
