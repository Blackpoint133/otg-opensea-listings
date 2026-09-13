# Executable evidence

Added direct InMemory/PostgreSQL malformed-admission cases covering empty/partial payloads, invalid identifiers and timestamps, lifecycle, authority flags, transport, retry, journal evidence, reasons, and failure classifications. PostgreSQL query/decode payloads are typed `unknown` and decoded through the same strict admission path.

Added executable maxAttempts=2 sequential exhaustion proving child attempt 1 completes as `RETRY_EXHAUSTED` and attempt 2 is absent. Existing maxAttempts=1, retry-delay, provider/final-status/hash, fence, store, throttle, and recovery regressions remain covered.

Gates:

- `npm run build` — PASS
- `npm run typecheck` — PASS
- `npm test` — PASS (998 total, 998 passed, 0 failed, 0 skipped; duration 9424.80036 ms)
- `git diff --check` — PASS

Baseline: `f638ee63b72c40cf43fecb1ed88fe74aa2a84670`.
