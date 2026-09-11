# Task 36 — executable verification

`tests/pureExactOrderAdversarialAudit.test.ts` now converts the Task-35
`{name:null,...}` reproducer from `assert.throws` to a fail-closed assertion and
adds separate registered cases for non-array containers, null/primitive/empty
entries, non-string names and values, empty names, and CR/LF injection. Each
asserts `MALFORMED`, `HEADER_INVALID`, `supportedListing: false`,
`temporalProof: UNTRUSTED`, and both authority flags false. A malformed value in
the Content-Encoding position is covered by the same boundary matrix.

Gate results:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 881 tests, 881 passed, 0 failed, 0 skipped,
  duration 7000.178794 ms
- `git diff --check`: PASS

The source search confirms no new HTTP/API-key/DB/deactivation behavior and no
changes to the immutable Task-32 snapshot or fixture.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
