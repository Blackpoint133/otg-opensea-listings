# Task 66AR2 — Shadow Deactivation Prerequisite Contract

## Scope and repository reality

This remains design-only. The accepted operational worker is immutable input; no production code, tests, migration, evaluator, listing write, OpenSea write, or authority is added.

The repository currently has the offline generation/barrier model and validated `OfflineGenerationResult`, but it does **not** yet have a durable accepted/current generation-publication record, `publicationSequence`, a SQL publication table, or an accepted service exposing a unique current generation. It also does not yet expose the required versioned authoritative active-listings evidence. Therefore production `SHADOW_ELIGIBLE` is impossible until both prerequisite evidence sources are implemented in separate reviewed work. Until then, currentness is `RECONCILIATION_REQUIRED` with `CURRENT_GENERATION_SOURCE_UNAVAILABLE` (or `CURRENT_GENERATION_UNPROVEN`).

## Required GenerationPublicationEvidenceV1

Future shadow evaluation requires an immutable, validated `GenerationPublicationEvidenceV1` containing exactly: `schemaVersion`, `publicationSequence` (safe non-negative integer), `publicationState` (`ACCEPTED` or a non-accepted state), `scope` (`chain`, `collectionSlug`, `contractAddress`, `protocolAddress`), `sweepId`, `generationRootHash`, `candidateArtifactHash`, `barrierArtifactHash`, `candidateModelVersion`, `generationModelVersion`, `verifierSchemaVersion`, `verifierPolicyVersion`, `providerContractVersion`, `normalizerVersion`, `sourceEvidenceHash`, and `sourceArtifactIdentity`.

Its commitment identity is:

`generationCommitmentId = sha256Canonical({ schema: "reconciliation-generation-commitment-v1", scope, sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion })`.

Its publication identity is separately:

`generationPublicationId = sha256Canonical({ schema: "reconciliation-generation-publication-v1", generationCommitmentId, publicationSequence, publicationState, publicationEvidenceHash: sourceEvidenceHash })`.

The commitment identifies the generation contents; publication identity identifies one ordered publication. An operational attempt matches a current generation by `generationCommitmentId`, not by `publicationSequence`, because the accepted attempt record does not contain that sequence.

The unique current accepted generation is the unique valid `ACCEPTED` publication for the supported scope having the greatest `publicationSequence`. Zero valid accepted publications yields `RECONCILIATION_REQUIRED / CURRENT_GENERATION_SOURCE_UNAVAILABLE`. Two different publication identities at the greatest sequence yield `RECONCILIATION_REQUIRED / CURRENT_GENERATION_CONFLICT`. A mismatching attempt commitment is `SUPERSEDED`; a matching commitment satisfies only the generation-currentness prerequisite.

## Required ActiveListingsEvidenceV1

Future evaluation also requires immutable, versioned `ActiveListingsEvidenceV1` with exactly: `schemaVersion`, `publicationId`, `publicationSequence` (or another accepted monotonic source identifier), `sourceArtifactHash`, `observationWatermark`, `orderHash`, `chain`, `contractAddress`, `tokenId`, `presence` (`PRESENT` or `ABSENT`), `status` (or explicit null when absent), `sourceScope` (`collectionSlug`, `protocolAddress`, and supported contract/chain), and `canonicalEvidenceVersion`.

`activeEvidenceId = sha256Canonical({ schema: "shadow-active-evidence-v1", schemaVersion, publicationId, publicationSequence, sourceArtifactHash, observationWatermark, orderHash, chain, contractAddress, tokenId, presence, status, sourceScope, canonicalEvidenceVersion })`.

The source must prove both the exact order identity and the authoritative present/absent result. An unavailable, unversioned, or opaque query result cannot establish absence; production `SHADOW_ELIGIBLE` remains impossible and returns `RECONCILIATION_REQUIRED / ACTIVE_EVIDENCE_SOURCE_UNAVAILABLE`.

## Snapshot and Fence A

`journalSnapshotIdentity = sha256Canonical({ schema: "shadow-journal-snapshot-v1", watermark, relevantFingerprint })` using accepted canonical evidence serialization.

`evaluationSnapshotIdentity = sha256Canonical({ schema: "shadow-evaluation-snapshot-v1", generationPublicationId, activeEvidenceId, journalSnapshotIdentity })`.

The evaluator reads generation, active evidence, and journal evidence under one repeatable-read boundary where available, then re-reads commitments before append and requires byte-identical identities. A publication/event/evidence change between reads yields `RECONCILIATION_REQUIRED / EVALUATION_SNAPSHOT_CHANGED`. This is a point-in-time decision, not a promise of perpetual truth: a publication or event may occur immediately after the final check. A later evaluation appends a successor decision; future mutation still requires Fence B.

Fence A is stable when pre/post relevant fingerprints are equivalent, no **new** relevant order event appears across the fence, there is no ambiguity, watermark regression, or order mismatch, and historical events already identical in both fingerprints do not by themselves disqualify the attempt.

## Positive shadow predicate

Only after both prerequisite evidence sources exist may `SHADOW_ELIGIBLE` be emitted. It requires an admitted `COMPLETE` attempt with `INACTIVE_CONFIRMED` provider and final statuses, null failure classification, non-retryable metadata, false authority flags, exact identities/versions/scope, strict provider evidence, exact semantic hash, stable Fence A, unique current generation commitment match, consistent snapshot, and authoritative active evidence proving the exact order is absent/inactive. No wall-clock timestamp is sufficient for ordering.

## Later ACTIVE ordering proof

`LaterProviderOrderingProofV1` is required before newer active evidence can dominate. The later result must itself be an admitted trusted `COMPLETE` result with the same supported order identity, `providerResultStatus = ACTIVE_CONFIRMED`, `finalResultStatus = ACTIVE_CONFIRMED`, stable accepted fence, valid semantic hash, and no stale/reconciliation classification. Ordering is proven only by either: (A) later generation `publicationSequence` strictly greater than the inactive attempt's generation publication sequence; or (B) the same generation commitment and later accepted pre-verification journal watermark strictly greater than the inactive result's accepted post-verification watermark. If neither holds, return `RECONCILIATION_REQUIRED / ACTIVE_ORDERING_UNPROVEN`. The complete proof is included in the shadow evidence hash.

## Exact identities and evidence hash

`shadowDecisionId = sha256Canonical({ schema: "shadow-deactivation-decision-id-v1", attemptId, evaluationSnapshotIdentity })`.

`shadowEvidenceHash = sha256Canonical({ schema: "shadow-deactivation-evidence-v1", attemptId, attemptNumber, operationalSemanticEvidenceHash, attemptGeneration: { sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion }, currentGeneration: { generationCommitmentId, generationPublicationId, sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion, publicationSequence }, expectedIdentity, requestIdentity, supportedScope, fenceA: { preVerificationWatermark, preRelevantFingerprint, postVerificationWatermark, postRelevantFingerprint }, currentJournal: { watermark, relevantFingerprint, journalSnapshotIdentity }, activeEvidence: { activeEvidenceId, schemaVersion, publicationId, publicationSequence, sourceArtifactHash, observationWatermark, orderHash, chain, contractAddress, tokenId, presence, status, sourceScope, canonicalEvidenceVersion }, evaluationSnapshotIdentity, laterProviderEvidence, laterProviderOrderingProof, decision, reasonCodes })`.

Every eligibility-changing input is explicit and changes `shadowEvidenceHash`. Operational semantic hash material is not changed. A future mutation idempotency identity is separate: `sha256Canonical({ schema: "listing-deactivation-mutation-v1", decisionId: shadowDecisionId, attemptId, generationCommitmentId, orderHash, targetAction: "DEACTIVATE" })`.

## Fence B and append-only persistence

Fence B is future-only. It re-reads current generation, active evidence, journal, identity, and inactive status immediately before a separately authorized write. Any change suppresses that write; it does not rewrite the historical decision.

Future storage is an append-only `targeted_verifier_shadow_decisions` table with immutable rows keyed by `shadowDecisionId`, unique on `(shadowDecisionId, shadowEvidenceHash)`, and containing the full identities/evidence, decision, reasons, and timestamps. A successor row references `previousDecisionId` for the same attempt/order lineage and carries its supersession/blocking reason. Prior rows are never updated or deleted.

Task 66B must not wire production `SHADOW_ELIGIBLE` until both durable accepted generation-publication evidence and versioned authoritative active-listings evidence exist. A future pure evaluator may consume injected validated evidence before production adapters exist, but production eligibility must fail closed.

Authority remains false: `SHADOW_ELIGIBLE` is audit evidence only and cannot call listing, inventory, order, sale, or OpenSea mutation paths.
