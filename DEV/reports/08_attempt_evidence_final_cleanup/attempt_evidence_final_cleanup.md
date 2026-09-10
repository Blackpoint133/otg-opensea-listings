# Final provenance cleanup

Baseline: `13aec1fce02904dfd85d48fc1c36ec827b2627fa`.

Воспроизведённые разрывы: прежний `sameAttemptEvidence` использовал неполную shape-проверку; JSON evidence не проходил из-за freeze-зависимости; artifact builder принимал forged context; часть attempt-тестов повторяла один deterministic vector.

Исправления: `sameAttemptEvidence` снова требует строгую durable validation; добавлен `sameAttemptEvidenceForContext` с trusted-context provenance и exact bindings; добавлен `rehydrateAttemptEvidence` для JSON restart; schema v4 validator закрывает unknown top-level fields и recomputes обе hashes; final artifact builder требует runtime-trusted context.

AttemptEvidence остаётся отдельным durable identity+semantic-result доказательством, TargetedVerifierArtifact — финальным fence/provider artifact. Candidate v3, envelope v3, generation v2, barrier v2, normalizer v1 и provider contract не изменены.

Открытые ограничения отсутствуют в offline scope; response adapter и HTTP transport не реализованы. Live/API key, DB/mutation и deactivation authority не использовались.
