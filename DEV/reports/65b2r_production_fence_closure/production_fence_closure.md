# Task 65B.2R production fence closure

Task 65B.2 correctly bound the production worker to `applyProductionJournalFence`, but its compatibility projection inferred fence validity from provider/fence status equality. This remediation uses the accepted journal-fence reason whitelist, so journal invalidation cannot be hidden by an already non-authoritative provider result.

The production factory remains snapshot-reader based, has no synthetic `failClosedFence`, and exposes no production `postFence` option. Source-level erased type assertions prove `snapshotReader` is required and `postFence` is absent.

Executable coverage exercises changed relevant fingerprints, watermark regression, and PENDING_FENCE recovery through the production factory. Recovery performs zero provider permit, credential, and executor operations while executing one real journal snapshot read. Accepted verifier, journal-fence, store, throttle, and Task-65B.1 behavior were not semantically changed.

No live network, API-key read, production database connection, or listing mutation occurred.
