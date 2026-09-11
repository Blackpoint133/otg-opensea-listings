# Task 40 — executable verification

The existing runtime metadata regression asserts
`OPENSEA_EXACT_ORDER_ADAPTER_VERSION === "opensea-exact-order-adapter-v10-2026-09"`
and verifies a produced observation carries the same value. Task-39 bounded-body
hashing, Task-38 primitive/header hardening, and all prior exact-order regressions
remain green.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 889 tests, 889 passed, 0 failed, 0 skipped,
  duration 7220.851812 ms
- `git diff --check`: PASS

Diff review against `c7bab2e8...` contains only the adapter constant, the
legitimate version assertion, and these two reports. No immutable Task-32 evidence
was changed.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
