# Финальный независимый re-audit provenance

Target: `28d50c9f2534d9a49a36e2c42c53340e4629fd47` (предыдущий audit commit `caf24b28f19c63d9ab9e82bae2f0be29495ad226`).

## Вердикты

Candidate scope, version graph, durable hash graph, reconstructed-evidence provenance, trusted context provenance, attemptId/semanticEvidenceHash self-validation, restart API, context-bound idempotency и final artifact trusted-context guard подтверждены source review и зелёным suite.

Однако два ранее обнаруженных нарушения остаются:

- **HIGH:** `buildAttemptEvidence` проверяет provider и fence отдельно, но не сравнивает `fenceResult.providerResult` с `providerResult` и не связывает fingerprint order с context order.
- **MEDIUM:** redundant loop из 18 self-equality тестов остаётся в `tests/attemptEvidenceBinding.test.ts`; task-08 claim об удалении inflation materially inaccurate.

Итог: BLOCKER 0, HIGH 2, MEDIUM 1, LOW 0. **B — INDEPENDENT RE-AUDIT FAIL, REMEDIATION REQUIRED.** Response adapter не авторизован; HTTP transport остаётся запрещён.
