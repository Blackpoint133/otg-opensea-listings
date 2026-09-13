# Executable evidence

The worker test suite directly exercises:

- exact permit-before-claim behavior and existing zero-provider recovery;
- transient-transport retry delay calculation;
- local post-fence reader failure with durable evidence preservation and successful restart recovery without provider replay;
- recovery context-resolution failure with preserved durable provider evidence and zero credential/provider work;
- existing semantic-status/hash, journal invalidation, retry-boundary, PostgreSQL store, and PostgreSQL throttle regressions.

Gates executed for this task:

- `npm run build` — PASS
- `npm run typecheck` — PASS
- `npm test` — PASS (996 total, 996 passed, 0 failed, 0 skipped; duration 13065.757518 ms)
- `git diff --check` — PASS

The full hermetic suite made no live requests and used no production database. The repository baseline was `0092afe6c2d6960a76513b1e5af400f4dd2d56d9`.
