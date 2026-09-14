# Task 67AR2 — executable evidence

The generation-publication tests now cover:

- self-consistent impossible provenance rejection, including whitespace keys;
- complete SQL-column/payload cross-binding;
- trusted foreign manifest rejection before sequence allocation;
- sequential idempotent replay without unnecessary allocation;
- overlapping different publications with distinct committed sequences;
- overlapping identical replay with one committed publication and no duplicate sequence;
- transactional rollback with no leaked publication and deterministic subsequent allocation;
- exact protocol-scope current selection.

The full hermetic suite remains the gate. No live OpenSea request, API-key read, production database connection, or listing mutation is used.
