# Task 65B.3BR strict operational admission

The durable PostgreSQL JSONB boundary now receives `unknown` and performs complete operational-record admission before returning an `OperationalAttemptRecord`. Partial records, malformed identity/hash/timestamp/journal/retry fields, non-false authority flags, and unknown failure classifications fail closed. Existing legacy unhashed compatibility and legacy hashed rejection remain intact.

The worker retains strongly typed store mutations, zero explicit production `any`, exact retry policy delays, bounded attempt numbering, and recoverable local-failure handling. A local fence/context failure after provider observation preserves `PENDING_FENCE`/`RESPONSE_OBSERVED` evidence and does not fabricate journal reasons or replay the provider.

No migration was added. No live OpenSea request, credential-secret read, production database connection, listing mutation, or authority grant occurred.
