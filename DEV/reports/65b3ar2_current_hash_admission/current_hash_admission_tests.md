# Task 65B.3AR2 — Test evidence

Final gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: 992 total, 992 passed, 0 failed, 0 skipped, duration 22892.771846 ms
- `git diff --check`: PASS

The executable matrix covers legacy unhashed compatibility and legacy hashed rejection, current valid hash admission, semantic-field/hash mismatch rejection, malformed hash rejection, final-without-hash and hash-without-final rejection, frozen normalized ownership, PostgreSQL current/legacy payload decoding, stable and invalidated production status/hash invariants, recovery and retry status/hash invariants, and all previously accepted Task-65B.1/2/store/throttle regressions.

No automatic hash rewrite or legacy hash emulation exists. Authority and deactivation authority remain false. LIVE OPENSEA REQUESTS = 0; API KEY READ = NO; PRODUCTION DB CONNECTIONS = 0; DB LISTING MUTATION = NO; ACTIVE LISTINGS = 0.
