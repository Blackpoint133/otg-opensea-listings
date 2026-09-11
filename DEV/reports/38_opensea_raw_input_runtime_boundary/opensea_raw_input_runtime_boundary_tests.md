# Task 38 — executable verification

The Task-37 Symbol reproducers were converted to fail-closed assertions. The
runtime matrix covers malformed transport outcomes, HTTP statuses, body types
(including ArrayBuffer/DataView), hash metadata, timing shapes, and the complete
Task-36 header adjacency set. Every malformed result is checked for untrusted
temporal/authority state and sanitized observation metadata. Critical non-200
status plus malformed-body precedence is explicitly tested.

Gates:

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 885 tests, 885 passed, 0 failed, 0 skipped,
  duration 6820.208154 ms
- `git diff --check`: PASS

Source isolation search found no exact-order runtime HTTP client, credential,
database, mutation, worker, legacy raw parser, or schema-admission global state.
Task-32 immutable evidence was not modified.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
