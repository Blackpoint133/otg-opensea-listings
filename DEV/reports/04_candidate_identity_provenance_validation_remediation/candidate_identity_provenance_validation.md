# Candidate identity provenance — validation report

## Gates

- External baseline: 656 / 649 / 7.
- Hermetic runner: `node scripts/runHermeticTests.mjs`; compiles production source to a dedicated temporary directory, transpiles all `tests/*.test.ts`, enumerates every compiled test explicitly, copies only required fixtures/scripts/SQL, propagates child exit code and cleans output.
- Final `npm test` inside Codex: **656 tests, 656 pass, 0 fail, 0 skipped, duration 6842.806558 ms**.
- `npm run build`: PASS.
- `npm run typecheck`: PASS.

Coverage includes canonical token forms (`0`, arbitrary-size decimal, `007`, sign, exponent, decimal point, whitespace/empty), address/order hash canonicality, chain/collection/protocol mismatch, duplicate/conflicting identity groups, deterministic permutations, v2 candidate/v1 generation compatibility, envelope/barrier/root hash boundaries, required AttemptEvidence identity, semantic hash separation, forged/frozen/clone/JSON provenance rejection, authority invariants and unchanged wire RequestIdentity.

Source isolation audit PASS: no new OpenSea HTTP request, API-key access, PostgreSQL/SQL, Stream, worker loop, live canary or deactivation writer. Runner child processes invoke only local compiler/Node test execution.

Findings after remediation: BLOCKER 0, HIGH 0, MEDIUM 0, LOW 0 for this stage.

PURE RESPONSE ADAPTER NOT IMPLEMENTED. HTTP TRANSPORT NOT IMPLEMENTED. LIVE/API KEY NOT USED. DB/MUTATION NOT USED. DEACTIVATION AUTHORITY = FALSE.
