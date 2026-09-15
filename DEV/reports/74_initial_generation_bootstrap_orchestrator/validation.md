# Initial generation bootstrap validation

Focused bootstrap runtime tests: 15 passed, 0 failed, 0 skipped. They execute same-guard-holder lease continuity at all checkpoints, restart and pre-publication loss, structured post-publication failures, committed-adoption postcondition failures, immutable post-adoption verification, mutable Stream-state tolerance, preflight ordering, snapshot/projection fail-closed behavior, settling and official-round failures, reconstruction/publication failures, and the default joined guard-holder lease probe.

Direct TypeScript build: PASS.

Direct TypeScript typecheck (`--noEmit`): PASS.

Hermetic suite: PASS (1,167 tests, 1,167 passed, 0 failed, 0 skipped).

`git diff --check`: PASS.

No production database access, OpenSea request, API-key read, live generation, migration application, baseline adoption, verifier attempt, shadow run, listing mutation, or deactivation authority occurred.
