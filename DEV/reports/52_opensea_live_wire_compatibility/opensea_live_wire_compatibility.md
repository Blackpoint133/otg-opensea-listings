# Task 52 — OpenSea live-wire compatibility remediation

## Outcome

Outcome A (offline remediation complete): the confirmed provider drift is accepted only through a separate, explicitly named compatibility admission layer. The strict Task-32 admission remains unchanged and continues to reject the drift shape.

Baseline: `88b1f64ef336372047a8ec25d61adeb810eeb5a3`

Task-51 evidence remediated: a real HTTP-200 Listing-shaped response had `protocol_data.parameters.counter` as a JSON string and `protocol_data.signature` as JSON `null`; all other reported structure was compatible, but strict Task-32 admission rejected it.

## Compatibility boundary

`validateOfficialListingRequired` remains the strict immutable Task-32 validator. `validateOpenSeaLiveCompatibleListing` shares every predicate and changes only the two evidenced wire fields:

- `counter`: the existing exact JSON-integer forms remain valid, plus unsigned canonical decimal strings and `0x` hexadecimal strings bounded to `[0, 2^256 - 1]`, using `BigInt` without `Number` conversion.
- `signature`: absent, string, or `null` is accepted only by the compatibility layer. No value is synthesized or used as semantic evidence.

Malformed strings, signed/whitespace/decimal/exponent forms, over-uint256 values, and non-string/non-number values are rejected. No other OpenAPI requirement, array cardinality, identity rule, order-shape rule, quantity rule, or temporal rule was relaxed.

The adapter now invokes the compatibility admission after parsing `root.order`, then executes the unchanged targeted identity, quantity, order-shape, status, and temporal checks. Counter and signature do not participate in identity, provider status, remaining quantity, temporal proof, support, or authority. Both authority flags remain false.

## Version and scope

- Adapter: `opensea-exact-order-adapter-v11-2026-09`
- Provider contract: `opensea-get-order-v3-2026-09`
- Transport: `opensea-exact-order-http-transport-v1-2026-09` (unchanged)
- Normalizer: `targeted-verifier-normalizer-v5-2026-09` (unchanged)
- Policy: `targeted-verifier-policy-v8-2026-09` (unchanged)

Production changes are limited to the schema-admission compatibility function, adapter gate/version, and provider-contract/version assertions. The immutable OpenAPI snapshot and generated Task-32 fixture were not modified; their prescribed SHA-256 values remain unchanged. No live request, `.env` read, database access, mutation, worker, or Active Listings run occurred.

## Severity

BLOCKER 0 · HIGH 0 · MEDIUM 0 · LOW 0
