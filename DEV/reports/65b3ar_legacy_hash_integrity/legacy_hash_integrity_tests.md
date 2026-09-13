# Task 65B.3AR — Test evidence

Final gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: 992 total, 992 passed, 0 failed, 0 skipped, duration 11530.165984 ms
- `git diff --check`: PASS

Executable evidence includes legacy in-memory and PostgreSQL unhashed decode to null, deterministic rejection of hashed legacy payloads, malformed final-status rejection, normalized-record ownership/deep-freeze restoration, non-null PostgreSQL final-status/hash parity, and the complete new-format status/hash, recovery, invalidation, retry, Task-65B.1, Task-65B.2, throttle, and attempt-store regressions.

No automatic historical hash rewrite or hash-version emulation exists. Authority and deactivation authority remain false. LIVE OPENSEA REQUESTS = 0; API KEY READ = NO; PRODUCTION DB CONNECTIONS = 0; DB LISTING MUTATION = NO; ACTIVE LISTINGS = 0.
