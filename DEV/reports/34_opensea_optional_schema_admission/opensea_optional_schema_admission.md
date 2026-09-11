# Task 34 — optional OpenAPI field admission

Baseline: `f82602b9f3384283fde14c81ce5015d0036545ec`.

This narrow remediation closes the captured Listing-schema admission gap without
changing the accepted parser, provenance, gate, normalizer, timing, or transport
architecture.  The immutable Task-32 OpenAPI snapshot and generated fixture were
left untouched.

The captured Listing schema permits optional `order_created_at` (integer/int64),
`protocol` (string), and `svm_order` (`SvmOrderIdentity`). `ProtocolData.signature`
is also optional string data.  The runtime admission validator now validates each
when present while preserving absence as valid. `SvmOrderIdentity` requires
`creation_signature`, `id`, `maker`, and `order_state` strings; optional `asset_id`
is validated as a string. `order_created_at` uses the existing lossless signed
int64 machinery, including mathematical integral spellings, without Number
conversion before range proof.

`ProtocolData.parameters` remains required and all prior Listing, Price,
Parameters, Item, ConsiderationItem, quantity, and optional EVM-object checks are
unchanged. No minItems or marketplace semantics were added. Malformed optional
fields fail through the existing stateless `OFFICIAL_SCHEMA_INVALID` early gate;
valid optional fields do not become targeted requirements.

The adapter semantic version was bumped from `opensea-exact-order-adapter-v6-2026-09`
to `opensea-exact-order-adapter-v7-2026-09` because accepted/rejected provider
bodies changed. Provider contract remains `opensea-get-order-v2-2026-09`; no
normalizer, policy, durable schema, candidate, envelope, generation, or barrier
version changed.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE

Result: optional-field admission source remediation implemented; overall adapter
contract remains subject to its previously scoped acceptance work.
