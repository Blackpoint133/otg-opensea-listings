# Task 65B.2 production fence binding

The synthetic fail-closed production fence was removed. Production options now require a `JournalFenceSnapshotReader` and do not expose `postFence`; the factory binds `applyProductionJournalFence`, which delegates to the accepted `applyJournalFence` semantics. The concrete implementation is module-private; tests use the explicitly named test factory for injected fence seams.

PENDING_FENCE recovery continues with zero provider work while still executing the accepted local fence path. No semantic-hash/final-result remediation was included.
