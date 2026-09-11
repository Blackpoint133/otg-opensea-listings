# Task 32 - OpenSea OpenAPI evidence rebaseline

Baseline: `9ef8bc64b767cac426af67ebe47f63e10190e222`.

## Immutable upstream evidence

The only retrieved URL was the public documentation document `https://api.opensea.io/api/v2/openapi.json`. No Get Order request was made.

Two independent retrievals produced identical bytes:

| Retrieval | UTC timestamp | Bytes | SHA-256 |
|---|---|---:|---|
| 1 | `2026-09-11T06:34:34.4537741Z` | 581930 | `f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e` |
| 2 | `2026-09-11T06:34:35.6774280Z` | 581930 | `f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e` |

The exact first response entity is committed without reserialization or newline normalization at `DEV/upstream/opensea/openapi/2026-09-11_f9b79429a3e7b095/openapi.json`.

The previous historical pin remains documented as SHA-256 `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922`, 590486 bytes, with `sourceBytesAvailable: false`. It is not current schema authority.

## Extraction algorithm

`scripts/lib/openseaGetOrderSchemaExtraction.mjs` is offline-only. It hashes exact input bytes, requires the new SHA and byte length, and only then parses JSON. It selects:

- path: `/api/v2/orders/chain/{chain}/protocol/{protocol_address}/{order_hash}`
- method: `GET`
- operationId: `get_order`
- 200 media type: `*/*`
- root schema: `#/components/schemas/GetOrderResponse`

Starting at the exact 200 response object, it follows every local `#/components/schemas/...` reference to closure and copies the exact parsed source components. The generated fixture format is `{source,response,components:{schemas}}` without timestamps.

Canonicalization `sorted-json-v1` recursively sorts object keys, preserves array order, uses compact `JSON.stringify`, encodes UTF-8, and hashes those bytes. The generated fixture is committed at `tests/fixtures/opensea_get_order_schema_2026-09-11_f9b79429.json`.

Current exact Get Order schema SHA-256: `9cd70ac9d6b96532015ab0ce2e13a5220f69e6bc3b97baa66033c04834d6dc90`.

## Complete dependency graph

- response -> GetOrderResponse
- GetOrderResponse -> Listing, Offer
- Listing -> ListingOrOffer, ListingPrice, OrderAsset, ProtocolData, SvmOrderIdentity
- Offer -> ListingOrOffer, OrderAsset, Price, ProtocolData, SvmOrderIdentity, Criteria
- ListingPrice -> Price
- ProtocolData -> Parameters
- Parameters -> Item, ConsiderationItem
- Criteria -> CollectionInner, ContractInner, NumericTraitData, TraitData
- CollectionInner, ContractInner, NumericTraitData, TraitData, Item, ConsiderationItem, ListingOrOffer, OrderAsset, Price, SvmOrderIdentity -> no further local schema refs

The 17 copied schemas are: CollectionInner, ConsiderationItem, ContractInner, Criteria, GetOrderResponse, Item, Listing, ListingOrOffer, ListingPrice, NumericTraitData, Offer, OrderAsset, Parameters, Price, ProtocolData, SvmOrderIdentity, TraitData. Actual JSON Pointer closure reports zero unresolved refs.

## Derived schema facts

Listing.price follows `Listing.allOf[1].properties.price -> ListingPrice -> current -> Price`.

- ListingPrice: object; required `current`; no nullable or additionalProperties declaration.
- Price: object; required `currency`, `decimals`, `value`; `currency` and `value` are strings; `decimals` is integer/int32; no nullable, enum, or additionalProperties declaration.

ConsiderationItem is an object requiring `itemType`, `token`, `identifierOrCriteria`, `startAmount`, `endAmount`, and `recipient`. `itemType` is integer/int32; the other five are strings. Therefore recipient required: YES.

Parameters.offer and Parameters.consideration are arrays of Item and ConsiderationItem respectively. Neither declares `minItems` nor `maxItems`:

- offer minItems: NONE
- consideration minItems: NONE

Effective required sets:

- Listing: `chain`, `price`, `remaining_quantity`, `status`, `type`
- ListingOrOffer: none
- Parameters: `conduitKey`, `consideration`, `counter`, `endTime`, `offer`, `offerer`, `orderType`, `salt`, `startTime`, `totalOriginalConsiderationItems`, `zone`, `zoneHash`
- Item: `endAmount`, `identifierOrCriteria`, `itemType`, `startAmount`, `token`
- ConsiderationItem: `endAmount`, `identifierOrCriteria`, `itemType`, `recipient`, `startAmount`, `token`
- ListingPrice: `current`
- Price: `currency`, `decimals`, `value`

## Current runtime admission comparison

Runtime behavior was audited but intentionally not changed.

| Current rule | Classification against exact OpenAPI |
|---|---|
| `price: {}` accepted | TOO LOOSE: ListingPrice requires `current` |
| `price.current.currency/value` strings | CONFIRMED |
| `price.current.decimals` generic unsigned integer | TOO LOOSE for int32 upper range and TOO STRICT for signed int32 |
| consideration `recipient` required | CONFIRMED |
| `offer.length > 0` | UNSUPPORTED BY OPENAPI / TOO STRICT; no minItems |
| `consideration.length > 0` | UNSUPPORTED BY OPENAPI / TOO STRICT; no minItems |
| Item/ConsiderationItem `itemType` generic unsigned integer | TOO LOOSE for int32 upper range and TOO STRICT for signed int32 |
| `orderType` nonnegative int32 | TOO STRICT versus signed OpenAPI int32; targeted Seaport semantics may constrain it later |
| `counter` canonical unsigned integer | UNSUPPORTED BY OPENAPI / TOO STRICT; schema says integer without format/range |
| admission `remaining_quantity` unsigned without int64 upper bound | TOO LOOSE at helper boundary; adapter later enforces the int64 upper bound |
| require `order_hash`, `protocol_data`, `protocol_address`, `asset` as official Listing-required | TOO STRICT as OpenAPI admission; these are stronger targeted verifier identity requirements and should be separated later |

## Old disputed fixture comparison

The old fixture flattened nine manually reduced component objects at its root and serialized to 2825 compact bytes. The new generated fixture contains the exact 17-component dependency closure under `components.schemas` and is 7980 canonical bytes. The old fixture omitted official component detail and simplified the schema graph. Because the historical full source document is unavailable, specific historical upstream field changes cannot be established.

## Runtime boundary

Runtime pins and runtime admission code were intentionally NOT changed. `OPENAPI_DOCUMENT_SHA256`, `GET_ORDER_SCHEMA_SHA256`, `OPENSEA_ORDER_CONTRACT_VERSION`, the adapter, normalizer, and policy remain untouched pending audit of this evidence.

RUNTIME PROVIDER CONTRACT NOT REPINNED YET

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE
