# Task 71CONTINUITY-REBASE12 validation

Baseline: `a341abaf353667fd4a693da7589fd2ae81672135`

Coverage added for trusted anchor invariants (inactive non-empty state accepted; active/adopted/generic-pending/processing/failed/stale/lease states rejected; specialized REST pending allowed), explicit CLI binding, immutable trust, source-separated continuity-loss orchestration APIs, and a stateful v2 rebaseline fixture proving snapshot-authoritative reset/provenance and preservation of absent rows. Existing v1 adoption, reducer, stream, configuration, and recovery tests remain green.

Results:

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm test`: PASS (1210 tests, 1210 passed, 0 failed)
- `git diff --check`: PASS

This task performed no OpenSea requests, WebSocket connections, production PostgreSQL connections, or production writes. The running production ingestion process and both real `.env` files were untouched; no secrets or derivatives were exposed.
