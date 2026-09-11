# Completion tests and gates

The trusted context helper is `tests/helpers/trustedVerifierContexts.ts` and registers no tests. `openSeaExactOrderAdapter.test.ts` no longer imports another `.test.ts`, eliminating duplicate registration. Adapter tests cover trusted context adaptation, wrapped Listing, identity/criteria/multi-offer rejection, encoding/BOM/UTF-8, 404, hash/cap, Age, status and large decimal preservation. Existing provenance tests remain unchanged.

Actual Codex run:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 711 tests, 711 pass, 0 fail, 0 skipped.

Source isolation: no node:http, node:https, fetch, axios, API-key access, pg, SQL, Stream, DB writer, worker or deactivation service was introduced. Authority remains false.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE ORDER ENDPOINT NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
