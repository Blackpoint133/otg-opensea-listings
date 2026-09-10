# Pure OpenSea exact-order response adapter

## Scope and authority

Baseline: `62848848bff6ffd5013e118013b71b6cd13f64aa`. Official provider evidence was retrieved 2026-09-10 from [Get Order](https://docs.opensea.io/reference/get_order) and the [OpenSea model reference](https://docs.opensea.io/page/model-reference). The pinned endpoint is `GET https://api.opensea.io/api/v2/orders/chain/{chain}/protocol/{protocol_address}/{order_hash}` with `x-api-key` authentication performed only by a future transport (not this change). The adapter uses the documented wrapped `{ order: ... }` response and snake_case model fields.

## Architecture

`OpenSeaExactOrderRawInput` is a transport-style, offline value containing exact entity bytes, safe allowlisted metadata, status and timing metadata. `adaptOpenSeaExactOrder` performs only pure byte/hash/UTF-8/JSON/schema interpretation and emits immutable, module-provenanced `OpenSeaExactOrderObservationV1`. `interpretOpenSeaExactOrderObservation` is the normalizer handoff to the existing ProviderResult contract; it does not parse JSON again. The legacy `interpretTargetedOrderResponse` remains an explicitly compatibility-only parser for existing offline fixtures and is not used by the new adapter path.

Exact bytes are hashed before decoding; whitespace changes therefore change `responseBodySha256`. Fatal UTF-8 decoding, BOM rejection, duplicate-key rejection, body cap (1 MiB), identity content-encoding policy, response hash verification and 404-as-UNKNOWN are enforced. Numeric identifier/quantity/time values are retained as canonical decimal strings and never converted through `Number`.

Only an unambiguous Seaport Listing is positive: wrapped order, exact local order/chain/protocol/contract, three-way token identity (asset identifier, offer identifier and trusted local token), one ERC721 offer (`item_type=2`), token contract match, unit amounts, FULL_OPEN/order type 0 and documented status enum. Offer, criteria, ERC1155, private/restricted, multi-item and unsupported shapes are fail-closed. Provider status is limited to ACTIVE, INACTIVE, FULFILLED, CANCELLED and EXPIRED; 404 is never inactive evidence. A valid IMF-fixdate-style HTTP Date is canonicalized to UTC; missing/malformed Date, Age and unsupported encodings prevent positive time-dependent evidence. Authority fields remain literal false.

The observation has a private WeakSet runtime provenance marker; clones and manually-shaped values cannot enter the adapter normalizer. No adapter result grants database or deactivation authority.

## Versioning

`OPENSEA_EXACT_ORDER_ADAPTER_VERSION=opensea-exact-order-adapter-v1-2026-09` identifies this new schema. The endpoint/provider contract identifier remains `opensea-get-order-v1-2026-05` because the documented endpoint contract itself is unchanged. `TARGETED_VERIFIER_NORMALIZER_VERSION` is bumped to `targeted-verifier-normalizer-v2-2026-09` because the trusted semantic input now includes the canonical observation. Candidate v3, envelope v3, generation v2, barrier v2, verifier schema v4 and policy v5 remain unchanged; the observation is not yet persisted in AttemptEvidence.

## Changed files and limitations

Changed runtime files: `src/reconciliation/verifier/openSeaExactOrderAdapter.ts`, `src/reconciliation/verifier/targetedVerifierNormalizer.ts`, `src/reconciliation/verifier/targetedVerifierTypes.ts`. Tests: `tests/openSeaExactOrderAdapter.test.ts`. The current stage is pure/offline and intentionally does not implement HTTP transport, retries, live calls, API-key handling, persistence or the future provider adapter's richer temporal reconciliation. Those remain separately audited work.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE/API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
