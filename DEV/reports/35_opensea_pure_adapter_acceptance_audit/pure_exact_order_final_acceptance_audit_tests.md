# Task 35 — executable acceptance verification

Added independent adversarial coverage in
`tests/pureExactOrderAdversarialAudit.test.ts`. It imports production parser,
admission, and adapter code and exercises non-200 body isolation (including exact
5xx reasons), timeout/reset handling, duplicate escaped keys, trailing data,
adversarial lossless integer spellings, and malformed-body status precedence.
The final test intentionally reproduces the discovered malformed-header defect:
the current implementation throws for a non-string header name before its
validation branch. This test is evidence, not a production fix.

Gate results:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 867 tests, 867 passed, 0 failed, 0 skipped,
  duration 8313.938782 ms
- `git diff --check`: PASS

Changed-files proof: only this new audit test and the two Markdown audit reports
are changed relative to the accepted baseline; production runtime files have no
diff. The immutable Task-32 OpenAPI snapshot and generated fixture are unchanged.

Coverage was mapped against HTTP/status isolation, lossless parsing, official and
targeted schema separation, quantities, timing, headers/entity integrity,
provenance, reason handoff, version binding, and source isolation. Existing tests
remain green, but the concrete malformed-header exception prevents acceptance.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
