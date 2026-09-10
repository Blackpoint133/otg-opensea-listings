# Durable AttemptEvidence context binding

Базовая точка: `2ac688fa3248a6d5ed152167d52d6e46959b1dac`. Закрыт оставшийся HIGH-03 частично через schema/policy v4, persisted `attemptNumber`, единый canonical attempt material, self-hash validation, trusted-context checker и builder `buildAttemptEvidence`.

`attemptId` является SHA-256 canonical material из sweep, candidate/barrier/root commitments, candidate/generation/verifier/provider/normalizer versions, request identity, expected identity и attempt number. `semanticEvidenceHash` является SHA-256 canonical durable attempt/result material без самого hash и без attemptId recursion.

`deriveTargetedVerifierContext` единственный mint path для module-private WeakSet runtime provenance; `validateAttemptEvidenceForContext` требует этот provenance и exact equality всех bindings. Context clones не mint trust. Candidate v3, envelope v3, generation v2, barrier v2 и normalizer/provider versions не изменены.

Попытка построить final artifact из полностью ручного context оставлена совместимой для существующей structural artifact API; trusted attempt builder отдельно требует runtime-proven context. Response adapter/HTTP transport не реализованы. Live/API key, DB/mutation и deactivation authority не использовались.

Открытый риск: полная интеграционная проверка builder после restart требует следующего независимого re-audit; текущие offline проверки и self-hash тесты проходят.
