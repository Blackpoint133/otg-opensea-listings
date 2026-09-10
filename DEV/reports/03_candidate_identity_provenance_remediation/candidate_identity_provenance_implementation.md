# Candidate / Evidence NFT Identity Provenance V2

## Статус

Реализована offline-only цепочка provenance согласно baseline `361c940` и amendment `197e9f5`. Production parser, сеть, API key, PostgreSQL и mutation не использовались.

## Изменения

- `offlineCandidateModel.ts`: модель v2, каноническая identity (`orderHash`, `chain`, `contractAddress`, `tokenId`, `collectionSlug`, `protocolAddress`), fail-closed validation и блокировка конфликтующих duplicate order hash.
- `reconciliationEvidenceIntegration.ts`: candidate envelope v2; validated reconstruction помечается module-private `WeakSet`.
- `targetedVerifierTypes.ts` / `targetedVerifierPolicy.ts`: verifier schema/policy v2, immutable `expectedIdentity`, identity в semantic attempt hash.
- `targetedVerifierContext.ts`: derived context принимает только runtime-proven reconstructed evidence и ABSENT_CANDIDATE с targeted eligibility; caller identity parameters отсутствуют.
- `targetedVerifierArtifact.ts`: durable artifact carries expected identity отдельно от provider observation.
- Тестовые helper/test cases обновлены для v2 и adversarial identity checks.

`OFFLINE_GENERATION_MODEL_VERSION` и `BARRIER_ENVELOPE_SCHEMA_VERSION` сохранены v1: их semantic payload не изменён, binding остаётся через candidate artifact hash.

## Безопасность

Authority и deactivation authority всегда `false`. WeakSet не экспортирует mint-функцию; clones/JSON/ручные frozen imitation не получают доверие.

PURE RESPONSE ADAPTER NOT IMPLEMENTED. HTTP TRANSPORT NOT IMPLEMENTED. LIVE/API KEY NOT USED. DB/MUTATION NOT USED. DEACTIVATION AUTHORITY = FALSE.
