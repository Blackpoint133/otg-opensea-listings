# Task 65B.3BR7 — Evidence

The executable PostgreSQL/InMemory matrix retains positive worker-captured records for COMPLETE, RETRY_EXHAUSTED, RETRY_SCHEDULED, STALE, and RECONCILIATION_REQUIRED. It adds classification-only tampering rejection while the existing semantic hash remains unchanged, and rejects internally recomputed foreign chain, collection, and contract records at both admission paths.

The matrix also retains exact identity, legacy-hash, semantic-hash, journal, retry-boundary, and recovery regressions. The new terminal checks prove RETRY_SCHEDULED requires a retryable provider result and matching final status; STALE and RECONCILIATION_REQUIRED require their exact final statuses; COMPLETE permits only null or RETRY_EXHAUSTED classification with matching retry metadata.

Gates run for this change: build, typecheck, full hermetic tests, and `git diff --check`. No migration or production authority was introduced.
