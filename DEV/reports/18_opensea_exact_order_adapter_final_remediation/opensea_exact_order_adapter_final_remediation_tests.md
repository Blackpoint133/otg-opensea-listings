# Final remediation tests

`tests/openSeaExactOrderAdapter.test.ts` now exercises trusted-context adaptation, wrapped Listing discrimination, identity disagreement, criteria/multi-offer rejection, content encoding, BOM and malformed UTF-8, 404 UNKNOWN, exact body hash, body cap, Age invalidation, documented status and 100-digit decimal preservation. Header input is ordered and multiplicity-aware. Existing provenance regressions remain in the suite.

Results inside Codex:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 714 tests, 714 pass, 0 fail, 0 skipped; duration recorded by runner in the local execution log.

Source isolation: changed runtime modules import only `node:crypto` and pure repository code. No HTTP/HTTPS/fetch/axios, API-key, PostgreSQL, SQL, Stream, worker, live canary or deactivation writer was introduced. Authority fields remain false.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE ORDER ENDPOINT NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
