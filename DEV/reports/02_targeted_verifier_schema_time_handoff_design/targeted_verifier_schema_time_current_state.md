# Текущее состояние exact-order schema/time handoff

Дата ревью: 2026-09-10. Задача является design/research/audit-only: исходный код,
PostgreSQL и production state не изменялись; запрос к exact-order endpoint и
использование API-ключа не выполнялись.

## Итог

Основной outcome: **B. HANDOFF DESIGN VALIDATED — PURE RESPONSE ADAPTER REQUIRED**.

Официальная схема достаточна для проектирования fail-closed адаптера, но текущая
передача raw JSON напрямую в `interpretTargetedOrderResponse` небезопасна. Главные
несовместимости: обязательная оболочка `order`, числовой `remaining_quantity` и
отсутствие отдельного versioned transport observation/adapter boundary.

Итоговый реестр: **BLOCKER 3, HIGH 5, MEDIUM 4, LOW 2**. Эти BLOCKER запрещают
переход к HTTP transport, но не блокируют сам design outcome.

## Авторитетные источники

Для provider contract использованы только официальные страницы OpenSea:

1. [Get an order](https://docs.opensea.io/reference/get_order) — метод, host,
   путь, path parameters, credential header и документированные HTTP statuses.
2. [LLMs and agent discovery](https://docs.opensea.io/reference/llms-agent-discovery)
   — OpenSea называет live
   [OpenAPI document](https://api.opensea.io/api/v2/openapi.json) рекомендуемым
   источником endpoint/request/response schemas и authentication requirements.
3. [API Overview](https://docs.opensea.io/reference/api-overview) — все REST
   requests требуют `x-api-key`; JSON является default без opt-in TOON Accept.
4. [Model Reference](https://docs.opensea.io/page/model-reference) — отдельная
   human-readable legacy/order model page; её расхождения с live OpenAPI отмечены,
   но она не заменяет schema целевого operation.
5. [Seaport Models](https://docs.opensea.io/docs/seaport-models) и
   [Seaport Enums](https://docs.opensea.io/docs/seaport-enums) — значения
   `OrderType`, `ItemType` и on-chain смысл `startTime`, `endTime`, offer fields.
6. [Removing deprecated REST API endpoints and response fields](https://docs.opensea.io/changelog/removing-deprecated-rest-api-endpoints-and-response-fields)
   — exact-order endpoint остаётся рекомендованным для individual lookup.

Публичный OpenAPI получен без credential и без вызова order endpoint. Снимок на
дату ревью: OpenAPI `3.1.0`, API `2.0.0`, operationId `get_order`, SHA-256 полных
полученных bytes `0eb6064de6251f256972b8c6821955e834767372ee3144ca7fb7e8e90849b291`.
200 schema: `#/components/schemas/GetOrderResponse`. Этот digest является
исследовательским provenance, а не обещанием неизменности будущего live документа.

Для HTTP `Date`/cache semantics использованы standards-track
[RFC 9110 §6.6.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-6.6.1) и
[RFC 9111 §5.1](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.1).
Это стандарты транспорта, не дополнительный OpenSea provider schema.

## Официальный endpoint contract

- Метод и URL: `GET https://api.opensea.io/api/v2/orders/chain/{chain}/protocol/{protocol_address}/{order_hash}`.
- Обязательные path parameters: `chain`, `protocol_address`, `order_hash`.
- `chain` ссылается на `ChainIdentifier`; `gunzilla` входит в официальный enum.
- Root OpenAPI security: `ApiKeyAuth`, API key в header `x-api-key`.
- Endpoint page документирует `200`, `400`, `401`, `403`, `404`, `409`, `500`.
  Общая OpenSea rate-limit документация также описывает `429` и `Retry-After`.
- Live OpenAPI для operation содержит `200`, reusable `BadRequest` (`400`) и
  `InternalError` (`500`); endpoint page остаётся источником остальных status.
- `200` возвращает `GetOrderResponse`: обязательный object property `order`,
  который является `oneOf: Listing | Offer`.
- Endpoint page визуально не показывает body fields, но официальный live OpenAPI
  явно связывает operation с reusable `GetOrderResponse` и вложенными моделями.

## Проверенный текущий код

| Файл / функция | Фактический контракт |
| --- | --- |
| `src/reconciliation/verifier/targetedVerifierTypes.ts:3-16` | v1 schema/policy/provider/normalizer constants; endpoint path совпадает; `ProviderStatus` содержит точный официальный enum; `TransportOutcome` ограничен `HTTP/TIMEOUT/CONNECTION_RESET`. |
| `targetedVerifierTypes.ts:79-127` | safe headers, normalized order и `ProviderResult`; authority и deactivationAuthority типизированы только как `false`. |
| `targetedVerifierNormalizer.ts:60-65` | hash строится по входным bytes, UTF-8 decode fatal, затем native `JSON.parse`. Вход всё ещё допускает string, который перед hash повторно UTF-8 кодируется. |
| `targetedVerifierNormalizer.ts:75-99` | basic ERC721 shape проверяет camelCase `offer` fields, единственный item, itemType 2, token/id и amounts `"1"`; restricted/criteria shapes fail closed. |
| `targetedVerifierNormalizer.ts:101-141` | ожидает order fields на top level, `remaining_quantity` как decimal string и прямой provider `status`; ACTIVE требует quantity и temporal window. |
| `targetedVerifierNormalizer.ts:144-163` | verifier остаётся pure; 404 даёт UNKNOWN; transport outcome обрабатывается до JSON; raw JSON поступает прямо в provider normalizer. |
| `targetedVerifierPolicy.ts:83-101` | eligibility закрепляет scope/version/provenance и отсутствие authority. |
| `targetedVerifierArtifact.ts:10-46` | journal fence применён после provider interpretation и независимо блокирует изменившийся/ambiguous journal. |
| `targetedVerifierArtifact.ts:59-110` | artifact копирует provider result/hash/headers, а authority/deactivationAuthority остаются false. |
| `tests/targetedVerifierNormalizer.test.ts:29-33` | основная fixture имеет неофициальный top-level order и строковый `remaining_quantity`; оболочки `order` нет. |
| `tests/targetedVerifierNormalizer.test.ts:58-203` | покрыты identity, ACTIVE time/quantity, enum states, 404, transport failure, fence, hashes, criteria, exact offer и runtime provenance. |

Network, DB или filesystem-writer capability в pure verifier не обнаружена.
Journal fence не смешан с provider interpretation. Runtime WeakSet provenance
защищает созданные normalizer/fence values от доверия к клонам. Положительные
результаты runtime требуют HTTP 200, body hash, observation time и non-retryable
metadata. 404 никогда не становится inactive. Эти свойства должны сохраниться.

## Точное сопоставление полей

Required/optional ниже относится к live OpenAPI. Поле может быть optional в schema,
но стать обязательным для положительного OTG evidence по более строгой policy.

| Официальное поле | Тип / required | Текущее ожидание | Класс | Требуемая remediation |
| --- | --- | --- | --- | --- |
| root `order` | object, required; `oneOf Listing/Offer` | отсутствует, reads root directly | MISMATCH | Adapter строго unwraps ровно один `order` и подтверждает Listing branch. |
| `order.order_hash` | string, schema optional; description: every EVM order has one | top-level canonical hash, required | MATCH name, MISMATCH level | Для EVM positive требовать exact hash и отсутствие `svm_order` ambiguity. |
| `order.chain` | string, required | top-level exact context chain | MATCH name, MISMATCH level | Unwrap и exact equality; `gunzilla` официально поддерживается. |
| `order.protocol_address` | string, optional | top-level canonical address, required | MATCH name, MISMATCH level | Для positive требовать canonical exact path/context address. |
| `order.protocol_data` | `ProtocolData`, optional | top-level object, required | MATCH name, MISMATCH level | Для Seaport positive обязательно; `parameters` required. |
| `order.asset.contract` | string, `contract` required if asset exists; asset optional | top-level asset contract required | MATCH name, MISMATCH level | Для positive требовать asset и сверять с context и offer token. |
| `order.asset.identifier` | string, optional | optional decimal string | AMBIGUOUS for positive | Для single-NFT positive сделать обязательным и exact equal offer id/context token id. |
| `order.status` | required string enum `ACTIVE/INACTIVE/FULFILLED/EXPIRED/CANCELLED` | тот же enum | MATCH, MISMATCH level | Не выводить из legacy booleans; переносит adapter без alias. |
| `order.remaining_quantity` | integer `int64`, required | decimal string only | MISMATCH type/level | Lossless lexical integer parse; canonical decimal string only после range/integrity checks. |
| `parameters.startTime` | string, required | decimal string camelCase | MATCH | Не принимать `start_time` alias в exact-order adapter. |
| `parameters.endTime` | string, required | decimal string camelCase | MATCH | Не принимать `end_time` alias. |
| `parameters.offer` | array, required | optional array, если есть — ровно один | AMBIGUOUS strictness | Для positive требовать ровно один NFT offer item. |
| `offer[*].itemType` | integer int32, required | numeric 2; частично принимает string criteria marker | MATCH для 2 | Принимать только integer 2; 4/5 criteria unsupported; strings rejected. |
| `offer[*].token` | string, required | canonical address | MATCH | Exact equality asset/context contract. |
| `offer[*].identifierOrCriteria` | string, required | decimal string | MATCH | Exact canonical decimal and token-id equality; criteria fail closed. |
| `offer[*].startAmount` | string, required | exact `"1"` | MATCH | Для ERC721 single listing exact 1. |
| `offer[*].endAmount` | string, required | exact `"1"` | MATCH | Для ERC721 single listing exact 1. |
| `parameters.consideration` | required array, nested fields use camelCase | не валидируется полноценно | UNDOCUMENTED by current logic | Adapter validates structural model; verifier need not derive NFT identity from it for a listing. |
| `parameters.orderType` | integer int32, required | probes it, но также принимает aliases/strings | MISMATCH strictness | Для v1 positive only numeric `0` (`FULL_OPEN`); other OrderType fail closed. |
| `parameters.counter` | integer, required, no format | не consumed | OFFICIAL, precision risk | Lossless parse; preserve canonical decimal; never Number-roundtrip. |
| `parameters.salt` | string, required | не consumed | OFFICIAL | Preserve only if canonical adapter schema needs it; not semantic state. |
| `parameters.totalOriginalConsiderationItems` | int32, required | не consumed | OFFICIAL | Safe Number subset after integer/range validation. |
| `order.type` | required string for Listing | current `body.order_type` alias | MISMATCH | Validate Listing branch; do not equate undocumented string semantics with Seaport `orderType`. |
| `order.price.current.value` | string, required through Listing price | current_price not consumed | OFFICIAL | Not needed for state/identity; validate branch structure, retain raw hash. |
| `order.order_created_at` | optional int64 | no expectation | OFFICIAL, precision risk | Lossless parse or ignore semantically after lexical validation. |
| `current_price` | absent from live GetOrderResponse; present on older Model Reference | not consumed | UNDOCUMENTED for target schema | No alias. Live `price` model governs. |
| `maker` / `taker` / `side` | absent from live GetOrderResponse; legacy Model Reference only | partially probes no such fields | UNDOCUMENTED for target schema | Do not use for v1 adapter decisions. Offerer is `parameters.offerer`. |
| `created_date`, `created_at`, `closing_date`, `expiration_time` | absent from live GetOrderResponse; some legacy Model Reference names | not consumed | UNDOCUMENTED for target schema | Do not alias; expiration derives only from official `parameters.endTime`. |
| `canceled`, `cancelled`, `finalized`, `marked_invalid` | absent from live GetOrderResponse; legacy page lists `canceled/finalized/marked_invalid` | current probes none for status | UNDOCUMENTED for target schema | Never derive current status from these fields. Exact `status` is authoritative field. |
| `is_private`, `private_listing`, `restricted` | absent from live target schema | current probes booleans | UNDOCUMENTED | No alias; reject non-FULL_OPEN via official `parameters.orderType`. |

Называние в официальных материалах не единообразно: legacy Model Reference
показывает `start_time`, `end_time`, `item_type`, `identifier_or_criteria`, но live
OpenAPI exact-order closure показывает `startTime`, `endTime`, `itemType`,
`identifierOrCriteria`, `startAmount`, `endAmount`. Для этого endpoint решение
закрепляется по live OpenAPI, который OpenSea рекомендует для response validation.

## Status-model verdict

`ProviderStatus` **VALID AS-IS на уровне enum**: live `Listing` и `Offer` прямо
документируют те же пять значений. Derivation из `canceled/finalized/marked_invalid`
не нужна и запрещена. Однако прямой current ingestion несовместим с envelope/type,
а официальная schema не объясняет business semantics enum сверх имён. Поэтому
адаптер должен сохранять точное значение, а verifier policy — явно и консервативно
определять результат. `INACTIVE` означает только «OpenSea ответил INACTIVE», не
cancelled/fulfilled и не deactivation authority.

Текущая реализация также имеет runtime inconsistency: ветви INACTIVE/FULFILLED/
CANCELLED/EXPIRED вызывают `base`, но `validateProviderResult` требует для любого
positive result non-null `observedAt`; при его отсутствии constructor бросит
`INVALID_NORMALIZER_PROVIDER_RESULT`, вместо детерминированного UNKNOWN. Это HIGH
contract-remediation finding, не изменение в рамках этого ревью.

## Findings

### BLOCKER

1. **B1 — raw envelope mismatch.** Current normalizer читает order на root, тогда
   как официальный response требует root `order`.
2. **B2 — lossless integer/type mismatch.** `remaining_quantity` официально JSON
   int64, current normalizer требует string; native JSON.parse не сохраняет точную
   лексему для всех int64.
3. **B3 — отсутствует versioned handoff.** Low-level transport taxonomy,
   observation-time provenance и adapter provenance нельзя безопасно выразить
   текущим `TransportOutcome`/raw input.

### HIGH

1. H1 — тестовые positive fixtures не соответствуют официальным envelope/type.
2. H2 — positive status/time policy не полностью fail-closed при missing time и
   не проверяет противоречивый EXPIRED против `endTime`.
3. H3 — `asset.identifier` optional в schema; positive identity должна требовать
   одновременное exact совпадение asset и offer.
4. H4 — нет строгой Date/Age/cache/skew policy и отдельного provenance времени.
5. H5 — boundary durable raw artifact и различие двух hashes формально не закреплены.

### MEDIUM

1. M1 — legacy Model Reference конфликтует с live OpenAPI по naming/types.
2. M2 — current order-type aliases шире официального `parameters.orderType`.
3. M3 — endpoint/OpenAPI/general rate-limit страницы дают разные наборы HTTP status;
   mapping должен быть полным и fail closed.
4. M4 — content encoding, cap, Content-Length, BOM/UTF-8/JSON policies пока не
   представлены отдельным handoff contract.

### LOW

1. L1 — unknown JSON fields допустимы schema; их следует игнорировать семантически,
   сохраняя raw bytes/hash и schema provenance.
2. L2 — provider/normalizer/schema/policy v1 identifiers нельзя сохранять после
   изменения официальной schema boundary и semantics.

## IDENTITY PROVENANCE AMENDMENT

### Фактический ответ на вопрос provenance

В текущем main **trusted expectedTokenId не существует**.

Проверенные границы:

- `OfflineLocalOrder` (`offlineCandidateModel.ts:75-84`) содержит `orderHash`,
  status/active/reconciliation flags и event timestamps, но не `chain`,
  `contractAddress`, `tokenId`, `collectionSlug` или `protocolAddress`.
- `OfflineOrderExplanation` и `OfflineCandidateBundle` (`offlineCandidateModel.ts:103-135`)
  переносят только `orderHash`, classification, reasons и journal summaries.
- `SeenOrder`/`SeenOrderRecord` (`offlineCandidateModel.ts:63-70`,
  `evidenceTypes.ts:48-54`) хранят order hash, page number и hashes, но не NFT
  identity payload.
- `CandidateEvidenceEnvelope` и `BarrierEvidenceEnvelope`
  (`reconciliationEvidenceIntegration.ts:10-36`) хешируют payload и связывают
  barrier с `candidateArtifactHash`, но payload candidate сейчас не содержит
  token ID. `candidateGenerationConsistent` сравнивает только orderHash и
  classification (`reconciliationEvidenceIntegration.ts:63-70`).
- `OfflineGenerationCandidateAdvance` переносит orderHash/classification,
  eligibility и reasons; token identity там отсутствует.
- `TargetedVerifierContext` (`targetedVerifierTypes.ts:49-74`) содержит order,
  chain, collection, contract, protocol и artifact hashes, но expected token ID
  отсутствует. `validateTargetedVerifierEligibility` не может проверить его
  provenance.

Наличие `token_id` в PostgreSQL, `NormalizedActiveListing.tokenId` или отдельных
event/NFT rows не является доказательством handoff: ни один источник сейчас не
входит в validated candidate bundle и не связан его content hash с targeted
verifier context. Caller мог бы подменить well-formed token string.

### Выбранная минимальная архитектура: option B

**B. Extend candidate output/evidence with canonical local NFT identity and derive
`TargetedVerifierContext` only from that persisted identity.**

Option A (`expectedTokenId` только в context) отклонён: поле было бы syntactically
valid, но caller-controlled. Option C (parallel identity artifact) создаёт второй
источник истины и новую consistency surface; существующий candidate envelope уже
является durable hashed handoff.

Единая canonical identity в candidate payload:

```text
{
  orderHash: lower-case 0x + 64 hex,
  chain: canonical supported chain,
  contractAddress: lower-case 0x + 40 hex,
  tokenId: canonical unsigned decimal string (0 or non-zero без leading zero),
  collectionSlug: non-empty canonical slug,
  protocolAddress: lower-case 0x + 40 hex
}
```

`nftId` может быть derived presentation value, но не отдельный source of truth.
Новый context constructor принимает только reconstructed VALID integrated evidence,
находит ровно один candidate entry по orderHash, проверяет classification/identity,
candidate payload hash, envelope contentHash и barrier link, затем копирует identity
в immutable context. `expectedTokenId` нельзя передать отдельным caller argument.

Trusted chain:

```text
local active order identity
 -> OfflineLocalOrder identity input
 -> OfflineOrderExplanation.identity (candidate model v2)
 -> candidateBundleHash / candidate envelope v2 / durable contentHash
 -> barrier candidateArtifactHash + generation eligibility
 -> reconstructed VALID integrated evidence
 -> derived TargetedVerifierContext.expectedTokenId
 -> adapter compares provider asset.identifier == offer.identifierOrCriteria
    == context.expectedTokenId
 -> ProviderResult / durable artifact
```

Boundary requirements: local input, candidate payload и context несут orderHash,
chain, contractAddress, tokenId, collectionSlug и protocolAddress из одной
canonical identity. Envelope commits payload hash; barrier не дублирует token ID,
а связывается с exact candidate artifact hash. Adapter сохраняет provider value
отдельно от expected local value.

### Order hash is necessary but not sufficient

Seaport order hash — cryptographic identity signed order, но не proof ожидаемого
NFT: order может быть ERC1155, criteria, multi-item или просто связан с другим
локальным NFT. Agreement OpenSea `asset` и Seaport offer доказывает только provider
response consistency и не защищает от wrong response material/provider-schema bug.

Положительное evidence требует:

```text
trusted local candidate tokenId
  == OpenSea order.asset.identifier
  == OpenSea protocol_data.parameters.offer[0].identifierOrCriteria
```

Плюс exact orderHash/chain/contract/protocol, один ERC721 offer, quantity и все
существующие status/time gates. Same token с несколькими order hashes допустим как
разные contexts; unrelated tokens reject. `7` canonical, `007` reject.

### Version consequences

Предыдущие totals `BLOCKER 3 / HIGH 5 / MEDIUM 4 / LOW 2` изменяются на
**BLOCKER 4 / HIGH 6 / MEDIUM 4 / LOW 2**:

- новый **B4**: trusted candidate-to-context NFT identity handoff отсутствует;
- новый **H6**: candidate/barrier reconstruction сравнивает только orderHash/class.

Required changes:

- `OFFLINE_CANDIDATE_MODEL_VERSION`: bump v1 -> v2, candidate gains identity;
- `CANDIDATE_ENVELOPE_SCHEMA_VERSION`: bump v1 -> v2, persisted payload/hash changes;
- `TARGETED_VERIFIER_SCHEMA_VERSION`: bump v1 -> v2, context/attempt/artifact proof changes;
- `TARGETED_VERIFIER_POLICY_VERSION`: bump v1 -> v2, three-way identity policy changes;
- `OFFLINE_GENERATION_MODEL_VERSION`: retain v1 if advancement remains
  orderHash/classification and `candidateArtifactHash` remains the binding;
- `BARRIER_ENVELOPE_SCHEMA_VERSION`: retain v1 for minimal design because barrier
  payload is unchanged and already commits candidate content hash. If identity is
  duplicated into advancement/barrier, both generation and barrier versions must bump.

## Gate

Official schema sufficiency: **SUFFICIENT FOR A PINNED PURE ADAPTER**.
Status-model verdict: **enum valid as-is; explicit adapter/policy mapping required**.
Direct raw normalizer input: **UNSAFE**. HTTP implementation и live gate остаются
закрыты. Следующий этап: **pure response adapter implementation** вместе с
versioned handoff types и offline fixtures; не HTTP transport.
