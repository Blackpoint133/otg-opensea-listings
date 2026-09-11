# Task 32 - OpenSea OpenAPI rebaseline tests

## Evidence pipeline coverage

`tests/openSeaOfficialSchemaContract.test.ts` permanently verifies:

- committed upstream snapshot SHA-256 and exact 581930-byte length;
- historical pin metadata and unavailable historical bytes;
- exact Get Order path, GET method, operationId, media type, and root response ref;
- library extraction canonical-equals the committed fixture;
- CLI extraction writes byte-identical fixture bytes;
- `sorted-json-v1` determinism and schema SHA `9cd70ac9d6b96532015ab0ce2e13a5220f69e6bc3b97baa66033c04834d6dc90`;
- actual JSON Pointer resolution with zero unresolved local schema refs;
- repeated extraction stability;
- schema-derived effective required sets;
- exact ListingPrice/Price chain and scalar types;
- exact ConsiderationItem required fields and recipient requirement;
- absence of minItems/maxItems on offer and consideration;
- exact 17-component closure.

All tests are offline. The CLI/library read only local files and contain no network calls.

## Gates

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: 781 tests, 781 pass, 0 fail, 0 skipped, duration 8308.636 ms

The task added 11 evidence tests. Existing Task-30 stateless admission-gate tests remain green. `git diff -- src` is empty: runtime provider behavior and runtime pin constants were not modified.

RUNTIME PROVIDER CONTRACT NOT REPINNED YET

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE
