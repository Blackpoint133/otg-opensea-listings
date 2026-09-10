# Финальный независимый re-audit

Аудит target: `caf24b28f19c63d9ab9e82bae2f0be29495ad226`.

## Положительные результаты

- Версии candidate v3, envelope v3, generation v2, barrier v2, verifier schema/policy v4, normalizer v1 согласованы.
- Поддержанный contract scope проверяется на candidate boundary.
- Candidate/barrier/root hash graph и WeakSet reconstruction provenance реализованы fail-closed.
- TargetedVerifierContext mint path ограничен `deriveTargetedVerifierContext`; artifact builder требует trusted context.
- Attempt self-hash и closed top-level schema присутствуют; JSON rehydration API существует.
- Build/typecheck/npm test проходят: 708/708.

## Findings

**HIGH-01 — provider/fence substitution.** `buildAttemptEvidence` валидирует `providerResult` и `fenceResult` по отдельности, но не сравнивает `canonicalEvidence(fenceResult.providerResult)` с provider input. В отличие от `buildTargetedVerifierArtifact`, cross-paired provider/fence values могут быть упакованы в self-hashed AttemptEvidence.

**HIGH-02 — fence/context order substitution.** `buildAttemptEvidence` не проверяет, что `preVerification.relevantOrderFingerprint.orderHash` и `postVerification.relevantOrderFingerprint.orderHash` совпадают с trusted context orderHash. Cross-order fence может пройти builder.

**MEDIUM-01 — overstated coverage.** `tests/attemptEvidenceBinding.test.ts` всё ещё содержит 18-кратный loop одинаковых self-equality assertions (`attemptIdentity(context,i) === attemptIdentity(context,i)`). Task-08 report утверждал, что redundant inflation удалена; это неверно и не является независимой adversarial coverage.

Итог: BLOCKER 0, HIGH 2, MEDIUM 1, LOW 0. Следующий response adapter/HTTP transport не авторизован.
