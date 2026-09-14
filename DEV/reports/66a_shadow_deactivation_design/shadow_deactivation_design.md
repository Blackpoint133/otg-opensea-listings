# Task 66AR — Shadow Deactivation Design Contract

## Scope and safety

This is design-only. The accepted operational worker is immutable input. No evaluator, decision, or future prerequisite grants authority or writes listings, inventory, orders, sales, OpenSea state, or production databases. `authorityGranted`, `deactivationAuthorityGranted`, and `mutationAuthorityGranted` remain `false`.

## Closed shadow states

The shadow evaluator emits exactly `SHADOW_ELIGIBLE`, `SHADOW_INELIGIBLE`, `RECONCILIATION_REQUIRED`, `SUPERSEDED`, or `BLOCKED_BY_LATER_EVIDENCE`, with sorted unique reason codes. A conceptual future result, `FUTURE_MUTATION_PREREQUISITES_SATISFIED`, is not a shadow state and is never emitted by this task.

## Authoritative current generation

Currentness is read from the accepted reconciliation generation publication record (the durable generation/barrier publication used by the reconciliation layer), not inferred from an attempt or wall-clock time. Its immutable canonical identity is:

`generationId = sha256Canonical({ schema: "reconciliation-generation-v1", sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion, publicationSequence })`.

`publicationSequence` is the authoritative monotonic ordering field. A generation is accepted/current only when its publication record is durably marked accepted, its artifact/root commitments and versions validate, its scope matches the supported target, and it is the unique accepted record with the greatest sequence. A generation consists of the complete sweep/root/candidate/barrier/version tuple above; fields from different publication records cannot be combined.

Zero accepted generations means `RECONCILIATION_REQUIRED` (currentness cannot be proven). Multiple accepted records claiming the same greatest sequence with different identities also mean `RECONCILIATION_REQUIRED`. A generation is newer only when its accepted `publicationSequence` is strictly greater. An attempt whose generation identity differs from the unique current publication is `SUPERSEDED`; replay of an older generation is therefore detected without timestamps.

## Consistent evaluation snapshot

One evaluation reads the unique current generation, active-listings evidence, and journal snapshot under one repeatable-read reconciliation transaction where supported. The transaction records the generation publication sequence and evidence commitments. Before recording a decision, it re-reads the current generation publication and requires identical generation identity/sequence and identical active/journal commitments. If a transaction cannot provide this boundary, the evaluator uses the same read-journal-read-generation protocol and fails closed unless all commitments are byte-identical. Any concurrent publication, journal change, active-evidence change, ambiguous read, or unavailable source prevents `SHADOW_ELIGIBLE`.

## Positive predicate and Fence A

`SHADOW_ELIGIBLE` requires a current, admitted `COMPLETE` attempt with `providerResultStatus = INACTIVE_CONFIRMED`, `finalResultStatus = INACTIVE_CONFIRMED`, `failureClassification = null`, `retry.retryable = false`, false authority flags, exact identities/versions/scope, strict provider rehydration, provider-reason equality, and exact operational semantic hash.

Fence A is stable exactly when the accepted pre/post watermarks and relevant fingerprints are valid, the fingerprints are equivalent, no **new** relevant order event appears across the fence, there is no ordering ambiguity, watermark regression, or order mismatch, and accepted fence reasons contain none of those failures. Historical relevant events already present identically in both fingerprints do not disqualify the attempt by themselves. Current-generation and active-evidence checks must also pass.

## Later evidence and precedence

Later evidence is compared using accepted journal ordering/provenance, never wall-clock time alone. A provably newer trustworthy `ACTIVE_CONFIRMED` result dominates the older inactive result and produces `BLOCKED_BY_LATER_EVIDENCE`; an unprovable ordering produces `RECONCILIATION_REQUIRED`. New listed/revalidated/sale/cancel/order/transfer evidence, identity conflict, ambiguity, or regression suppresses eligibility. A newer accepted generation produces `SUPERSEDED`. Corruption or ambiguity has precedence over ordinary ineligibility.

## Fence B is a separate future stage

Stage 1 is shadow evaluation and may produce `SHADOW_ELIGIBLE` using the accepted attempt, current generation, current journal, and current active evidence. Fence B is not required to create that state.

Stage 2 is future mutation eligibility: an already persisted `SHADOW_ELIGIBLE` decision plus a fresh Fence B plus separately reviewed mutation authority. Fence B re-reads current generation, active evidence, and journal; requires unchanged identity/commitments, no new relevant event, equivalent fingerprint, monotonic watermark, no ambiguity/regression, and current inactive evidence. Any change suppresses mutation and returns to reconciliation/shadow-ineligible. Neither stage 2 nor authority exists in 66A/66AR.

## Decision identity and evidence hash

These are distinct. `shadowDecisionId = sha256Canonical({ schema: "shadow-deactivation-decision-id-v1", attemptId, evaluationSnapshotIdentity })`, where `evaluationSnapshotIdentity` is the canonical tuple of the unique generation identity/sequence, active-evidence identity, and journal snapshot identity.

`shadowEvidenceHash = sha256Canonical({ schema: "shadow-deactivation-evidence-v1", attemptId, attemptNumber, operationalSemanticEvidenceHash, attemptGeneration: { sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, candidateModelVersion, generationModelVersion, verifierSchemaVersion, verifierPolicyVersion, providerContractVersion, normalizerVersion }, currentGeneration: { generationId, sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, versions, publicationSequence }, expectedIdentity, requestIdentity, supportedScope, fenceA: { preVerificationWatermark, preRelevantFingerprint, postVerificationWatermark, postRelevantFingerprint }, currentJournal: { watermark, relevantFingerprint }, activeEvidence, laterProviderEvidence, decision, reasonCodes })`.

`activeEvidence` is canonical material containing the authoritative active-listings publication/generation identifier and sequence, source artifact hash, observation watermark, exact order identity (`orderHash`, chain, contract, token), and authoritative presence/status result. If the active-listings source cannot provide these versioned commitments, shadow eligibility is impossible and fails closed. `laterProviderEvidence`, when present, contains the exact provider-result evidence identity/hash and accepted ordering proof relative to the inactive attempt.

Any eligibility-changing input changes `shadowEvidenceHash`. Operational semantic hash material and format are not changed. A future mutation idempotency identity remains separate: `sha256Canonical({ schema: "listing-deactivation-mutation-v1", decisionId, attemptId, generationId, orderHash, targetAction: "DEACTIVATE" })`.

## Append-only persistence proposal

Use an append-only `targeted_verifier_shadow_decisions` table with immutable rows: primary key `shadowDecisionId`, unique `(shadowDecisionId, shadowEvidenceHash)`, attempt/generation/currentness references, decision/reasons, Fence A/current evidence, hashes, and created/evaluated timestamps. Do not update prior rows. Supersession/blocking is represented by a new successor row containing `previousDecisionId` and `supersessionReason`; no prior-row update is required. No migration is created here.

## Concurrency and crash behavior

Concurrent evaluators use snapshot commitments and unique decision identity. Identical evidence deduplicates; conflicting snapshots produce a stricter new non-eligible decision. Publication or journal races fail the consistency check. A crash before append is safely replayable; after append, replay is idempotent. No path calls a mutation client.

## Authority boundary

`SHADOW_ELIGIBLE` is an auditable evidence result only. It cannot invoke a repository, OpenSea client, inventory writer, order cancellation, or deactivation service. Implementation and mutation authority require a separate task, review, and Fence B.
