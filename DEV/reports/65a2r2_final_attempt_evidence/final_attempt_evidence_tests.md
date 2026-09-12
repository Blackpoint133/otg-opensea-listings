# Task 65A.2R2 executable evidence

Terminal COMPLETE and FAILED rows with matching tokens and unexpired leases are rejected by CAS and remain unchanged. Rich RESPONSE_OBSERVED and PENDING_FENCE reclaim cases preserve provider evidence, retry metadata, verificationStartedAt, and fence-preparation evidence while clearing leases; parity assertions pass.

Final gates: build PASS; typecheck PASS; npm test PASS (970 total, 970 passed, 0 failed, 0 skipped; duration `6975.185672 ms`); git diff --check PASS. Existing listDue, recovery, CAS, reclaim, and Task-65A.1 throttle regressions remain passing. No live requests, credentials, production DB, or listing mutation occurred.
