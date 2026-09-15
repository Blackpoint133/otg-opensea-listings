# Task 71G1 validation

- Isolated `BASELINE + 71G1` build: PASS.
- Isolated typecheck: PASS.
- Focused projection tests: 13 passed, 0 failed, 0 skipped. Focused generation-window tests: 10 passed, 0 failed, 0 skipped. Combined focused tests: 23 passed, 0 failed, 0 skipped.
- Direct build: PASS. Direct typecheck: PASS. Isolated hermetic suite: 1134 tests, 1134 passed, 0 failed, 0 skipped. No new or changed failures were observed.
- Projection matrix covers canonical success, null/malformed/noncanonical/ambiguous protocol, empty, duplicates, identity mismatch, unsupported scope, deterministic ordering, ephemeral timestamps, and no writer path.
- Barrier matrix covers canonical projection-bound scope construction, scope fingerprint determinism/change, arbitrary NFT-key rejection, repeatable-read transaction usage, zero watermark, exact `(S,H]` membership, historical 1233 reconciliation-required exclusion, historical 13 specialized pending exclusion, in-window specialized pending, in-window lifecycle counters, matching versus unrelated transfers, new-listing lifecycle admission, malformed identity rollback, watermark regression, and unknown status.
- Historical 1233 reconciliation-required regression: PASS. Historical 13 specialized REST pending regression: PASS. New-listing race: PASS. Same transaction snapshot: PASS. Protocol matrix A-I: PASS.
- Generation-window scope: BOUND_TO_CANONICAL_PROJECTION_IDENTITIES. Scope fingerprint: PASS. Arbitrary NFT key input: NOT ACCEPTED. Watermark regression: FAIL_CLOSED.
- `git diff --check`: PASS.

No OpenSea requests, API-key reads, production database access or writes, generation publication, verifier attempt, shadow decision, listing mutation, or authority grant occurred.
