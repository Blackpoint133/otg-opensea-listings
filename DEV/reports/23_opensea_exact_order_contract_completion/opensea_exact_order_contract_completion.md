# Task 23 — Pure exact-order provider contract

Базовый коммит: `58244b8869d3b02a2000f440b9146afe4cba1bf7`.

Официальная OpenAPI-документация: https://api.opensea.io/api/v2/openapi.json (публичная документация; live Get Order не вызывался). Воспроизводимый pin: OpenAPI 3.1.0, info 2.0.0, операция `get_order`, `#/components/schemas/GetOrderResponse`; документ 590486 байт, SHA-256 `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922`; извлечённое дерево SHA-256 `5960ac559f3f847f05581e3185a2eae009a85918a9f380605c6d5fc33e10eafa`, pin UTC 2026-09-11. Ответ обёрнут в `order`; внешние поля snake_case (`order_hash`, `protocol_data`, `remaining_quantity`), Seaport `parameters`/`offer` поля camelCase (`startTime`, `endTime`, `orderType`, `itemType`, `identifierOrCriteria`, `startAmount`, `endAmount`). `remaining_quantity` — JSON integer int64; Seaport enum — JSON int32; идентификаторы/amounts — strings.

Адаптер теперь валидирует lossless-числа, строгую схему Listing, точные identity commitments и conservative Date interval. Timing включает wall-clock и monotonic `elapsedMs/overallDeadlineMs/deadlineExceeded`; temporalProof различает ACTIVE, EXPIRED и terminal states. HTTP/status классифицируется до разбора body, а failure reason mapping остаётся fail-closed. `rawResponseArtifactHash` проверяется при наличии; pure-адаптер не предоставляет DB/deactivation authority.

Изменены runtime: `losslessJson.ts`, `openSeaExactOrderAdapter.ts`, `targetedVerifierNormalizer.ts`, `targetedVerifierTypes.ts`, добавлен `openSeaExactOrderContract.ts`; обновлены offline fixtures/tests. Candidate/envelope/generation/barrier версии не изменены. Policy/normalizer версии подняты до v8/v5; durable schema v4 сохранена.

HTTP TRANSPORT NOT IMPLEMENTED  
LIVE GET ORDER NOT CALLED  
API KEY NOT USED  
DB/MUTATION NOT USED  
DEACTIVATION AUTHORITY = FALSE

Оставшиеся ограничения: transport/evidence persistence остаются отдельным этапом; этот отчёт не авторизует HTTP.

## Вердикт

A. PURE EXACT-ORDER ADAPTER COMPLETE  READY FOR INDEPENDENT ACCEPTANCE AUDIT
