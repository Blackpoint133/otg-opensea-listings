# Task 70A — Durable shadow decision persistence

Implemented migration 008 and `PostgresShadowDecisionStore` as an immutable append-only audit ledger. Every append strictly validates `ShadowDecisionV2`, locks and rehydrates the durable operational attempt, and cross-binds the durable generation-publication row through its strict decoder. Existing decision replay is idempotent; changed decisions append successors with deterministic predecessor lineage serialized by the attempt-row lock.

Active Listings evidence remains a deterministic view and is not independently persisted here. Task 70B must freshly resolve `CurrentActiveListingsEvidenceSource` before live orchestration. No scheduler, shadow runner, Fence B, deactivation, listing mutation, or mutation authority was added.
