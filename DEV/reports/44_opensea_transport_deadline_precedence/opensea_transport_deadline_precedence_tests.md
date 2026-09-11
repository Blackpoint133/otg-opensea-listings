# Task 44 — executable verification

Обновлён `tests/openSeaExactOrderTransport.test.ts`:

- oversized body after deadline with timer pending => REQUEST_TIMEOUT;
- oversized body exactly at deadline => BODY_TOO_LARGE;
- response/request errors after deadline => REQUEST_TIMEOUT;
- within-deadline reset => CONNECTION_RESET;
- monotonic header/end recheck and late timer/events;
- synchronous destroy-error claim-before-destroy regressions;
- Task-42/43 body bound, non-200, duplicate-header, redirect/retry и credential regressions.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 912 total, 912 passed, 0 failed, 0 skipped; duration `9271.82505 ms`
- `git diff --check`: PASS

Only `openSeaExactOrderTransport.ts`, its tests and the two Task-44 reports changed. Accepted adapter files and immutable Task-32 evidence remain untouched. No localhost integration or live OpenSea request was performed.
