# Task 56 test evidence

Baseline: `5f843b427d3bdf2c50efefd9937f1e096e09be2b`.

Focused coverage includes recovery without provider permit/credential/executor, expired and active lease CAS behavior, terminal lease clearing, retry metadata reconstruction, generation-bound idempotency, semantic-hash operational metadata exclusion, persistent throttle migration/query shape, production-factory fence binding, crash/recovery paths, authority invariants, and existing exact-order regression coverage.

Required gates: `npm run build`, `npm run typecheck`, `npm test`, and `git diff --check`. The exact totals and durations are recorded in the completion message. Task-32 evidence and accepted exact-order source remain unchanged.
