# Task 37 — independent adversarial acceptance audit

Baseline: `d4c6a969bbc09758b81a97da87df2eaa25071332`.

The audit independently read the complete exact-order runtime, immutable Task-32
evidence, generated fixture, and Task-33–36 tests. Accepted parser, OpenAPI
snapshot, admission, provenance, normalizer, temporal, reconciliation, and
candidate/fence architecture were not redesigned.

The Task-36 header remediation was independently confirmed: malformed header
containers and entries fail closed as `MALFORMED` / `HEADER_INVALID` before any
string-only lookup, while valid ordered headers retain normal processing. HTTP
status-before-body, lossless JSON, schema/targeted separation, quantity, timing,
provider-date, provenance, and source-isolation checks were exercised.

Two related concrete MEDIUM raw-input boundary defects remain:

1. In `src/reconciliation/verifier/openSeaExactOrderAdapter.ts:25`, the numeric
   comparison `s >= 500` occurs without runtime primitive validation. A caller
   supplying `httpStatus: Symbol("status")` causes a TypeError rather than a
   fail-closed observation.
2. At the same body-construction path, `new Uint8Array(i.body)` is reached for an
   invalid `body: Symbol("body")` and throws. The raw adapter contract therefore
   does not fail closed for every malformed runtime metadata primitive.

Executable reproducers are in
`tests/task37RawInputRobustnessAudit.test.ts`. They intentionally assert throws
as audit evidence; no production fix was applied. Because these are concrete
malformed-input exception paths at the pure trust boundary, acceptance is not
permitted.

Findings: BLOCKER 0, HIGH 0, MEDIUM 2, LOW 0.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE

Audit outcome: **B. PURE EXACT-ORDER ADAPTER ACCEPTANCE FAIL  REMEDIATION REQUIRED**
