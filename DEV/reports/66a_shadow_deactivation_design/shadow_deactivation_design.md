# Task 66A — Shadow Deactivation Eligibility Design

## Scope and safety

This is an audit/shadow design. The accepted targeted-verifier operational worker is an immutable input. No listing, inventory, order, sale, OpenSea, or production state is mutated. `authorityGranted`, `deactivationAuthorityGranted`, and the future `mutationAuthorityGranted` are always `false`.

## Closed decision model

The shadow evaluator emits exactly one of:

- `SHADOW_ELIGIBLE`: all positive evidence and freshness checks pass.
- `SHADOW_INELIGIBLE`: a deterministic disqualifier exists, but no contradictory journal evidence is present.
- `RECONCILIATION_REQUIRED`: the accepted fence or current evidence is contradictory, ambiguous, regressed, or corrupted.
- `SUPERSEDED`: a newer accepted generation has replaced this attempt's generation.
- `BLOCKED_BY_LATER_EVIDENCE`: later trustworthy activity dominates the inactive observation.

Every result carries sorted, deduplicated reason codes and a canonical decision hash. A decision is never an authorization token.

## Positive predicate

`SHADOW_ELIGIBLE` requires, atomically at evaluation time:

1. The durable record is `COMPLETE`, has `providerResultStatus = INACTIVE_CONFIRMED`, `finalResultStatus = INACTIVE_CONFIRMED`, `failureClassification = null`, and `retry.retryable = false`.
2. The record is admitted by the operational store: exact attempt and idempotency identities, current verifier/schema/provider/normalizer versions, supported chain/collection/contract, valid expected/request identities, strict provider rehydration, provider-reason equality, valid pre/post journal evidence, and exact operational semantic hash.
3. `authorityGranted` and `deactivationAuthorityGranted` are false. No authority is inferred from a positive decision.
4. Fence A is stable: the post watermark/fingerprint is valid, is not regressed from pre evidence, has no relevant event, and has no ambiguity, order mismatch, or watermark-regression reason.
5. The attempt generation (`sweepId`, candidate artifact, barrier artifact, generation root, and versions) is the current accepted generation. The current active-listings snapshot and journal view agree that this order is not active.
6. No later evidence exists after Fence A: no relevant item-listed/order-revalidate/sale/cancel/transfer event, active confirmation, identity conflict, ambiguous fingerprint, or newer generation disagreement.

Any missing, stale, contradictory, or untrusted input produces a non-eligible state.

## Generation and later-evidence rules

Generation publication is monotonic. An attempt is superseded when a newer accepted generation for the same supported scope changes the generation root or barrier/candidate commitment. Old-generation records remain auditable but cannot be eligible. A newer trustworthy `ACTIVE_CONFIRMED` result dominates an older inactive result regardless of timestamps.

After a decision's Fence A watermark, evaluate all relevant journal events and active-listings evidence. `item_listed`, `order_revalidate`, sale/cancel/order changes, relevant transfers, identity conflicts, ambiguity, or watermark regression produce `BLOCKED_BY_LATER_EVIDENCE` or `RECONCILIATION_REQUIRED` (contradiction/ambiguity takes precedence). A later generation produces `SUPERSEDED`. Unknown or unverifiable later evidence fails closed as reconciliation-required.

## Double fence before any future mutation

Fence B is a fresh read immediately before a separately authorized mutation task. It reads the current accepted generation root/barrier, the current order identity and active-listings evidence, and a journal snapshot using the same accepted validator and relevant-event fingerprint rules. Fence B must preserve the candidate's exact order/expected/request identity, generation commitments, and inactive status; its watermark must be at least Fence A's watermark without regression, and its relevant fingerprint must remain equivalent with no relevant event. Any change, ambiguity, conflict, newer generation, active evidence, or read failure suppresses mutation and records `RECONCILIATION_REQUIRED`/`SHADOW_INELIGIBLE`. There is no write in this design.

## Deterministic identities and hash

The shadow decision identity is `sha256Canonical({ schema: "shadow-deactivation-decision-v1", attemptId, attemptNumber, sweepId, generationRootHash, candidateArtifactHash, barrierArtifactHash, expectedIdentity, requestIdentity, fenceA: { preVerificationWatermark, preRelevantFingerprint, postVerificationWatermark, postRelevantFingerprint }, currentEvidence: { generationRootHash, activeEvidenceHash, currentWatermark, currentRelevantFingerprint }, decision, reasonCodes })`. Re-evaluating identical admitted evidence yields the same identity and hash. This is separate from `operationalSemanticEvidenceHash`; the latter remains unchanged.

A future mutation task must use a separate idempotency identity, for example `sha256Canonical({ schema: "listing-deactivation-mutation-v1", decisionId, attemptId, generationRootHash, orderHash, targetAction: "DEACTIVATE" })`. It is not implemented or accepted by this task.

## Persistence proposal (schema only)

Use a dedicated append-only `targeted_verifier_shadow_decisions` table rather than altering operational attempts. Primary key: `decisionId`. Store `attemptId`, `attemptNumber`, `sweepId`, generation/candidate/barrier references, expected/request identity, decision, sorted reason codes, Fence A pre/post evidence, current Fence B evidence when evaluated, decision hash, `createdAt`, `evaluatedAt`, and nullable `supersededByDecisionId`/`blockedByDecisionId`. Add a uniqueness key over `(attemptId, decisionHash)` for harmless duplicate evaluation. No migration is created here.

## Concurrency and crash behavior

Evaluators read immutable evidence and use compare-and-record semantics. Two identical evaluations may create one deduplicated decision; conflicting current evidence yields the stricter non-eligible state. A journal event or generation publication racing the read invalidates the evaluation unless the durable snapshot proves it preceded the fence. A crash before recording is safe: replay recomputes the same decision identity. A crash after recording is safe: replay is idempotent. No evaluator holds or grants mutation authority.

## Authority boundary

`SHADOW_ELIGIBLE` means only “evidence would satisfy a future policy.” It cannot call a listing repository, OpenSea client, inventory writer, order cancellation path, or deactivation service. Any future implementation must require a separately reviewed mutation task and Fence B.
