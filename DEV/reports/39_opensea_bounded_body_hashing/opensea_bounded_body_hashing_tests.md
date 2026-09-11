# Task 39 — executable verification

`tests/task39BoundedBodyHashing.test.ts` proves that 503/404/429/TIMEOUT/
CONNECTION_RESET branches retain their exact classifications and
`responseBodySha256: null` despite supplied bodies; oversized HTTP-200 input
returns `BODY_TOO_LARGE` with null hash; bounded valid input retains its exact
SHA-256; and malformed `Content-Encoding` value returns `HEADER_INVALID`.
Task-38 primitive and header matrices remain green.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 889 tests, 889 passed, 0 failed, 0 skipped,
  duration 9198.412926 ms
- `git diff --check`: PASS

Source review confirms no `sha(body)` in the generic failure factory, no hashing
before the 1 MiB check, and no body hashing on status/transport early returns.
Immutable Task-32 OpenAPI evidence and all prior reports were not modified.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
