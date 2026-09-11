# Pure exact-order adapter completion

Baseline: `b6bcb9e086706749a37afe89020681d4ae5148a8`. The final remediation requires trusted contexts at the adapter boundary, preserves observation-to-context WeakMap binding, makes timeout/reset dominant, applies status-specific temporal proof (ACTIVE interval, EXPIRED lower-bound, terminal trusted observation), validates ordered header multiplicity, body/hash/content metadata and closed reason handoff. Candidate/envelope/generation/barrier remain v3/v3/v2/v2.

Official contract pin: OpenSea [Get Order](https://docs.opensea.io/reference/get_order) and [Model Reference](https://docs.opensea.io/page/model-reference), retrieved 2026-09-10. The implementation uses the wrapped `order` response and the repository's pinned snake_case fields; no live order response was retrieved. Provider contract remains `opensea-get-order-v1-2026-05` because the endpoint semantic contract was not changed. Adapter is `opensea-exact-order-adapter-v2-2026-09`; normalizer is `targeted-verifier-normalizer-v3-2026-09`; policy is `targeted-verifier-policy-v6-2026-09`; durable verifier schema remains v4 because no AttemptEvidence byte fields changed.

The shared trusted context fixture was moved out of test modules. Failure observations are only WeakSet-trusted when input context is trusted. The legacy raw normalizer remains exported compatibility code and is therefore a remaining security limitation for a future source audit; the new exact-order path itself is adapter observation -> normalizer and does not reparse JSON.

Remaining self-review finding: the duplicate-aware parser is still a compact scanner plus JSON.parse rather than a standalone full lexical parser, and the legacy raw parser has not yet been isolated from all runtime callers. These are MEDIUM findings; HTTP transport remains closed.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE ORDER ENDPOINT NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
