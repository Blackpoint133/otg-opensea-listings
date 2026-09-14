# Task 67A — Durable Generation Publication Evidence

Implemented a dedicated immutable `GenerationPublicationEvidenceV1` contract and PostgreSQL store. The adapter accepts only trusted reconstructed integrated evidence whose offline candidate/generation/barrier artifacts validate, derives the root/artifact/version commitments, enforces the supported scope, and rejects arbitrary or incomplete provenance.

The exact V1 fields are `schemaVersion`, safe non-negative `publicationSequence`, `publicationState` (`ACCEPTED`, `REJECTED`, or `SUPERSEDED`), supported `scope`, `sweepId`, generation/root/artifact hashes, candidate/generation/verifier/provider/normalizer versions, `sourceEvidenceHash`, `sourceArtifactIdentity`, `generationCommitmentId`, `generationPublicationId`, and audit-only `createdAt`.

`generationCommitmentId` hashes the canonical generation scope, sweep, root/artifact commitments, and all model/schema/policy/provider/normalizer versions. `generationPublicationId` separately hashes schema version, commitment identity, durable sequence, state, source evidence hash, and source artifact identity. `createdAt` is never used for ordering.

The PostgreSQL store allocates sequence values under a transaction by updating a singleton sequence row. The update is serialized by PostgreSQL row locking; gaps are permitted on rolled-back allocations, while committed sequence values remain unique and monotonically increasing. Identical commitment/source/state replay returns the existing immutable row. Current selection decodes every raw payload, filters valid accepted records for the exact scope, selects the unique greatest sequence, and fails closed for zero valid rows or conflicting publication identities at the greatest sequence.

Migration 007 creates the sequence allocator and immutable publication table. No shadow evaluator, ActiveListingsEvidenceV1 adapter, Fence B, deactivation, listing mutation, or authority path is included. Production shadow eligibility remains disabled until prerequisite #2 exists.
