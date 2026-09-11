# Task-22: JSON parser and raw trust boundary

Baseline: ef02afa08f9f618ade2b9961f9a1b568007408bb. Scope is parser correctness and removal of the legacy ProviderResult mint path, not overall adapter acceptance.

## Reproduction

Before runtime edits the new parser assertions produced 7 failures: valid escaped surrogate pairs failed; valid upper-BMP escapes failed; unpaired literal surrogates were accepted; NBSP, BOM, U+2028 and U+2029 were accepted as whitespace. Escaped unpaired surrogate rejection was also tested. The pair bug was an extra index increment after consuming the low surrogate; the BMP check incorrectly rejected code points above DFFF as well.

Numeric collapse was independently reproduced by replaying the exact baseline adapter conversion function obtained with git show: both the parsed number token `{kind:"number",raw:"2"}` and JSON string `"2"` became the same string. This baseline-function replay occurred after source editing; it is not claimed as a pre-edit full adapter run. Final adapter tests distinguish these representations.

The baseline exported interpretTargetedOrderResponse parsed raw shorthand JSON and minted validated ProviderResults. Repository usage inspection found callers in the normalizer and runtime cross-pair test modules. Those callers now use an adapter-backed test fixture helper.

## Parser and typed validation

The dedicated recursive-descent parser is retained and corrected. Whitespace is exactly SPACE/TAB/LF/CR. Decoded keys are checked for duplicates, including escaped-equivalent spellings. Storage uses null-prototype records. Strings enforce escapes and paired Unicode surrogates. Numbers retain lexical tokens without Number coercion, including fractions, exponents, -0 and unsafe integers. Trailing garbage and malformed grammar reject deterministically as MALFORMED_JSON.

Limits: 1,048,576 input characters (in addition to the adapter's 1 MiB entity-byte cap), depth 64, 512 members per object and 512 elements per array. Numeric token objects are frozen and privately WeakSet-branded so a provider object with kind/raw properties cannot impersonate a JSON number. jsonInt32 requires this brand, canonical nonnegative integer syntax and a BigInt range check through 2147483647 before Number conversion.

The adapter no longer recursively converts numbers into strings. Under the current provisional fixture contract item_type and order_type require numeric integer tokens; asset/offer identifiers, amounts, remaining quantity and timestamps remain strings. This is type preservation, NOT a new official OpenAPI pin. Exact final provider field representation remains task-23 work.

## Single ProviderResult mint path

The runtime raw entry point and its RawBody/parseJson/normalizeOrder/supportedBasicShape/temporalWindow helpers are removed. targetedVerifierNormalizer exports only validateProviderResult and interpretOpenSeaExactOrderObservation. Its private base is the sole caller of RUNTIME_PROVIDER_PROOF.add; it is reachable only from the observation normalizer. Positive evidence requires an adapter-minted observation bound through the private WeakMap to the exact trusted context. Invalid observations yield only a negative PROVENANCE_MISMATCH result, never positive provider evidence.

The test-only providerResultFixtures helper expands historical shorthand into deterministic synthetic wrapped bytes and supplies ordered headers and deterministic wall-clock metadata. It then calls the real adapter and normalizer. It does not manufacture or cast ProviderResult and registers no tests. JSON.parse in this helper is fixture preparation, not a runtime trust interpreter.

Migration exposed checks formerly supplied only by the deleted parser. Their required rejection behavior was moved into the adapter: malformed identity versus canonical identity disagreement, private/criteria/unsupported shape, invalid order-time range, quantity syntax and non-200 classification. ACTIVE zero/missing quantity now returns UNKNOWN rather than an internal validator exception. No transport or timer was implemented. The historical EXPIRED positive fixture now observes after its end time; retaining its old future end would preserve unsafe legacy semantics.

## Versions

| Contract | Final value / reason |
| --- | --- |
| Adapter | opensea-exact-order-adapter-v3-2026-09: strict parser/type acceptance |
| Normalizer | targeted-verifier-normalizer-v4-2026-09: raw public trust entry removed |
| Policy | targeted-verifier-policy-v7-2026-09: adapter-only trusted admission |
| Durable schema | targeted-verifier-schema-v4 retained: no durable fields changed |
| Provider contract | opensea-get-order-v1-2026-05 retained provisionally; no schema re-pin claimed |
| Candidate/envelope/generation/barrier | v3/v3/v2/v2 unchanged |

Changed runtime files: src/reconciliation/verifier/losslessJson.ts, openSeaExactOrderAdapter.ts, targetedVerifierNormalizer.ts, targetedVerifierTypes.ts. No prior report changed. Task-22 self-review has no remaining demonstrated parser/raw-mint defect; this is not a claim about full adapter readiness.

OVERALL PURE ADAPTER STILL REQUIRES TASK-23 TIMING/OPENAPI COMPLETION

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE

A. JSON/TRUST BOUNDARY CLOSED  READY FOR CHATGPT SOURCE AUDIT
