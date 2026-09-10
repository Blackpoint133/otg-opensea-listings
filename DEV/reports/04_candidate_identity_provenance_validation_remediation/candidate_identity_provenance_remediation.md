# Candidate identity provenance validation remediation

## Baseline и классификация

Baseline implementation: `4afaa21290577130320c52224925fbf8e78029f9`; design amendments: `361c94091e66995b266facff1ed19d26ab0a712e`, `197e9f59e66aedd31e32c3b00b363a0a6dd93f27`.

Внешний baseline был 656 тестов: 649 pass, 7 fail. Классификация:

1. Четыре generation eligibility failures — **VERSION/HANDOFF CONTRACT BUG**: generation validator всё ещё принимал candidate v1. Исправлен явный consumer candidate v2 с сохранением generation v1 semantics.
2. Unrelated unique absent order — **PRODUCTION/SEMANTIC CODE DEFECT**: structural identity contradiction ошибочно делал весь handoff invalid. Теперь конфликтная duplicate-группа блокируется целиком, независимый order сохраняет eligibility.
3. Uppercase hash expectation — **STALE EXPECTATION AFTER INTENTIONAL V2 FAIL-CLOSED CHANGE**: это identity orderHash; uppercase теперь отклоняется.
4. Exact reason relationship — **VERSION/HANDOFF CONTRACT BUG**; v2 candidate handoff теперь проходит generation validator, а invalid reason relationship остаётся rejected.
5. Legacy reconstruction graph — **STALE V1 FIXTURE**: candidate envelope fixture обновлён до v2, barrier-specific corruption сохранена.

## Исправления

- `offlineGenerationBarrierModel.ts`: candidate consumer v2, per-entry identity validation, deterministic conflicting-group blocking.
- `targetedVerifierTypes.ts` / `targetedVerifierPolicy.ts`: `AttemptEvidence.expectedIdentity` теперь обязательна; canonical identity и request agreement проверяются; `canonicalVerifierIdentity` делегирует единому `attemptIdentity`.
- `targetedVerifierContext.ts`: `generationRootHash` берётся из validated `RootManifest.rootContentHash`; candidate/barrier/root commitments различены.
- `tests/activeListingsLifecycle.test.ts`: hermetic child использует compiled JS вместо tsx только в hermetic режиме.
- `tests/offlineGenerationBarrierModel.test.ts`, `tests/reconciliationEvidenceIntegration.test.ts`, `tests/targetedVerifierNormalizer.test.ts`: v2 fixtures/expectations.
- `package.json`, `.gitignore`, `tsconfig.hermetic.json`, `scripts/runHermeticTests.mjs`, `scripts/compileHermeticTests.mjs`: plain-Node test path.

Generation remains v1 and barrier envelope remains v1: their semantic payloads are unchanged; candidate v2 is consumed through validated candidate artifact and existing barrier `candidateArtifactHash` binding.

Runtime WeakSet provenance remains non-mintable; clones and forged frozen values are rejected. No adapter/HTTP/DB/live behavior was added.
