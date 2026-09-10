import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyOfflineCandidates, type OfflineSweepManifest } from "../src/reconciliation/offlineCandidateModel.js";
import { evaluateOfflineGeneration } from "../src/reconciliation/offlineGenerationBarrierModel.js";
import { createGenerationEvidenceWriter } from "../src/reconciliation/evidence/fileEvidenceStore.js";
import { persistIntegratedEvidence, reconstructIntegratedEvidence } from "../src/reconciliation/evidence/reconciliationEvidenceIntegration.js";
import { deriveTargetedVerifierContext, isTrustedTargetedVerifierContext } from "../src/reconciliation/verifier/targetedVerifierContext.js";
import { applyJournalFence, buildAttemptEvidence, buildTargetedVerifierArtifact, validateFenceResult, validateAttemptEvidenceForContext } from "../src/reconciliation/verifier/targetedVerifierArtifact.js";
import { eventFingerprint, validateTargetedVerifierEligibility, validateAttemptEvidence } from "../src/reconciliation/verifier/targetedVerifierPolicy.js";
import { interpretTargetedOrderResponse, validateProviderResult } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { canonicalEvidence } from "../src/reconciliation/evidence/canonicalEvidence.js";

const CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271";
const PROTOCOL = "0x" + "1".repeat(40);
const START = "2026-01-01T00:00:00.000Z", END = "2026-01-01T00:01:00.000Z";
const PROVENANCE = Object.freeze({ adapter: "a".repeat(64) });
const WATERMARK = { eventId: "100", receivedAt: END };
const HASH_A = "0x" + "a".repeat(64), HASH_B = "0x" + "b".repeat(64);
function manifest(sweep: string): OfflineSweepManifest { return { sweepId: sweep, generationState: "TRANSPORT_COMPLETE", transportResult: "COMPLETE", snapshotStartedAt: START, snapshotCompletedAt: END, paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, sourceProvenance: PROVENANCE }; }
function generationInput(sweep: string) { return { sweepId: sweep, snapshotStartedAt: START, snapshotCompletedAt: END, sourceProvenance: PROVENANCE, startBarrier: { sweepId: sweep, snapshotStartedAt: START, eventHighWaterBefore: WATERMARK }, endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: WATERMARK }, transport: { transportResult: "COMPLETE", snapshotStartedAt: START, snapshotCompletedAt: END, paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, warnings: [], errors: [], sourceProvenance: PROVENANCE, pageAttempts: 2, pagesFetched: 2, httpAttempts: 2, retryAttempts: 0, rawPagesCount: 2, responseHashesCount: 2, observedCount: 2, normalizedCount: 2, pageAttemptDetailsCount: 2, successfulPageAttempts: 2 }, catchUpRounds: [{ roundNumber: 1, observedHighWater: WATERMARK, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }, { roundNumber: 2, observedHighWater: WATERMARK, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }], maxCatchUpRounds: 4 }; }
export async function makeContexts() {
  const root = await mkdtemp(path.join(os.tmpdir(), "crosspair-"));
  const sweep = "123e4567-e89b-12d3-a456-426614174000";
  const writer = await createGenerationEvidenceWriter(root, { sweepId: sweep, modelVersion: "generation-v2", scope: { chain: "gunzilla", collection: "off-the-grid", contract: CONTRACT, endpoint: "https://api.opensea.io/api/v2/listings/collection/off-the-grid/all" }, snapshotStartedAt: START, sourceProvenance: PROVENANCE, policyHash: "d".repeat(64) });
  const orders = [HASH_A, HASH_B].map((hash, i) => ({ orderHash: hash, identity: { orderHash: hash, chain: "gunzilla" as const, contractAddress: CONTRACT, tokenId: String(i + 1), collectionSlug: "off-the-grid" as const, protocolAddress: PROTOCOL }, status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null }));
  const candidate = classifyOfflineCandidates({ manifest: manifest(sweep), seenOrders: [], localOrders: orders, journalEvents: [] });
  const generation = evaluateOfflineGeneration({ ...generationInput(sweep), candidateBundle: candidate });
  await persistIntegratedEvidence(writer, { candidateBundle: candidate, generationResult: generation, sourceProvenance: PROVENANCE });
  const contexts = [];
  for (const hash of [HASH_A, HASH_B]) contexts.push(deriveTargetedVerifierContext(await reconstructIntegratedEvidence(writer, sweep, PROVENANCE), hash, { preVerification: { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], hash) } }));
  return { root, contexts };
}
function body(hash: string, token: string, status = "ACTIVE") { return JSON.stringify({ order_hash: hash, chain: "gunzilla", protocol_address: PROTOCOL, asset: { contract: CONTRACT, identifier: token }, status, remaining_quantity: "1", protocol_data: { parameters: { startTime: "1700000000", endTime: "2000000000" } } }); }
test("runtime trusted contexts and provider/fence cross-pair matrix", async () => {
  const f = await makeContexts();
  try {
    const [contextA, contextB] = f.contexts; assert.equal(isTrustedTargetedVerifierContext(contextA), true); assert.equal(isTrustedTargetedVerifierContext(contextB), true);
    const providerA = interpretTargetedOrderResponse({ context: contextA, httpStatus: 200, rawBody: body(HASH_A, "1"), observedAt: "2026-01-01T00:00:00.000Z" });
    const providerB = interpretTargetedOrderResponse({ context: contextB, httpStatus: 200, rawBody: body(HASH_B, "2"), observedAt: "2026-01-01T00:00:00.000Z" });
    const preA = { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], HASH_A) }, preB = { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], HASH_B) };
    const fenceA = applyJournalFence(providerA, preA, preA), fenceB = applyJournalFence(providerB, preB, preB);
    assert.throws(() => buildAttemptEvidence({ context: contextA, attemptNumber: 0, providerResult: providerA, fenceResult: fenceB }), /FENCE_PROVIDER_MISMATCH|FENCE_CONTEXT_ORDER_MISMATCH/);
    assert.throws(() => buildAttemptEvidence({ context: contextA, attemptNumber: 0, providerResult: providerB, fenceResult: fenceA }), /FENCE_PROVIDER_MISMATCH|PROVIDER_CONTEXT_MISMATCH/);
    assert.throws(() => buildAttemptEvidence({ context: contextA, attemptNumber: 0, providerResult: providerB, fenceResult: fenceB }), /PROVIDER_CONTEXT_MISMATCH|FENCE_CONTEXT_ORDER_MISMATCH/);
    assert.doesNotThrow(() => buildAttemptEvidence({ context: contextA, attemptNumber: 0, providerResult: providerA, fenceResult: fenceA }));
    assert.doesNotThrow(() => buildAttemptEvidence({ context: contextB, attemptNumber: 0, providerResult: providerB, fenceResult: fenceB }));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("final artifact rejects cross-order provider/fence pair", async () => {
  const f = await makeContexts();
  try {
    const [a, b] = f.contexts; const pa = interpretTargetedOrderResponse({ context: a, httpStatus: 200, rawBody: body(HASH_A, "1"), observedAt: "2026-01-01T00:00:00.000Z" }); const pb = interpretTargetedOrderResponse({ context: b, httpStatus: 200, rawBody: body(HASH_B, "2"), observedAt: "2026-01-01T00:00:00.000Z" }); const fa = applyJournalFence(pa, { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], HASH_A) }, { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], HASH_A) }); const fb = applyJournalFence(pb, { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], HASH_B) }, { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], HASH_B) });
    assert.throws(() => buildTargetedVerifierArtifact({ context: a, startedAt: START, completedAt: END, providerResult: pb, fenceResult: fb, transportOutcome: "HTTP", safeHeaders: {} }), /PROVIDER_CONTEXT_MISMATCH|FENCE_CONTEXT_ORDER_MISMATCH|FENCE_PROVIDER_MISMATCH/); assert.equal(validateTargetedVerifierEligibility(a).valid, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("same trusted context binds distinct provider semantic content", async () => {
  const f = await makeContexts();
  try {
    const contextA = f.contexts[0];
    const providerA1 = interpretTargetedOrderResponse({ context: contextA, httpStatus: 200, rawBody: body(HASH_A, "1", "ACTIVE"), observedAt: "2026-01-01T00:00:00.000Z" });
    const providerA2 = interpretTargetedOrderResponse({ context: contextA, httpStatus: 200, rawBody: body(HASH_A, "1", "INACTIVE"), observedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(validateProviderResult(providerA1), true); assert.equal(validateProviderResult(providerA2), true); assert.notEqual(canonicalEvidence(providerA1), canonicalEvidence(providerA2));
    const pre = { watermark: WATERMARK, relevantOrderFingerprint: eventFingerprint([], HASH_A) };
    const fenceA1 = applyJournalFence(providerA1, pre, pre), fenceA2 = applyJournalFence(providerA2, pre, pre);
    assert.equal(validateFenceResult(fenceA1), true); assert.equal(validateFenceResult(fenceA2), true);
    const attemptA1 = buildAttemptEvidence({ context: contextA, attemptNumber: 0, providerResult: providerA1, fenceResult: fenceA1 });
    const attemptA2 = buildAttemptEvidence({ context: contextA, attemptNumber: 1, providerResult: providerA2, fenceResult: fenceA2 });
    assert.equal(validateAttemptEvidence(attemptA1), true); assert.equal(validateAttemptEvidence(attemptA2), true);
    assert.equal(validateAttemptEvidenceForContext(attemptA1, contextA), true); assert.equal(validateAttemptEvidenceForContext(attemptA2, contextA), true);
    assert.notEqual(attemptA1.semanticEvidenceHash, attemptA2.semanticEvidenceHash);
    assert.doesNotThrow(() => buildTargetedVerifierArtifact({ context: contextA, startedAt: START, completedAt: END, providerResult: providerA1, fenceResult: fenceA1, transportOutcome: "HTTP", safeHeaders: {} }));
    assert.doesNotThrow(() => buildTargetedVerifierArtifact({ context: contextA, startedAt: START, completedAt: END, providerResult: providerA2, fenceResult: fenceA2, transportOutcome: "HTTP", safeHeaders: {} }));
    assert.throws(() => buildAttemptEvidence({ context: contextA, attemptNumber: 2, providerResult: providerA1, fenceResult: fenceA2 }), /FENCE_PROVIDER_MISMATCH/);
    assert.throws(() => buildAttemptEvidence({ context: contextA, attemptNumber: 3, providerResult: providerA2, fenceResult: fenceA1 }), /FENCE_PROVIDER_MISMATCH/);
    assert.throws(() => buildTargetedVerifierArtifact({ context: contextA, startedAt: START, completedAt: END, providerResult: providerA1, fenceResult: fenceA2, transportOutcome: "HTTP", safeHeaders: {} }), /FENCE_PROVIDER_MISMATCH/);
    assert.throws(() => buildTargetedVerifierArtifact({ context: contextA, startedAt: START, completedAt: END, providerResult: providerA2, fenceResult: fenceA1, transportOutcome: "HTTP", safeHeaders: {} }), /FENCE_PROVIDER_MISMATCH/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
