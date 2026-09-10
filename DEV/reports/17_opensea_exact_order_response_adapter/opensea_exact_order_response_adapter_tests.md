# Adapter tests and gates

Offline executable coverage in `tests/openSeaExactOrderAdapter.test.ts` covers the wrapped Listing shape, legacy root rejection, identity and asset/offer disagreement, criteria and multi-offer rejection, content encoding, BOM and malformed UTF-8, 404 UNKNOWN, exact body-hash mismatch, body cap, Age invalidation, documented INACTIVE status and 100-digit token preservation. The normalizer handoff is exercised with an adapter-created observation and authority remains false.

The broader existing suite remains in place, including candidate/generation/evidence reconstruction, trusted context, AttemptEvidence, provider/fence cross-pair, restart, idempotency and final artifact tests. No existing safety assertions were removed.

Gates executed in the Codex sandbox:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS, 711 tests, 711 pass, 0 fail, 0 cancelled, 0 skipped; duration 8050.446 ms.

Source isolation audit: the adapter imports only hashing and pure local policy/evidence modules. No `node:http`, `node:https`, `fetch`, API-key access, PostgreSQL, SQL, Stream, worker, live canary or deactivation writer was introduced. `src/` remains offline-only.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE/API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
