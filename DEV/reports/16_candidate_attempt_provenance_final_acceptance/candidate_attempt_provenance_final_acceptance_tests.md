# Acceptance tests

- Trusted context A: runtime-produced YES.
- ProviderResult A1/A2: normalizer-produced YES, same identity, distinct canonical semantics.
- FenceResult A1/A2: applyJournalFence-produced YES, same context fingerprint.
- AttemptEvidence matrix: matching pairs PASS, crossed pairs reject with `FENCE_PROVIDER_MISMATCH`.
- Final artifact matrix: matching pairs PASS, crossed pairs reject.
- Task-12 cross-order regression: PASS.
- `semanticEvidenceHash` distinction: PASS.

Gates: `npm run build` PASS; `npm run typecheck` PASS; `npm test`: **693 tests, 693 PASS, 0 FAIL, 0 skipped**, duration 7357.480628 ms.

Source isolation: no HTTP/network/API key/DB/Stream/deactivation behavior. RUNTIME SOURCE MODIFIED = NO. PURE RESPONSE ADAPTER NOT IMPLEMENTED YET; HTTP TRANSPORT NOT IMPLEMENTED; LIVE/API KEY NOT USED; DB/MUTATION NOT USED; DEACTIVATION AUTHORITY = FALSE.
