# Implementation tests

The adapter suite and existing provenance suite execute with the shared zero-test trusted-context helper; no test module imports another `.test.ts`. The new parser is exercised through the adapter's exact-byte path, including duplicate rejection and lexical numeric conversion.

Gates inside Codex:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 711 tests, 711 pass, 0 fail, 0 skipped.

Source isolation audit: no HTTP/HTTPS/fetch/axios, API key, PostgreSQL, SQL, Stream, DB writer, worker or deactivation behavior was introduced. Authority remains false.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
