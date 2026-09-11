# Task 34 — executable verification

The dedicated `tests/openSeaOptionalSchemaAdmission.test.ts` uses the real
lossless parser and adapter path. It covers:

- absent, boundary, integral, fractional, string, and overflow
  `order_created_at` values;
- absent/string/invalid `protocol`;
- absent/string/invalid `protocol_data.signature`;
- complete and minimal `svm_order` values;
- every required SVM identity field missing or non-string;
- optional `asset_id` absent/string/non-string;
- primitive, null, and array `svm_order` values;
- full adapter/normalizer fail-closed handoff with
  `OFFICIAL_SCHEMA_INVALID` for malformed optional fields.

The canonical fixture remains the existing complete synthetic Listing, and no
post-mutation helper repairs deleted or malformed fields.

Gates (actual run):

- `npm run build` — PASS
- `npm run typecheck` — PASS
- `npm test` — PASS, 861 tests, 861 passed, 0 failed, 0 skipped,
  duration 12255.631372 ms

The immutable Task-32 OpenAPI snapshot and fixture were not modified. Runtime
source remains isolated from HTTP transport, live API calls, API keys, database
access, mutation, and deactivation.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
