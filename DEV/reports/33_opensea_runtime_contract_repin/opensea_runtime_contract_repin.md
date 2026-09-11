# Task 33 — OpenSea runtime contract repin

## Scope and baseline

Baseline: `e6a17c7e808fb9121ee746fd449a719db330194c`.

This change repins the pure offline exact-order adapter to the immutable Task-32 evidence. It does not implement transport, call Get Order, read an API key, persist evidence, mutate a database, or grant deactivation authority.

## Historical and current pins

| Axis | Historical runtime value | Current authoritative value |
|---|---|---|
| Full OpenAPI SHA-256 | `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922` | `f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e` |
| Full document bytes | 590486 (historical bytes unavailable) | 581930 |
| Get Order schema SHA-256 | `62043c23a7622336adfe1919386f9f8ff668d398ce166397f93dc1df405a6dfc` | `9cd70ac9d6b96532015ab0ce2e13a5220f69e6bc3b97baa66033c04834d6dc90` |
| Extraction | historical disputed graph | `sorted-json-v1`, exact 200 response and recursive local-schema closure |
| Immutable source | unavailable | `DEV/upstream/opensea/openapi/2026-09-11_f9b79429a3e7b095/openapi.json` |

The runtime observation now carries the current full-document and extracted-schema hashes.

## Exact official admission

The admission gate remains a stateless direct early return in `adaptOpenSeaExactOrder`. The accepted architecture and WeakMap bindings are unchanged.

Official Listing requirements are `chain`, `price`, `remaining_quantity`, `status`, and `type`. The official layer no longer labels `order_hash`, `protocol_address`, `protocol_data`, or `asset` as Listing-required. Those optional fields are type-checked when present and remain mandatory for the later targeted EVM identity proof.

When `protocol_data` is present, `ProtocolData.parameters` and all twelve official Parameters requirements are validated. Every nonempty Item and ConsiderationItem array entry is validated. ConsiderationItem `recipient` remains required because the captured component explicitly requires it.

## Price remediation

`Listing.price` references `ListingPrice`. `ListingPrice` requires `current`, which references `Price`. `Price` requires:

- `currency`: JSON string
- `decimals`: JSON integer, signed int32
- `value`: JSON string

`price: {}`, missing `current`, null objects, missing nested requirements, wrong primitive types, and int32 overflow now fail official admission. No additional economic restrictions are imposed.

## Official integer semantics

Dedicated admission helpers operate on the lossless numeric token. They recognize exact JSON Schema mathematical integers, including `-0`, `1.0`, `-1.0`, and integral exponent forms such as `1e2`; `1.5` and `1e-1` are not integers. No JavaScript Number conversion occurs before the exact mathematical analysis and range proof.

Signed int32 bounds are applied to Price.decimals, Item.itemType, ConsiderationItem.itemType, Parameters.orderType, and Parameters.totalOriginalConsiderationItems. Signed int64 bounds are applied to Listing.remaining_quantity. Parameters.counter is an unbounded official JSON integer because the captured schema declares no format/range.

After official admission, targeted semantics remain stricter where independently required: offer itemType 2, orderType 0, exact EVM/NFT identity, exactly one offer item, fixed NFT amounts, nonnegative remaining quantity, and temporal proof.

## Cardinality and semantic split

The exact schema declares no `minItems` for Parameters.offer or Parameters.consideration. Official admission therefore accepts both empty arrays as array shapes and validates entries only when present.

- Empty offer: official-schema valid, then targeted-unsupported because there is not exactly one NFT offer.
- Empty consideration: official-schema valid and does not acquire a new targeted restriction in this task.
- Signed `orderType=-1`: official int32 valid, then targeted-unsupported.
- Missing optional outer EVM identity fields: not `OFFICIAL_SCHEMA_INVALID`, but fail closed under targeted identity/shape checks.

## Remaining quantity

- Missing: `OFFICIAL_SCHEMA_INVALID` because the Listing field is required.
- Below/above signed int64: `OFFICIAL_SCHEMA_INVALID`.
- Negative in-range: official-schema valid, then `REMAINING_QUANTITY_INVALID`.
- Zero for ACTIVE: `ACTIVE_QUANTITY_UNPROVEN`.
- Positive in-range, including exact integral fraction/exponent tokens: eligible for later targeted/temporal confirmation.

## Contract metadata and versions

| Version axis | Before | After | Decision |
|---|---|---|---|
| Provider contract | `opensea-get-order-v1-2026-05` | `opensea-get-order-v2-2026-09` | bumped for immutable current upstream identity and corrected schema semantics |
| Adapter | `opensea-exact-order-adapter-v5-2026-09` | `opensea-exact-order-adapter-v6-2026-09` | bumped because accepted/rejected provider bodies changed |
| Normalizer | `targeted-verifier-normalizer-v5-2026-09` | unchanged | mapping and trust-mint semantics unchanged |
| Policy | `targeted-verifier-policy-v8-2026-09` | unchanged | provider contract is a separate compatibility axis; policy logic unchanged |
| Durable schema | `targeted-verifier-schema-v4` | unchanged | no AttemptEvidence or TargetedVerifierArtifact byte-shape change |
| Candidate/envelope/generation/barrier | v3/v3/v2/v2 | unchanged | outside this contract repin |

## Runtime files changed

- `src/reconciliation/verifier/openSeaExactOrderContract.ts`
- `src/reconciliation/verifier/openSeaSchemaAdmission.ts`
- `src/reconciliation/verifier/openSeaExactOrderAdapter.ts`
- `src/reconciliation/verifier/targetedVerifierTypes.ts`

No accepted parser/provenance/normalizer architecture was redesigned.

## Self-review

BLOCKER 0, HIGH 0, MEDIUM 0, LOW 0.

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE
