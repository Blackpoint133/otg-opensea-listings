# Task 23 — Tests

Permanent tests cover canonical official wrapper/casing, wrong aliases/types, duplicate keys, lossless numeric tokens, strict headers/content/hash, status and temporal proofs, monotonic timing, transport failures, context provenance, and all prior candidate/AttemptEvidence regressions. `tests/losslessJson.test.ts` exercises whitespace, surrogate pairs, duplicate decoded keys, malformed escapes and parser bounds. Adapter failures are routed through the observation normalizer and validated without trust exceptions.

Gates: `npm run build` PASS; `npm run typecheck` PASS; `npm test` PASS. Exact latest run: 741 tests, 741 pass, 0 fail, 0 skipped (duration recorded by hermetic runner). Source isolation audit found no new runtime HTTP/fetch/API-key/PG/SQL/Stream/deactivation behavior.

HTTP TRANSPORT NOT IMPLEMENTED  
LIVE GET ORDER NOT CALLED  
API KEY NOT USED  
DB/MUTATION NOT USED  
DEACTIVATION AUTHORITY = FALSE
