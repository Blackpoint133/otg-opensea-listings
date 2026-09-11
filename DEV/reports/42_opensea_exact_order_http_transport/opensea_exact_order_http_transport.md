# OpenSea exact-order HTTPS transport

Baseline: `344995f709674a8e14cae69b1a893d3729187cd8`.

Добавлен изолированный `src/reconciliation/verifier/openSeaExactOrderTransport.ts` версии `opensea-exact-order-http-transport-v1-2026-09`. Он принимает только trusted `TargetedVerifierContext`, явный непустой API-key без CR/LF и положительный safe-integer deadline. Host фиксирован `api.opensea.io`; запрос — HTTPS GET по context-derived exact path с `Accept: application/json` и одним `X-API-KEY`. Arbitrary origin, Authorization, cookies, body, query, redirect-following и retry отсутствуют.

Raw response headers преобразуются из native `rawHeaders` в ordered name/value entries без объединения дублей. Для HTTP 200 используется preallocated буфер максимум 1048577 байт: bytes type проверяется, затем ограничение; SHA и адаптация выполняются только после bounded accumulation. Большой одиночный chunk режется до лимита. Для non-200 тело не накапливается и response уничтожается после передачи status/headers в accepted adapter с `body: null`. Decompression и `setEncoding` не используются.

Deadline покрывает всю единственную попытку и использует monotonic elapsed time; timeout/reset имеют single-settlement guard, late events игнорируются. Provider Date не интерпретируется transport-слоем. `responseBodySha256` и artifact hash transport-слой не создаёт; accepted adapter остаётся единственным semantic/hash consumer.

Тесты используют только injected fake request/response, реальных сокетов и OpenSea запросов нет. Existing adapter, schema, normalizer, policy и contract versions не изменялись. Production scope: только новый transport module.

Статус: HTTP TRANSPORT IMPLEMENTED; LIVE GET ORDER NOT CALLED; REAL API KEY NOT USED; DB/MUTATION NOT USED; DEACTIVATION AUTHORITY = FALSE.
