# Task 65B.3BR6B retry-context closure

Baseline: `206b7499637e8040a7ac107fc84e15902ba6cfc2`.

## Diagnosis before editing

The only failing test was `maxAttempts=2 exhausts child one without creating child two`.

The deterministic child state before its second run was:

- attemptId: `e060fc04693571631494e6d6c19d65d1388b67fa58ba6d40d4626e805057d123`
- attemptNumber: `1`
- lifecycle: `NOT_STARTED`
- nextAttemptAt: `2026-01-01T00:00:05.000Z`
- durable pre watermark: eventId `100`, receivedAt `2026-01-01T00:00:00.000Z`
- durable pre fingerprint: the empty accepted fingerprint for the attempt order
- cached pre snapshot: canonically equal to that durable pre snapshot

The child was due and claimed. Its first semantic divergence occurred during provider observation: the test executor ignored the worker-supplied child context and adapted the timeout observation against the parent context object. The normalizer therefore returned `PROVENANCE_MISMATCH`, whose retry metadata is non-retryable. The child consequently completed with provider/final status `PROVENANCE_MISMATCH`, a valid semantic hash, and failureClassification `null`; `RETRY_EXHAUSTED` was correctly not selected for that non-retryable result. Cumulative counters were credential `2`, execute `2`, fence `2`, so the child-run deltas were `1/1/1`.

Correcting the test executor to use its supplied context exposed the production half of the defect: the advanced context was an immutable policy clone but was not in the private targeted-context runtime trust set. Child execution then failed before observation with `UNTRUSTED_TARGETED_VERIFIER_CONTEXT`.

## Remediation

Retry scheduling now derives one advanced context from the accepted parent post-fence snapshot. That exact context is used by `rowForContext` and cached under the child attemptId. The derivation:

- requires an already runtime-trusted source context;
- owns and deep-freezes the derived context;
- replaces only `preVerification`;
- runs the accepted eligibility validator;
- admits only the validated derived object into the existing private trust set.

Arbitrary caller contexts are not admitted. Eligibility was not weakened.

`resolveContext` now applies eligibility and durable pre-snapshot binding identically to local and resolved contexts. `createAttempt` rejects a separately supplied pre snapshot that differs canonically from `context.preVerification` before durable creation.

The focused retry regression advances the parent post watermark from `100` to `200`, verifies that child attempt 1 durably starts at `200`, then returns child post watermark `150`. The same worker instance detects `WATERMARK_REGRESSION`, persists `finalResultStatus = RECONCILIATION_REQUIRED`, preserves provider status `TRANSPORT_FAILED`, and stores an exact semantic hash. A stale parent context at `100` would miss this regression.

The maxAttempts=2 executor now adapts observations against the context supplied by the worker. Attempt 1 reaches `COMPLETE / RETRY_EXHAUSTED` with provider and final status `TRANSPORT_FAILED`, and attempt 2 is absent. The maxAttempts=1 and genuine non-retryable branches explicitly prove that attempt 1 is absent.

## Recovery evidence

The existing local fence failure test now re-reads PENDING_FENCE and compares the complete provider/pre-fence projection against the saved RESPONSE_OBSERVED projection. It proves null final/hash/post evidence, no accepted journal-invalidation reason, and second-run deltas `permit 0 / credential 0 / execute 0 / snapshot 1`.

The context failure test now compares the complete provider/pre-fence projection before and after failure, proves null final/hash/post evidence and no journal reason, and measures deltas `0 / 0 / 0 / 0`.

A restart test supplies an otherwise eligible, identity-matching context with a different pre watermark. It fails before the snapshot reader with provider evidence unchanged and deltas `0 / 0 / 0 / 0`.

## Preserved contracts

The BR6A PostgreSQL fixture repairs and 50-test matrix remain intact. Exact attempt/idempotency derivation, unconditional provider rehydration, provider-reason equality, strict lifecycle admission, semantic-hash admission, legacy-hash rejection, accepted journal validation, PostgreSQL CAS/throttle behavior, zero explicit operational-worker `any`, and false authority flags remain enforced. Migration 007 was not added.

No live OpenSea request, API-key read, production database connection, database listing mutation, or active-listing operation occurred.
