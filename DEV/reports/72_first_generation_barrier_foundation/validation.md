# Task 71G1 validation

- Isolated `BASELINE + 71G1` build: PASS.
- Isolated typecheck: PASS.
- Focused projection/barrier tests: 13 passed, 0 failed, 0 skipped.
- Isolated hermetic suite: 1124 tests, 1120 passed, 4 failures; exactly the four pre-existing Task-32 OpenAPI fixture/hash failures (`task32 committed upstream snapshot has the authorized exact bytes`, extractor operation/response, canonical byte identity, and offline CLI reproduction). No new or changed failures were observed.
- Current workspace hermetic suite: 1124 passed, 0 failed, 0 skipped.
- Projection matrix covers canonical success, null/malformed/noncanonical/ambiguous protocol, empty, duplicates, identity mismatch, unsupported scope, deterministic ordering, ephemeral timestamps, and no writer path.
- Barrier matrix covers repeatable-read transaction usage, zero watermark, exact `(S,H]` membership, historical reconciliation/pending exclusion, in-window lifecycle counters, matching versus unrelated transfers, new-listing lifecycle admission, malformed identity rollback, and unknown status.
- `git diff --check`: PASS.

No OpenSea requests, API-key reads, production database access or writes, generation publication, verifier attempt, shadow decision, listing mutation, or authority grant occurred.
