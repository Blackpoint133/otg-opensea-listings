# Task 45 — executable verification

Dedicated file `tests/openSeaExactOrderLocalhostHttpsMatrix.test.ts` contains 10 localhost HTTPS integration tests. The hermetic test command compiles and executes it with the complete suite; all matrix cases passed, including TLS/reset/timeout/native rawHeaders behavior.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 922 total, 922 passed, 0 failed, 0 skipped; duration `6961.9027 ms`
- `git diff --check`: PASS

Production diff relative to baseline `cf9e3331595e2cd00ddb23bdc4e447dc0d3bd87b`: empty. Immutable Task-32 OpenAPI snapshot and generated fixture are unchanged. No localhost test creates a connection outside `127.0.0.1`.
