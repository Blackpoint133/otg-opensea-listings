# Validation

Baseline task-06: 680/680 PASS. После remediation: `npm test` внутри Codex — **708 tests, 708 PASS, 0 FAIL, 0 skipped**, duration 7318.251064 ms. `npm run build` PASS, `npm run typecheck` PASS.

Добавлены проверки deterministic attempt material, изменения token/candidate/barrier/root/attemptNumber, schema/policy v4, canonical request identity и durable commitments. `validateAttemptEvidence` теперь требует v4, все context commitments, attempt number, recomputable attemptId и semanticEvidenceHash. `validateAttemptEvidenceForContext` и `buildAttemptEvidence` требуют trusted context. Существующий candidate duplicate/scope matrix сохранён.

PURE RESPONSE ADAPTER NOT IMPLEMENTED
HTTP TRANSPORT NOT IMPLEMENTED
LIVE/API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE

Следующий обязательный шаг — независимый re-audit; response adapter не авторизован этим этапом.
