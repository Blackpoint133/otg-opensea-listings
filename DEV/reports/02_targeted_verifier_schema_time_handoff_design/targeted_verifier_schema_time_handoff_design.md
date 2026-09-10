# Design: OpenSea exact-order adapter, time и transport handoff

## Решение и границы

Основной outcome: **B. HANDOFF DESIGN VALIDATED — PURE RESPONSE ADAPTER REQUIRED**.

Рекомендуемый pipeline:

```text
HTTP transport
  exact bytes + allowlisted raw headers + attempt metadata + low-level code
    -> pure OpenSea exact-order response adapter (versioned)
       canonical provider observation + explicit adapter errors
         -> validated targeted verifier normalizer
            ProviderResult (authority=false, deactivationAuthority=false)
              -> independent journal fence
                -> durable targeted-verifier artifact
```

Transport остаётся семантически тупым: он не unwraps `order`, не переименовывает
поля, не выводит status/asset state, не решает ACTIVE/INACTIVE и не выдаёт authority.
OpenSea-specific schema adaptation принадлежит чистому versioned adapter.

## Минимальный versioned contract

Ввести два новых version identifiers:

- `OPENSEA_EXACT_ORDER_ADAPTER_VERSION = "opensea-exact-order-adapter-v1-2026-09"`;
- `TARGETED_VERIFIER_TRANSPORT_OBSERVATION_VERSION = "targeted-verifier-transport-observation-v1"`.

Отдельный `OPENSEA_EXACT_ORDER_RAW_SCHEMA_VERSION` не нужен: provider schema уже
пинится обновлённым `OPENSEA_ORDER_CONTRACT_VERSION`, official source URL/API
version/retrieval date и fixture manifest. Лишние параллельные constants создадут
двойную истину.

`TransportObservationV1` должен содержать как минимум:

- schema version, attempt id и immutable request identity;
- UTC wall-clock `requestStartedAt`, `responseHeadersAt`, `responseCompletedAt`;
- monotonic durations/deadline result отдельно от wall clock;
- `lowLevelCode`, `highLevelOutcome`, HTTP status или null;
- allowlisted raw `date`, `age`, `content-type`, `content-encoding`,
  `content-length`, retry/rate-limit/request-id headers; secret headers запрещены;
- exact body bytes (`Uint8Array`) либо null, byte count и `responseBodySha256`;
- durable envelope/artifact hash либо null;
- retry index и aggregate retry metadata, не скрывающие individual attempt.

Adapter output должен быть новым immutable `OpenSeaExactOrderObservationV1`:
adapter/provider-contract versions, request identity, exact status evidence,
canonical decimal strings, canonical addresses/hash, observation-time provenance,
raw hashes, adapter outcome/reason codes. Только internal constructor получает
runtime provenance; caller не может передать готовый trusted ProviderResult.

Необходимо bump:

- `OPENSEA_ORDER_CONTRACT_VERSION` — на pinned September 2026 OpenAPI contract;
- `TARGETED_VERIFIER_NORMALIZER_VERSION` — v2, потому что входом становится
  canonical adapter observation, а не raw OpenSea JSON;
- `TARGETED_VERIFIER_SCHEMA_VERSION` — v2, потому что artifacts/attempt evidence
  должны фиксировать transport/adapter versions и time provenance;
- `TARGETED_VERIFIER_POLICY_VERSION` — v2, если принимаются приведённые ниже
  status/time/identity rules.

Candidate/generation model versions не меняются: их semantics не затронуты.

## Fail-closed status truth table

Для любого positive результата обязательны: HTTP 200; valid exact bytes/hash;
valid `GetOrderResponse.order`; однозначная Listing branch; exact path/context
order hash, chain и protocol; exact ERC721 identity; supported FULL_OPEN shape;
trusted observation time; отсутствие schema/precision contradiction. Unknown fields
не являются contradiction сами по себе. 404 всегда UNKNOWN.

| Provider evidence | Дополнительные условия | ProviderResult |
| --- | --- | --- |
| exact `status = ACTIVE` | `remaining_quantity > 0`; official start/end; trusted time interval целиком внутри `[startTime,endTime)` | `ACTIVE_CONFIRMED` |
| exact `status = INACTIVE` | все общие positive gates | `INACTIVE_CONFIRMED`; причина inactivity не выводится |
| exact `status = FULFILLED` | все общие positive gates | `TERMINAL_CONFIRMED` |
| exact `status = CANCELLED` | все общие positive gates | `TERMINAL_CONFIRMED` |
| exact `status = EXPIRED` | все общие gates и trusted time не раньше `endTime` с resolution margin | `EXPIRED_CONFIRMED` |
| status отсутствует/unknown/non-string | никакой derivation из иных полей | UNKNOWN либо MALFORMED_RESPONSE |
| legacy `canceled/finalized/marked_invalid` без official status | поля отсутствуют в live target schema | UNKNOWN; не выводить state |
| 404 | независимо от body | UNKNOWN (`HTTP_404_NOT_STATE_PROOF`) |

Если ACTIVE конфликтует с zero quantity/time, либо EXPIRED конфликтует с time,
результат UNKNOWN/AMBIGUOUS, но не другой positive state. `INACTIVE` не является
синонимом CANCELLED. Отсутствие поля никогда не означает inactive/terminal/expired.
Ни один status не даёт deactivation authority.

## Listing и NFT identity

Positive OTG evidence разрешено только при всех условиях:

1. Root является object с обязательным единственным semantic member `order`;
   unknown siblings допускаются, но не используются.
2. `order` однозначно валидирует официальный Listing branch, не Offer/SVM.
3. `order_hash`, `chain`, `protocol_address` совпадают с request/context после
   canonical lowercase validation; normalization никогда не исправляет разные bytes.
4. `protocol_data.parameters` присутствует; `orderType` — integer `0`
   (`FULL_OPEN`). PARTIAL/RESTRICTED/CONTRACT orders unsupported.
5. `offer` — массив ровно из одного item; `itemType` — integer `2` (ERC721),
   не criteria values 4/5; `token` равен expected OTG contract.
6. `identifierOrCriteria` — canonical unsigned decimal string и exact expected
   token ID; `startAmount` и `endAmount` строго `"1"`.
7. `asset` присутствует; `asset.contract` совпадает с offer token/context;
   `asset.identifier` присутствует, canonical и совпадает с offer/context ID.
8. Любая неоднозначность, multiple offers, criteria root, wrong token/id, quantity
   drift или несовпадение двух identity sources запрещает positive evidence.

Идентичность берётся из комбинации official `asset` и
`protocol_data.parameters.offer`: ни один источник отдельно не достаточен, потому
что `asset`/identifier optional в raw schema, а signed Seaport offer является
криптографически значимой частью order.

## Provider observation time

Вердикт: **A — строгий valid HTTP `Date` допускается как provider HTTP-message
observation time**, но не как business record creation time и только при всех
условиях ниже. OpenSea не документирует отдельное response-body observation field;
local completion time не подставляется как observedAt.

Политика v1:

1. Принимать ровно один `Date`, только в strict IMF-fixdate form из RFC 9110;
   obs-date, лишний whitespace, impossible calendar value и duplicate values reject.
2. Parse/format round-trip должен дать canonical UTC `YYYY-MM-DDTHH:mm:ss.000Z`.
3. `Age` обязан отсутствовать. Даже `Age: 0` reject для positive time provenance:
   RFC 9111 говорит, что присутствие Age означает ответ, не созданный/не
   валидированный origin для этого request.
4. Request должен требовать revalidation (`Cache-Control: no-cache`) и JSON, но
   client/intermediary cache нельзя использовать как источник state.
5. Captured Date должен лежать в интервале
   `[requestStartedAt - 300000 ms, responseCompletedAt + 300000 ms]`. Пять минут —
     жёсткий максимальный clock-skew tolerance; выход за него reject. Monotonic
   elapsed одновременно обязан быть не больше configured overall deadline.
6. Из-за секундной точности Date temporal proof использует conservative interval
   `[Date - 1000 ms, Date + 1000 ms]`. Для ACTIVE весь этот интервал должен лежать
   внутри `[startTime,endTime)`; для EXPIRED его нижняя граница должна быть не
   раньше endTime. Это исключает пограничное округление.
7. Missing/malformed/duplicate/stale/future Date, присутствующий Age, impossible
   local relationship или clock jump дают `observedAt = null` и explicit reason.
   Никакого fallback к request start/completion/local now.
8. Каждый retry имеет собственный Date и envelope. Date одной попытки нельзя
   переносить на другую; normalizer получает observation только принятой попытки.

При невыполнении этих условий ACTIVE остаётся UNKNOWN. Если будущий независимый
аудит сочтёт CDN Date недостаточным provider evidence, policy должна fail closed
переключиться на outcome B для времени, а не использовать local clock.

## JSON / bigint safety

Native `JSON.parse` безопасен только для документированных strings и JSON integers,
которые предварительно доказаны как `Number.isSafeInteger`. Риски:

- `remaining_quantity`: JSON integer/int64, потенциально выше MAX_SAFE_INTEGER;
- `order_created_at`: JSON int64;
- `parameters.counter`: JSON integer без format, on-chain Seaport `uint256`;
- legacy model описывает ряд uint256 как numbers, но live exact-order OpenAPI
  правильно даёт start/end/identifier/amounts/salt как strings;
- `orderType`, `itemType`, `totalOriginalConsiderationItems` — int32 и безопасны
  после strict range/integer validation.

Adapter обязан использовать lossless JSON parser/tokenizer. Для каждого numeric
token сохраняется исходная JSON lexical value. Integer fields принимаются только
без fraction/exponent/leading plus; `-0` и отрицательные quantities reject.
Bigint-sensitive значения не проходят через Number. После schema/range checks они
становятся canonical decimal strings (`0` или non-zero без leading zeros).

Нужно различать:

- raw entity bytes — неизменённые octets после HTTP framing;
- JSON lexical token — точная последовательность bytes для числа/строки;
- JS parsed representation — не доверяется для unsafe integers;
- canonical decimal string — adapter output после lossless validation.

Unsafe numeric JSON не округляется и не «исправляется»: adapter возвращает
MALFORMED_RESPONSE/UNSUPPORTED и не создаёт positive observation.

## Transport error handoff

Текущий `TransportOutcome` недостаточен. Сохранить отдельные поля:
`lowLevelCode` (диагностика) и `highLevelOutcome` (ограниченная verifier semantics).
Рекомендуемый high-level enum: `HTTP`, `TIMEOUT`, `CONNECTION_RESET`,
`TRANSPORT_FAILURE`. Это versioned expansion; unknown codes map only to
`TRANSPORT_FAILURE`.

| Low-level code | High-level | Verifier result |
| --- | --- | --- |
| `HTTP_RESPONSE` | `HTTP` | status/body adapter path |
| `CONNECT_TIMEOUT`, `HEADERS_TIMEOUT`, `OVERALL_TIMEOUT` | `TIMEOUT` | TRANSPORT_FAILED |
| `CONNECTION_RESET` | `CONNECTION_RESET` | TRANSPORT_FAILED |
| `DNS_FAILURE`, `TLS_FAILURE` | `TRANSPORT_FAILURE` | TRANSPORT_FAILED |
| `ABORTED`, `BODY_OVERFLOW` | `TRANSPORT_FAILURE` | TRANSPORT_FAILED |
| `UNEXPECTED_CONTENT_ENCODING`, `REDIRECT_REJECTED` | `TRANSPORT_FAILURE` | TRANSPORT_FAILED |
| `MALFORMED_HTTP`, `TRUNCATED_BODY`, `CONTENT_LENGTH_MISMATCH` | `TRANSPORT_FAILURE` | TRANSPORT_FAILED |
| unknown/unmapped | `TRANSPORT_FAILURE` + `UNKNOWN_LOW_LEVEL_CODE` | TRANSPORT_FAILED |

`MALFORMED_UTF8`, `MALFORMED_JSON`, `NON_OBJECT_JSON` возникают после валидного
HTTP response и относятся к adapter result `MALFORMED_RESPONSE`, а не маскируются
как network error. `RETRY_EXHAUSTED` — aggregate flag/reason, не подмена low-level
кода последней попытки. HTTP 400/401/403/404/409/429/5xx сохраняются отдельно.
400 — request/provider rejection и не state proof; локально доказанный unsupported
scope должен быть остановлен до сети. 3xx не follow автоматически.

## Два hash boundary

`responseBodySha256`:

- SHA-256 exact HTTP response entity bytes, которые переданы adapter;
- вычисляется transport до UTF-8/JSON interpretation;
- никаких newline, Unicode, JSON или key-order canonicalization;
- при v1 identity encoding wire representation bytes и entity bytes совпадают;
- null только если entity bytes не получены; empty body имеет hash пустых bytes.

`rawResponseArtifactHash`:

- SHA-256 canonical durable envelope `targeted-verifier-raw-response-v1`;
- envelope содержит request/attempt identity, version constants, exact timestamps,
  monotonic durations, low/high outcomes, HTTP status, allowlisted safe headers,
  body byte length, `responseBodySha256` и exact body bytes в deterministic base64
  либо content-addressed body member внутри того же durable artifact;
- secret request headers/API key никогда не входят;
- меняется при изменении metadata даже при одинаковом body, поэтому не является
  synonym body hash;
- null до успешной durable write; positive ProviderResult требует оба hash и
  verified linkage envelope.bodySha256 == responseBodySha256.

Каждая retry attempt имеет собственные два hash/artifact. Aggregate artifact
ссылается на ordered attempt hashes, не перезаписывая предыдущие evidence.

## Raw bytes и content encoding v1

- Request headers: `Accept: application/json`, `Accept-Encoding: identity`;
  TOON не запрашивается.
- Response `Content-Encoding` допускается только отсутствующий или единственный
  case-insensitive token `identity`; gzip/br/deflate/multiple coding reject без
  transparent decompression.
- Hard body cap: **1 MiB (1,048,576 bytes)** exact entity bytes. Declared
  Content-Length выше cap abort; streaming count выше cap abort.
- Content-Length должен быть single unsigned decimal within safe range. При его
  наличии фактическая длина обязана совпасть после HTTP framing; malformed,
  duplicate inconsistent или truncated body reject. Transfer framing не входит в
  entity hash.
- Для semantic 200 требуется `application/json` (optional `charset=utf-8` only).
  Empty body, malformed UTF-8, UTF-8 BOM, malformed JSON, duplicate JSON keys,
  non-object root, missing/non-object `order` и ambiguous oneOf не дают positive.
- Fatal UTF-8 decode; replacement characters не допускаются. JSON depth/member/
  array limits вводятся вместе с body cap для CPU/memory safety.
- Unknown schema properties не переименовываются и не влияют на state; raw bytes
  сохраняют их для evidence. Duplicate known или unknown keys reject как ambiguous.

## Offline fixture matrix до сети

Все fixtures — synthetic/sanitized exact bytes, traceable к pinned OpenAPI и
Seaport docs. Positive fixture manifest указывает official fields/rules и expected
body/envelope hashes.

1. Valid active basic ERC721 Listing envelope, including strict Date and quantity.
2. Exact INACTIVE, FULFILLED, CANCELLED и EXPIRED enum fixtures; EXPIRED time
   consistent. Никаких invented legacy booleans.
3. Missing/unknown/non-string status; contradictory ACTIVE quantity/time и EXPIRED time.
4. Wrong/missing order hash, chain, protocol address, asset contract/id.
5. Missing asset identifier; disagreement asset vs offer; missing protocol_data.
6. Missing/malformed offer, empty/multiple offer items, wrong item type/token/id,
   changing amount, ERC1155 and criteria item types 4/5.
7. FULL_OPEN numeric 0 accepted; partial/restricted/contract order types rejected;
   private/restricted semantic fixture remains unsupported.
8. Official camelCase accepted; snake_case-only and mixed aliases rejected.
9. Wrapper absent/null/array; order null/array; ambiguous Listing/Offer; SVM shape.
10. `remaining_quantity` safe/unsafe int64 boundaries, exponent/fraction/negative;
    unsafe `counter` and `order_created_at`; string uint256 extremes preserved.
11. Unknown fields accepted semantically without changing canonical observation;
    raw body hash must change when bytes change.
12. Date valid, boundary-safe, missing, duplicate, obs-date, malformed, impossible,
    future/stale, Age present (including zero), local clock jump; retry Date isolation.
13. HTTP 404 -> UNKNOWN; 400/401/403/409; general 429 + Retry-After; every 5xx;
    unknown 2xx/3xx/4xx fail closed.
14. Every low-level transport code and unknown code; retry exhaustion preserves
    final code and attempt chain.
15. Identity/no encoding; gzip/br/deflate rejected; valid/malformed/mismatched
    Content-Length; empty/truncated/over-cap body.
16. Malformed UTF-8, BOM, duplicate keys, malformed JSON, scalar/array JSON,
    excessive depth/members.
17. `responseBodySha256` exact-byte determinism (whitespace/key order differ),
    envelope hash determinism and non-synonym property, persisted linkage tamper.
18. Runtime provenance/clone forgery, journal fence changes, authority and
    deactivationAuthority always false, no production mutation.

## Live gate

Live execution остаётся **CLOSED**. До первого exact-order probe обязательны:

1. official response schema pinned in code/fixtures;
2. status mapping pinned;
3. observation-time policy pinned;
4. pure adapter implemented;
5. adversarial offline tests PASS;
6. HTTP transport implemented;
7. localhost HTTPS transport matrix PASS;
8. secret-redaction audit PASS;
9. timeout/retry/cleanup audit PASS;
10. natural child-process exit proof;
11. independent code audit;
12. отдельное явное разрешение пользователя на live API-key use.

До этого: никаких OpenSea order calls, DB writes, listing deactivation или live
authority. Нынешние `authorityGranted` и `deactivationAuthorityGranted` остаются false.

## Findings и следующий этап

Severity totals: **BLOCKER 3, HIGH 5, MEDIUM 4, LOW 2**; подробный реестр находится
в companion current-state report. Secondary constraints: observation Date policy
должна пройти независимый аудит, а JSON losslessness нельзя делегировать native
Number parsing.

Official schema: **достаточна**. Status enum: **официально подтверждён**, derivation
не нужна. Observation time: **strict HTTP Date accepted conditionally; no local
fallback**. JSON precision: **native JSON.parse alone unsafe**. Transport handoff:
**new versioned observation + explicit low/high error mapping required**.

Следующий engineering stage: **pure response adapter implementation** с type/
verifier contract remediation и полным offline fixture matrix. HTTP transport
implementation пока не авторизована и не должна начинаться автоматически.
