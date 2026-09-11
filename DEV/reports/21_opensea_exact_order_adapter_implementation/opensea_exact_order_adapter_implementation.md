# Pure exact-order adapter implementation

Source baseline: `37375d193159c6260db860821ddaf5149e4a1a29`.

Implemented a dedicated bounded lossless JSON parser (`losslessJson.ts`) with duplicate-key rejection, lexical number preservation, Unicode escape validation, depth/member/array limits and exact trailing-input rejection. The adapter now uses it instead of the old `duplicateKeys` scanner and JSON.parse authority. Trusted context/observation binding and ordered header multiplicity are retained. Adapter and normalizer semantic versions are advanced to v2/v3 respectively; candidate, envelope, generation and barrier remain v3/v3/v2/v2.

The endpoint pin remains the official OpenSea [Get Order](https://docs.opensea.io/reference/get_order) and [Model Reference](https://docs.opensea.io/page/model-reference), retrieved 2026-09-10. No authenticated response or live endpoint was used. Existing provider-contract identifier remains unchanged because no documented endpoint semantic change was established.

The legacy raw normalizer remains used by historical offline provenance tests and was not removed in this pass; this remains a known limitation for the next source audit. Monotonic elapsed/deadline metadata and complete OpenAPI fingerprint pinning also remain outstanding.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
