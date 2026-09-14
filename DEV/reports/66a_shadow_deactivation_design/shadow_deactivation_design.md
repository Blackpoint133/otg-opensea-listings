# Task 66AR3 — Shadow Identity and Ordering Contract

## Scope and repository reality

This is design-only. The accepted operational worker is immutable input. No production code, tests, migration, evaluator, listing write, OpenSea write, or authority is added. The repository does not yet contain the durable accepted generation-publication source or versioned authoritative active-listings source required for production shadow eligibility. Until both are implemented in separately reviewed work, production must fail closed and cannot emit `SHADOW_ELIGIBLE`.

## Required generation publication

Future `GenerationPublicationEvidenceV1` is immutable and contains exactly: `schemaVersion`, safe non-negative integer `publicationSequence`, `publicationState` (`ACCEPTED` or non-accepted), supported `scope` (`chain`, `collectionSlug`, `contractAddress`, `protocolAddress`), `sweepId`, `generationRootHash`, `candidateArtifactHash`, `barrierArtifactHash`, `candidateModelVersion`, `generationModelVersion`, `verifierSchemaVersion`, `verifierPolicyVersion`, `providerContractVersion`, `normalizerVersion`, `sourceEvidenceHash`, and `sourceArtifactIdentity`.

`generationCommitmentId = sha256Canonical({ schema: "reconciliation-generation-commitment-v1", scope, sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion })`.

`generationPublicationId = sha256Canonical({ schema: "reconciliation-generation-publication-v1", schemaVersion, generationCommitmentId, publicationSequence, publicationState, sourceEvidenceHash, sourceArtifactIdentity })`.

The commitment identifies generation contents; the publication identity binds ordering and every source-evidence field. An operational attempt matches a publication by `generationCommitmentId`; it does not contain or invent `publicationSequence`.

The current accepted generation is the unique valid `ACCEPTED` publication of the supported scope with greatest `publicationSequence`. Zero valid accepted publications maps exactly to `RECONCILIATION_REQUIRED / CURRENT_GENERATION_UNPROVEN`. Conflicting publication identities at that greatest sequence map exactly to `RECONCILIATION_REQUIRED / CURRENT_GENERATION_CONFLICT`. A missing publication source maps exactly to `RECONCILIATION_REQUIRED / CURRENT_GENERATION_SOURCE_UNAVAILABLE`.

For ordering, `inactiveGenerationPublication` is the validated accepted publication whose commitment is bound to the inactive attempt; `laterGenerationPublication` is the corresponding publication bound to a later active attempt. Missing or ambiguous binding maps to `RECONCILIATION_REQUIRED / GENERATION_PUBLICATION_BINDING_UNPROVEN`. An attempt commitment different from the unique current commitment is `SUPERSEDED`; matching it satisfies only currentness.

## Required active evidence

Future `ActiveListingsEvidenceV1` has one exact representation: `schemaVersion`, `publicationId`, safe non-negative integer `publicationSequence`, `sourceArtifactHash`, `observationWatermark`, `orderHash`, `chain`, `contractAddress`, `tokenId`, `presence` (`PRESENT` or `ABSENT`), `status` (or explicit null when absent), `sourceScope` (`collectionSlug`, `protocolAddress`, supported chain/contract), and `canonicalEvidenceVersion`.

`activeEvidenceId = sha256Canonical({ schema: "shadow-active-evidence-v1", schemaVersion, publicationId, publicationSequence, sourceArtifactHash, observationWatermark, orderHash, chain, contractAddress, tokenId, presence, status, sourceScope, canonicalEvidenceVersion })`.

There is no alternate monotonic interpretation for V1. A source that cannot provide `publicationSequence` must not claim V1; production shadow eligibility then fails with `ACTIVE_EVIDENCE_SOURCE_UNAVAILABLE`.

## Point-in-time evaluation

`journalSnapshotIdentity = sha256Canonical({ schema: "shadow-journal-snapshot-v1", watermark, relevantFingerprint })` using accepted canonical evidence serialization.

`evaluationSnapshotIdentity = sha256Canonical({ schema: "shadow-evaluation-snapshot-v1", generationPublicationId, activeEvidenceId, journalSnapshotIdentity })`.

The evaluator reads generation, active evidence, and journal evidence under one repeatable-read boundary where available, then re-reads commitments before append and requires byte-identical identities. A changed commitment maps to `RECONCILIATION_REQUIRED / EVALUATION_SNAPSHOT_CHANGED`. A new event/publication may occur immediately after the final check; that does not mutate the historical decision. A successor evaluation handles it, and future mutation requires Fence B.

Fence A is stable when pre/post relevant fingerprints are equivalent, no **new** relevant order event appears across the fence, and there is no ambiguity, watermark regression, or order mismatch. Historical events identical in both fingerprints do not disqualify the attempt.

## Positive predicate and later ACTIVE ordering

Only after both prerequisite sources exist may `SHADOW_ELIGIBLE` be emitted. It requires an admitted complete inactive result, exact identities/versions/scope, strict provider evidence and semantic hash, false authority flags, stable Fence A, unique current generation commitment match, consistent evaluation snapshot, and authoritative active evidence proving the exact order absent/inactive.

`LaterProviderOrderingProofV1` requires a trusted admitted `COMPLETE` later result with the same supported order identity, `providerResultStatus = ACTIVE_CONFIRMED`, `finalResultStatus = ACTIVE_CONFIRMED`, stable accepted fence, valid semantic hash, and no stale/reconciliation classification. It proves ordering by exactly one of:

1. `NEWER_GENERATION_ORDERING_PROOF`: both publication records are valid accepted publications for the supported scope; the later active result is bound to `laterGenerationPublication`; the inactive result is bound to `inactiveGenerationPublication`; their commitment IDs differ; and `laterGenerationPublication.publicationSequence > inactiveGenerationPublication.publicationSequence`.
2. `SAME_GENERATION_JOURNAL_ORDERING_PROOF`: commitment IDs are equal and the later active result's accepted pre-verification watermark is strictly greater than the inactive result's accepted post-verification watermark, using accepted canonical comparison with no ambiguity/regression.

A re-publication of the same commitment at a greater sequence does not prove provider-result ordering. Equal or unprovable same-generation watermarks, missing publications, or missing bindings map to `RECONCILIATION_REQUIRED / ACTIVE_ORDERING_UNPROVEN` (or `GENERATION_PUBLICATION_BINDING_UNPROVEN` for binding failure). No provider timestamp or wall-clock-only fallback is permitted.

## Exact decision identities and hash

`shadowEvaluationId = sha256Canonical({ schema: "shadow-deactivation-evaluation-v1", attemptId, evaluationSnapshotIdentity })`.

`shadowEvidenceHash = sha256Canonical({ schema: "shadow-deactivation-evidence-v1", attemptId, attemptNumber, operationalSemanticEvidenceHash, attemptGeneration: { sweepId, generationCommitmentId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion }, currentGeneration: { generationCommitmentId, generationPublicationId, schemaVersion, publicationSequence, publicationState, scope, sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion, sourceEvidenceHash, sourceArtifactIdentity }, expectedIdentity, requestIdentity, supportedScope, fenceA: { preVerificationWatermark, preRelevantFingerprint, postVerificationWatermark, postRelevantFingerprint }, currentJournal: { watermark, relevantFingerprint, journalSnapshotIdentity }, activeEvidence: { activeEvidenceId, schemaVersion, publicationId, publicationSequence, sourceArtifactHash, observationWatermark, orderHash, chain, contractAddress, tokenId, presence, status, sourceScope, canonicalEvidenceVersion }, evaluationSnapshotIdentity, laterProviderEvidence, laterProviderOrderingProof, decision, reasonCodes })`.

`shadowDecisionId = sha256Canonical({ schema: "shadow-deactivation-decision-id-v2", shadowEvaluationId, shadowEvidenceHash })`.

`shadowEvidenceHash` never contains `shadowDecisionId`. Identical evidence produces identical evidence and decision IDs. Changed later-provider evidence, decision, or reason codes changes the evidence hash and therefore permits an append-only successor without primary-key collision. A future mutation identity remains separate: `sha256Canonical({ schema: "listing-deactivation-mutation-v1", decisionId: shadowDecisionId, attemptId, generationCommitmentId, orderHash, targetAction: "DEACTIVATE" })`.

## Append-only persistence and examples

Future storage is append-only `targeted_verifier_shadow_decisions`, primary key `shadowDecisionId`, with immutable evidence/hash fields and `previousDecisionId` referencing the immediately preceding row for the same attempt/order lineage. No prior row is updated or deleted.

- Identical replay: same snapshot and evidence → same `shadowEvaluationId`, `shadowEvidenceHash`, and `shadowDecisionId`; deduplicate.
- Same snapshot, new later ACTIVE evidence: same `shadowEvaluationId`, changed evidence/hash/decision ID; successor references the prior eligible row and is `BLOCKED_BY_LATER_EVIDENCE`.
- Newer generation: new snapshot/evaluation ID, new evidence/decision ID; prior row remains immutable and the successor is `SUPERSEDED`.
- Post-append journal change: prior row remains valid historical point-in-time evidence; a new evaluation appends a successor.

Fence B is future-only: it re-reads current generation, active evidence, journal, identity, and inactive status immediately before any separately authorized write. Any change suppresses that write; no authority exists here.
