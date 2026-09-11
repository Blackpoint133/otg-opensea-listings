# Task 43 — executable verification

`tests/openSeaExactOrderTransport.test.ts` расширен deterministic fake-тестами:

- production API dependency surface and explicit timer maximum;
- invalid credentials/context before request creation;
- synchronous destroy-error races for timeout, 404, 503, 429 and oversized 200;
- late response/error events after settlement;
- monotonic expiry at headers and completion, including exact deadline boundary;
- Task-42 chunk, body bound, non-200 isolation, duplicate-header, encoding, redirect and retry regressions.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 909 total, 909 passed, 0 failed, 0 skipped; duration `7385.73869 ms`
- `git diff --check`: PASS

Baseline diff contains only the dedicated transport module, its tests and these two reports. Accepted adapter source and immutable Task-32 evidence are untouched. No localhost integration or live network probe was performed.
