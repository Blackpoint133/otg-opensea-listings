# Validation

Baseline: `06a2a6c11db9f83a4cb2d1b58f49ca648f000693`.

Validation performed on hermetic code paths only:

* TypeScript typecheck: PASS
* Hermetic test suite: PASS
* Production build: PASS (after final source edits, rerun before commit)
* `git diff --check`: PASS (run before commit)

Coverage includes the INSERT mapping/JSON-null contract, recovery-entry replay lower bound and business-time filtering, mandatory sweep/current-publication anchor binding, coherent anchor transaction, exact existing-receipt provenance checks, fail-closed durable verification, direct CLI wiring, and runtime lifetime management. Ordinary v1 behavior remains covered by the existing suite.

Live OpenSea requests: 0. Live WebSockets: 0. Production PostgreSQL connections/writes: 0/0. Both real `.env` files and production evidence were untouched; no secret or derivative was exposed.
