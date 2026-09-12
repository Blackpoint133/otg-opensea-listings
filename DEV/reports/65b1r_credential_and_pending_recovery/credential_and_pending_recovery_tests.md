# Task 65B.1R executable evidence

Credential tests: valid `normal-provider-key` containing `r` and `n` executes once; LF, CR, and CRLF credentials fail closed with zero executor calls and one permit release each. PENDING_FENCE restart recovery claims durable state and records zero permit acquisitions, zero credential reads, and zero executor calls; it never returns to NOT_STARTED. Existing RESPONSE_OBSERVED recovery and permit-before-claim regressions remain passing.

Final gates: build PASS; typecheck PASS; npm test PASS (978 total, 978 passed, 0 failed, 0 skipped; duration `10317.594834 ms`); git diff --check PASS. No live OpenSea requests, API key reads, production DB connections, Active Listings, or listing mutations occurred.
