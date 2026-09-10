# Remediation candidate identity provenance v2

## Scope and baseline

Работа выполнена относительно аудита `414ed0537834b8a51f408c7d1804a69d6b87fee1` и базовой реализации `889a65810ba17305d36cc642222e1b0ed4d4fe58`. Изменения ограничены офлайн provenance, версиями durable evidence, тестами и hermetic runner.

## Findings and remediation

- HIGH-01: введён общий `src/reconciliation/identityScope.ts`; контракт, chain и collection теперь проверяются единообразно, а неподдержанный синтаксически корректный contract получает BLOCKED/`UNSUPPORTED_LOCAL_SCOPE` на candidate boundary. Неверный orderHash в identity также блокируется.
- HIGH-02: изменены версии candidate model/envelope, generation model и barrier envelope; старые и смешанные durable графы fail-closed.
- HIGH-03: verifier scope теперь требует `gunzilla` на request identity; expected identity обязана совпадать с поддерживаемым scope и request. Попытки с произвольным chain/contract не становятся валидным verifier evidence.
- MEDIUM-01: candidate и generation используют общий pure identity contract.
- MEDIUM-02: обязательные fixture/sql копии больше не подавляют ошибки; child-process runner обрабатывает `error` и разрешает promise ровно один раз.
- MEDIUM-03: добавлен отдельный набор исполняемых adversarial assertions для scope, canonical token и duplicate independence.

## Version map

`active-listings-offline-candidate-v3`, `candidate-bundle-envelope-v3`, `active-listings-offline-generation-barrier-v2`, `barrier-evaluation-envelope-v2`, `targeted-verifier-schema-v3`, `targeted-verifier-policy-v3`. Normalizer и OpenSea provider contract не изменялись. Старые несовместимые artifacts не мигрируются автоматически.

## Security boundary

Response adapter и HTTP transport не реализованы. Live/API key, DB, mutation и deactivation authority не использовались; `authorityGranted` и `deactivationAuthorityGranted` остаются false.

