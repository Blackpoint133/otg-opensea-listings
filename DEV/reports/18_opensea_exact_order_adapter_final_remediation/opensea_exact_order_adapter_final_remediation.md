# Final remediation: pure OpenSea exact-order adapter

Baseline: `e1712c9aaa93bbe62cf3edeff778ad3d59d914ee`. The remediation closes the source-review findings by requiring a runtime-trusted `TargetedVerifierContext` at adaptation, binding observations to the exact context through a private WeakMap, making transport failure dominant, validating raw artifact hashes, and replacing dictionary header lookup with ordered case-insensitive header occurrences. Adapter failures are translated to closed verifier reasons before normalizer construction.

The official contract pin is the current OpenSea [Get Order endpoint](https://docs.opensea.io/reference/get_order) and [model reference](https://docs.opensea.io/page/model-reference), retrieved 2026-09-10. The endpoint remains semantically unchanged from the existing provider contract identifier; the adapter schema is versioned separately. The documented response is wrapped in `order`; the adapter accepts the documented snake_case order/Seaport fields and rejects invented aliases in its trusted path.

The adapter enforces fatal UTF-8, BOM and duplicate-key rejection, 1 MiB body cap, exact byte hashing, content type/encoding/length checks, canonical decimal strings, three-way token identity and exact Listing shape. Date provenance requires one IMF-fixdate Date, no Age, ordered request/header/completion metadata and a conservative ±1 second interval. ACTIVE requires the full interval in the order window; terminal states require trusted observation provenance. 404 remains UNKNOWN and timeout/reset remain TRANSPORT_FAILED.

Versions: adapter `v1-2026-09`; provider contract retained `opensea-get-order-v1-2026-05` because the endpoint/model contract is unchanged; normalizer `v2-2026-09`; verifier schema/policy v4/v5; candidate/envelope/generation/barrier v3/v3/v2/v2. Observation is runtime handoff data, not a new durable AttemptEvidence field.

`interpretTargetedOrderResponse` remains legacy compatibility code; the new trusted exact-order path is adapter observation -> normalizer and performs no JSON parsing in the observation handoff. No HTTP transport or production network path was added.

Remaining self-review finding: the bounded parser is still a compact local scanner around JSON.parse rather than a separately reusable full tokenizer implementation; this is recorded as MEDIUM pending an independent source audit.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE ORDER ENDPOINT NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
