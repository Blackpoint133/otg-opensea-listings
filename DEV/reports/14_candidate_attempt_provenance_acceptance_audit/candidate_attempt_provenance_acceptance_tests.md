# Исполнительная матрица

- Candidate scope/version/hash/reconstruction/context provenance: COVERED.
- AttemptId/semanticEvidenceHash/restart/idempotency: COVERED by permanent tests.
- Provider/fence cross-order and final artifact rejection: COVERED in `tests/providerFenceRuntimeCrosspair.test.ts`.
- Same-context different-provider-content A1/A2 cross-pair: NOT COVERED.
- Fence order durable tamper and authority false: COVERED by existing verifier tests/source validation.

Gates: `npm run build` PASS; `npm run typecheck` PASS; `npm test`: **692 tests, 692 PASS, 0 FAIL, 0 skipped**, duration 9639.82266 ms.

No temporary audit probe was committed; no runtime source changes were made. LIVE/API KEY NOT USED; DB/MUTATION NOT USED; DEACTIVATION AUTHORITY = FALSE.
