# Task 33 — executable verification

## Added and updated coverage

The new `tests/openSeaRuntimeSchemaReconciliation.test.ts` uses the real lossless parser, adapter observation, normalizer, and trusted context.

### Runtime pin metadata

- full runtime OpenAPI SHA and byte length
- extracted Get Order SHA
- sorted-json-v1 extraction metadata
- provider contract v2
- adapter v6
- exact metadata carried by a real observation

### Price matrix

Covered separately: missing, null, string, empty object, missing/null current, missing/wrong currency, missing/string/below-min/min/max/above-max decimals, and missing/wrong value. A complete exact Price reaches ACTIVE_CONFIRMED.

### Integer matrix

Official integer and signed int32 coverage:

`-2147483649`, `-2147483648`, `-1`, `-0`, `0`, `1`, `2147483647`, `2147483648`, `1.0`, `-1.0`, `1e0`, `1e2`, `1.5`, `1e-1`.

Signed int64 coverage:

`-9223372036854775809`, `-9223372036854775808`, `9223372036854775807`, `9223372036854775808`.

All range decisions precede Number conversion.

### Item and ConsiderationItem

Every required Item and ConsiderationItem field is removed individually. String `itemType` and wrong required scalar types fail. ConsiderationItem recipient remains required.

### Cardinality and official/targeted split

- offer `[]`: official admission true; full adapter fail-closed later without `OFFICIAL_SCHEMA_INVALID`
- consideration `[]`: official admission true; current targeted semantics impose no new cardinality rule
- signed orderType `-1`: official admission true; targeted unsupported
- missing order_hash/protocol_address/protocol_data/asset: official admission true; targeted fail-closed
- malformed present optional outer values: official admission false

### Remaining quantity

Admission and full-path tests distinguish missing, signed-int64 underflow/overflow, negative in-range, zero, positive maximum, and integral fraction/exponent representations. ACTIVE zero remains `ACTIVE_QUANTITY_UNPROVEN`.

## Regressions

- Task-30 direct stateless early-return gate remains present.
- `schemaAdmissionFailed` remains absent.
- `OFFICIAL_SCHEMA_INVALID` handoff remains valid.
- ProviderResult has one private runtime mint path.
- Task-32 snapshot SHA/length, exact extraction, 17 components, and zero unresolved refs remain green.
- Duplicate-aware lossless parsing, trusted context, observation binding, timing, temporal proof, HTTP-before-body, and authority-false regressions remain green.

## Final gates

Final recorded commands and exact results are filled from the final post-report gate run:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS
- tests: 841
- pass: 841
- fail: 0
- skipped: 0
- duration: 7391.574068 ms

Source isolation review of the changed runtime files found no production HTTP client, live request, API-key access, PostgreSQL, SQL mutation, Stream mutation, DB writer, deactivation worker, or background network worker.

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE
