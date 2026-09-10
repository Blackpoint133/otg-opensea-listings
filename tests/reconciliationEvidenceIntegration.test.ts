import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyOfflineCandidates, OFFLINE_AUTHORITY_STATEMENT, OFFLINE_CANDIDATE_MODEL_VERSION, validateOfflineCandidateBundle, type OfflineSweepManifest } from "../src/reconciliation/offlineCandidateModel.js";
import { evaluateOfflineGeneration, OFFLINE_GENERATION_MODEL_VERSION, validateOfflineGenerationResult, type OfflineGenerationInput } from "../src/reconciliation/offlineGenerationBarrierModel.js";
import { sha256Canonical } from "../src/reconciliation/evidence/canonicalEvidence.js";
import { createGenerationEvidenceWriter } from "../src/reconciliation/evidence/fileEvidenceStore.js";
import { persistIntegratedEvidence, reconstructIntegratedEvidence } from "../src/reconciliation/evidence/reconciliationEvidenceIntegration.js";

const SWEEP = "123e4567-e89b-12d3-a456-426614174000";
const START = "2026-08-23T13:00:00.000Z";
const END = "2026-08-23T13:12:00.000Z";
const PROVENANCE = Object.freeze({ adapter: "a".repeat(64) });
const HASH = "0x" + "a".repeat(64);
const HASH_2 = "0x" + "b".repeat(64);
const HASH_3 = "0x" + "c".repeat(64);

function candidate(classes: Array<"PRESENT" | "ABSENT_CANDIDATE" | "BLOCKED">) {
  const manifest: OfflineSweepManifest = { sweepId: SWEEP, generationState: "TRANSPORT_COMPLETE", transportResult: "COMPLETE", snapshotStartedAt: START, snapshotCompletedAt: END, paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, sourceProvenance: PROVENANCE };
  const hashes = [HASH, HASH_2, HASH_3];
  const localOrders = classes.map((classification, index) => ({ orderHash: hashes[index], identity: { orderHash: hashes[index], chain: "gunzilla" as const, contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", tokenId: String(index + 1), collectionSlug: "off-the-grid" as const, protocolAddress: "0x0000000000000000000000000000000000000001" }, status: classification === "BLOCKED" ? "sold" as const : "active" as const, isActive: classification !== "BLOCKED", needsReconciliation: classification === "BLOCKED", lastOrderEventTimestamp: "2026-08-23T12:00:00.000Z", lastOrderEventVersion: "1" }));
  const seenOrders = classes.flatMap((classification, index) => classification === "PRESENT" ? [{ sweepId: SWEEP, orderHash: hashes[index], pageNumber: index + 1, rawPageHash: "b".repeat(64), normalizedMaterialHash: "c".repeat(64) }] : []);
  return classifyOfflineCandidates({ manifest, localOrders, seenOrders, journalEvents: [] });
}

function generation(): OfflineGenerationInput {
  const watermark = (eventId: string, receivedAt = END) => ({ eventId, receivedAt });
  return { sweepId: SWEEP, snapshotStartedAt: START, snapshotCompletedAt: END, sourceProvenance: PROVENANCE, startBarrier: { sweepId: SWEEP, snapshotStartedAt: START, eventHighWaterBefore: watermark("100", "2026-08-23T12:59:00.000Z") }, endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("100") }, transport: { transportResult: "COMPLETE", snapshotStartedAt: START, snapshotCompletedAt: END, paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, warnings: [], errors: [], sourceProvenance: PROVENANCE, pageAttempts: 2, pagesFetched: 2, httpAttempts: 2, retryAttempts: 0, rawPagesCount: 2, responseHashesCount: 2, observedCount: 2, normalizedCount: 2, pageAttemptDetailsCount: 2, successfulPageAttempts: 2 }, catchUpRounds: [{ roundNumber: 1, observedHighWater: watermark("100"), pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }, { roundNumber: 2, observedHighWater: watermark("100"), pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }], maxCatchUpRounds: 4 };
}

async function fixture(classes: Array<"PRESENT" | "ABSENT_CANDIDATE" | "BLOCKED"> = ["ABSENT_CANDIDATE"]) { const root = await mkdtemp(path.join(os.tmpdir(), "integration-evidence-")); const writer = await createGenerationEvidenceWriter(root, { sweepId: SWEEP, modelVersion: "generation-v1", scope: { chain: "gunzilla", collection: "off-the-grid", contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", endpoint: "https://api.opensea.io/api/v2/listings/collection/off-the-grid/all" }, snapshotStartedAt: START, sourceProvenance: PROVENANCE, policyHash: "d".repeat(64) }); const candidateBundle = candidate(classes); const generationResult = evaluateOfflineGeneration({ ...generation(), candidateBundle }); return { root, writer, candidateBundle, generationResult }; }

test("actual candidate and generation model outputs integrate and reopen VALID", async () => { const f = await fixture(); try { const manifest = await persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: f.generationResult, sourceProvenance: PROVENANCE }); assert.equal(manifest.sweepId, SWEEP); const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE); assert.equal(result.status, "VALID"); assert.equal(result.candidate?.authorityGranted, false); assert.equal(result.barrier?.deactivationAuthorityGranted, false); assert.equal(result.barrier?.candidateArtifactHash, result.candidateRef?.contentHash); } finally { await rm(f.root, { recursive: true, force: true }); } });
test("PRESENT, BLOCKED and ABSENT classifications are persisted without reinterpretation", async () => { const f = await fixture(["PRESENT", "BLOCKED", "ABSENT_CANDIDATE"]); try { await persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: f.generationResult, sourceProvenance: PROVENANCE }); const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE); assert.equal(result.status, "VALID"); assert.deepEqual((result.candidate?.payload.orders as Array<Record<string, unknown>>).map((item) => item.classification), ["PRESENT", "BLOCKED", "ABSENT_CANDIDATE"]); } finally { await rm(f.root, { recursive: true, force: true }); } });
test("candidate sweep, model and provenance mismatch fail closed", async () => { for (const mutate of [ (value: any) => { value.sweepId = "other"; }, (value: any) => { value.modelVersion = "future"; }, (value: any) => { value.sourceProvenance = { other: "x" }; } ]) { const f = await fixture(); try { const forged = JSON.parse(JSON.stringify(f.candidateBundle)); mutate(forged); const result = await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: forged, generationResult: f.generationResult, sourceProvenance: PROVENANCE })); assert.equal(result, undefined); } finally { await rm(f.root, { recursive: true, force: true }); } } });
test("generation mismatch and invalid authority fail closed", async () => { const f = await fixture(); try { const forged = JSON.parse(JSON.stringify(f.generationResult)); forged.modelVersion = "future"; await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: forged, sourceProvenance: PROVENANCE })); } finally { await rm(f.root, { recursive: true, force: true }); } });
test("candidate artifact cannot be registered without barrier and barrier linkage is exact", async () => { const f = await fixture(); try { await f.writer.writeArtifact({ artifactType: "candidate-bundle", artifactId: "candidate-bundle", relativePath: "candidate-bundle.json", payload: { artifactType: "candidate-bundle", artifactId: "candidate-bundle", sweepId: SWEEP } }); await f.writer.finalizeManifest(); const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE); assert.notEqual(result.status, "VALID"); } finally { await rm(f.root, { recursive: true, force: true }); } });
test("partial integration and missing root never reconstruct VALID", async () => { const f = await fixture(); try { const candidatePayload = JSON.stringify(f.candidateBundle); await f.writer.writeArtifact({ artifactType: "candidate-bundle", artifactId: "candidate-bundle", relativePath: "candidate-bundle.json", payload: candidatePayload }); const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE); assert.notEqual(result.status, "VALID"); } finally { await rm(f.root, { recursive: true, force: true }); } });
test("tampered integrated child becomes CORRUPT", async () => { const f = await fixture(); try { await persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: f.generationResult, sourceProvenance: PROVENANCE }); const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE); assert.equal(result.status, "VALID"); const ref = result.candidateRef!; const bytes = await f.writer.readArtifact(ref); const tampered = [...bytes]; tampered[0] = tampered[0] ^ 1; const fs = await import("node:fs/promises"); await fs.writeFile(path.join(f.root, SWEEP, ref.relativePath), Uint8Array.from(tampered)); const corrupt = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE); assert.equal(corrupt.status, "CORRUPT"); } finally { await rm(f.root, { recursive: true, force: true }); } });
test("reconstruction is deeply frozen and authority cannot be mutated", async () => { const f = await fixture(); try { await persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: f.generationResult, sourceProvenance: PROVENANCE }); const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE); assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.candidate), true); assert.equal(Object.isFrozen(result.barrier), true); try { (result as any).deactivationAuthorityGranted = true; } catch {} assert.equal(result.deactivationAuthorityGranted, false); } finally { await rm(f.root, { recursive: true, force: true }); } });
test("same logical inputs produce equal envelope hashes", async () => { const a = await fixture(); const b = await fixture(); try { await persistIntegratedEvidence(a.writer, { candidateBundle: a.candidateBundle, generationResult: a.generationResult, sourceProvenance: PROVENANCE }); await persistIntegratedEvidence(b.writer, { candidateBundle: b.candidateBundle, generationResult: b.generationResult, sourceProvenance: PROVENANCE }); const ar = await reconstructIntegratedEvidence(a.writer, SWEEP, PROVENANCE); const br = await reconstructIntegratedEvidence(b.writer, SWEEP, PROVENANCE); assert.equal(ar.candidateRef?.contentHash, br.candidateRef?.contentHash); assert.equal(ar.barrierRef?.contentHash, br.barrierRef?.contentHash); } finally { await rm(a.root, { recursive: true, force: true }); await rm(b.root, { recursive: true, force: true }); } });

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

async function writeLegacyGraph(writer: any, candidatePayload: unknown, generationPayload: unknown) {
  const canonicalCandidatePayload = JSON.parse(JSON.stringify(candidatePayload));
  const canonicalGenerationPayload = JSON.parse(JSON.stringify(generationPayload));
  const candidateEnvelope = { artifactType: "candidate-bundle", artifactId: "candidate-bundle", artifactSchemaVersion: "candidate-bundle-envelope-v3", sweepId: SWEEP, candidateModelVersion: OFFLINE_CANDIDATE_MODEL_VERSION, sourceProvenance: PROVENANCE, candidateBundleHash: sha256Canonical(canonicalCandidatePayload), authorityGranted: false, payload: canonicalCandidatePayload };
  const candidateRef = await writer.writeArtifact({ artifactType: "candidate-bundle", artifactId: "candidate-bundle", relativePath: "candidate-bundle.json", schemaVersion: "candidate-bundle-envelope-v3", payload: candidateEnvelope });
  const barrierEnvelope = { artifactType: "barrier-evaluation", artifactId: "barrier-evaluation", artifactSchemaVersion: "barrier-evaluation-envelope-v2", sweepId: SWEEP, generationModelVersion: OFFLINE_GENERATION_MODEL_VERSION, sourceProvenance: PROVENANCE, generationResultHash: sha256Canonical(canonicalGenerationPayload), candidateArtifactHash: candidateRef.contentHash, state: "VERIFIED", fenceOutcome: "FENCE_ELIGIBLE", semanticStatement: "BARRIER PREREQUISITES ONLY. NO ORDER VERIFICATION. NO DEACTIVATION AUTHORITY.", deactivationAuthorityGranted: false, payload: canonicalGenerationPayload };
  const barrierRef = await writer.writeArtifact({ artifactType: "barrier-evaluation", artifactId: "barrier-evaluation", relativePath: "barrier-evaluation.json", schemaVersion: "barrier-evaluation-envelope-v2", payload: barrierEnvelope });
  await writer.writeArtifact({ artifactType: "transitions", artifactId: "history", relativePath: "transitions.jsonl", payload: [{ sweepId: SWEEP, sequence: 1, fromState: "OPEN", toState: "TRANSPORT_COMPLETE", reasonCodes: [], evidenceRootHash: barrierRef.contentHash, modelVersion: OFFLINE_GENERATION_MODEL_VERSION, recordedAt: END, writerInstance: "legacy-semantic-forge" }, { sweepId: SWEEP, sequence: 2, fromState: "TRANSPORT_COMPLETE", toState: "CATCHING_UP", reasonCodes: [], evidenceRootHash: barrierRef.contentHash, modelVersion: OFFLINE_GENERATION_MODEL_VERSION, recordedAt: END, writerInstance: "legacy-semantic-forge" }, { sweepId: SWEEP, sequence: 3, fromState: "CATCHING_UP", toState: "VERIFIED", reasonCodes: [], evidenceRootHash: barrierRef.contentHash, modelVersion: OFFLINE_GENERATION_MODEL_VERSION, recordedAt: END, writerInstance: "legacy-semantic-forge" }] });
  await writer.finalizeManifest({ writerProvenance: PROVENANCE });
}

test("minimal deeply-frozen candidate imitation is rejected before hashing", async () => {
  const f = await fixture();
  try {
    const forged = freezeTree({ modelVersion: OFFLINE_CANDIDATE_MODEL_VERSION, authorityStatement: OFFLINE_AUTHORITY_STATEMENT, authorityGranted: false, sweepId: SWEEP, sourceProvenance: { ...PROVENANCE }, manifestValidation: { eligible: true, reasons: [] }, orders: [] });
    await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: forged, generationResult: f.generationResult, sourceProvenance: PROVENANCE }), /INVALID_CANDIDATE_INTEGRATION_INPUT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("minimal deeply-frozen generation imitation is rejected before hashing", async () => {
  const f = await fixture();
  try {
    const forged = freezeTree({ modelVersion: OFFLINE_GENERATION_MODEL_VERSION, sweepId: SWEEP, sourceProvenance: { ...PROVENANCE }, deactivationAuthorityGranted: false, state: "VERIFIED", stateHistory: ["OPEN", "VERIFIED"], finalFence: { outcome: "FENCE_ELIGIBLE", eligible: true, reasons: [] }, startBarrier: {}, endBarrier: {}, catchUp: {}, transportValidation: {}, candidateAdvancement: [], abortReasons: [] });
    await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: forged, sourceProvenance: PROVENANCE }), /INVALID_GENERATION_INTEGRATION_INPUT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("candidate runtime adversarial fields fail before persistence", async () => {
  for (const mutate of [
    (value: any) => { delete value.counts; },
    (value: any) => { value.orders[0].authorityGranted = true; },
    (value: any) => { value.orders[0].classification = "FUTURE"; },
    (value: any) => { value.orders[0].orderHash = "not-an-order-hash"; },
    (value: any) => { delete value.orders[0].relevantEventSummary; },
    (value: any) => { value.manifestValidation.eligible = false; }
  ]) {
    const f = await fixture();
    try {
      const forged = JSON.parse(JSON.stringify(f.candidateBundle)); mutate(forged); freezeTree(forged);
      await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: forged, generationResult: f.generationResult, sourceProvenance: PROVENANCE }), /INVALID_CANDIDATE_INTEGRATION_INPUT/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("generation runtime contradictions fail before persistence", async () => {
  for (const mutate of [
    (value: any) => { delete value.transportValidation; },
    (value: any) => { value.transportValidation.eligible = false; },
    (value: any) => { value.stateHistory = ["OPEN", "VERIFIED"]; },
    (value: any) => { value.state = "VERIFIED"; value.finalFence.outcome = "FENCE_BLOCKED"; },
    (value: any) => { value.deactivationAuthorityGranted = true; },
    (value: any) => { value.catchUp.stable = false; }
  ]) {
    const f = await fixture();
    try {
      const forged = JSON.parse(JSON.stringify(f.generationResult)); mutate(forged); freezeTree(forged);
      await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: forged, sourceProvenance: PROVENANCE }), /INVALID_GENERATION_INTEGRATION_INPUT/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("hash-consistent legacy forged graph is rejected during reconstruction", async () => {
  const f = await fixture();
  try {
    const candidatePayload: any = freezeTree({ modelVersion: OFFLINE_CANDIDATE_MODEL_VERSION, authorityStatement: OFFLINE_AUTHORITY_STATEMENT, authorityGranted: false, sweepId: SWEEP, sourceProvenance: PROVENANCE, manifestValidation: { eligible: true, reasons: [] }, orders: [] });
    const generationPayload: any = freezeTree({ modelVersion: OFFLINE_GENERATION_MODEL_VERSION, sweepId: SWEEP, sourceProvenance: PROVENANCE, deactivationAuthorityGranted: false, state: "VERIFIED", stateHistory: ["OPEN", "TRANSPORT_COMPLETE", "CATCHING_UP", "VERIFIED"], transportValidation: {}, startBarrier: {}, endBarrier: {}, catchUp: {}, finalFence: { outcome: "FENCE_ELIGIBLE", eligible: true, reasons: [] }, candidateAdvancement: [], abortReasons: [] });
    const candidateEnvelope = { artifactType: "candidate-bundle", artifactId: "candidate-bundle", artifactSchemaVersion: "candidate-bundle-envelope-v1", sweepId: SWEEP, candidateModelVersion: OFFLINE_CANDIDATE_MODEL_VERSION, sourceProvenance: PROVENANCE, candidateBundleHash: sha256Canonical(candidatePayload), authorityGranted: false, payload: candidatePayload };
    const candidateRef = await f.writer.writeArtifact({ artifactType: "candidate-bundle", artifactId: "candidate-bundle", relativePath: "candidate-bundle.json", schemaVersion: "candidate-bundle-envelope-v1", payload: candidateEnvelope });
    const barrierEnvelope = { artifactType: "barrier-evaluation", artifactId: "barrier-evaluation", artifactSchemaVersion: "barrier-evaluation-envelope-v1", sweepId: SWEEP, generationModelVersion: OFFLINE_GENERATION_MODEL_VERSION, sourceProvenance: PROVENANCE, generationResultHash: sha256Canonical(generationPayload), candidateArtifactHash: candidateRef.contentHash, state: "VERIFIED", fenceOutcome: "FENCE_ELIGIBLE", semanticStatement: "BARRIER PREREQUISITES ONLY. NO ORDER VERIFICATION. NO DEACTIVATION AUTHORITY.", deactivationAuthorityGranted: false, payload: generationPayload };
    const barrierRef = await f.writer.writeArtifact({ artifactType: "barrier-evaluation", artifactId: "barrier-evaluation", relativePath: "barrier-evaluation.json", schemaVersion: "barrier-evaluation-envelope-v1", payload: barrierEnvelope });
    await f.writer.writeArtifact({ artifactType: "transitions", artifactId: "history", relativePath: "transitions.jsonl", payload: [{ sweepId: SWEEP, sequence: 1, fromState: "OPEN", toState: "TRANSPORT_COMPLETE", reasonCodes: [], evidenceRootHash: barrierRef.contentHash, modelVersion: OFFLINE_GENERATION_MODEL_VERSION, recordedAt: END, writerInstance: "legacy" }] });
    await f.writer.finalizeManifest({ writerProvenance: PROVENANCE });
    const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE);
    assert.notEqual(result.status, "VALID");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("real upstream outputs remain accepted after full trust validation", async () => {
  const f = await fixture();
  try {
    await persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: f.generationResult, sourceProvenance: PROVENANCE });
    const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE);
    assert.equal(result.status, "VALID");
    assert.equal(result.candidate?.authorityGranted, false);
    assert.equal(result.barrier?.deactivationAuthorityGranted, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("candidate semantic contract rejects the exact audit forge before persistence", async () => {
  const f = await fixture();
  try {
    const forged: any = JSON.parse(JSON.stringify(f.candidateBundle)); forged.orders[0].classification = "ABSENT_CANDIDATE"; forged.orders[0].seenInSweep = true; forged.orders[0].reasons = ["ORDER_NOT_ACTIVE"]; freezeTree(forged);
    assert.equal(validateOfflineCandidateBundle(forged).valid, false);
    await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: forged, generationResult: f.generationResult, sourceProvenance: PROVENANCE }), /INVALID_CANDIDATE_INTEGRATION_INPUT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("candidate semantic matrix rejects impossible classification, reason, event linkage and count relationships", () => {
  const base = candidate(["ABSENT_CANDIDATE"]);
  const mutations = [
    (value: any) => { value.orders[0].classification = "PRESENT"; value.orders[0].seenInSweep = false; },
    (value: any) => { value.orders[0].seenInSweep = true; },
    (value: any) => { value.orders[0].reasons = ["ORDER_NOT_ACTIVE"]; },
    (value: any) => { value.orders[0].classification = "BLOCKED"; value.orders[0].reasons = []; },
    (value: any) => { value.orders[0].relevantJournalEventIds = ["b"]; value.orders[0].relevantEventSummary = []; },
    (value: any) => { value.counts.total += 1; }
  ];
  for (const mutate of mutations) { const forged: any = JSON.parse(JSON.stringify(base)); mutate(forged); freezeTree(forged); assert.equal(validateOfflineCandidateBundle(forged).valid, false); }
});

test("generation semantic contract rejects the exact one-round VERIFIED forge before persistence", async () => {
  const f = await fixture();
  try {
    const forged: any = JSON.parse(JSON.stringify(f.generationResult)); forged.catchUp.rounds = forged.catchUp.rounds.slice(0, 1); freezeTree(forged);
    assert.equal(validateOfflineGenerationResult(forged).valid, false);
    await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: forged, sourceProvenance: PROVENANCE }), /INVALID_GENERATION_INTEGRATION_INPUT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("generation semantic matrix rejects inconsistent stability, watermark, rounds and state metadata", () => {
  const base = evaluateOfflineGeneration(generation());
  const mutations = [
    (value: any) => { value.catchUp.rounds = value.catchUp.rounds.slice(0, 1); },
    (value: any) => { value.catchUp.rounds[1].observedHighWater.eventId = "101"; },
    (value: any) => { value.catchUp.rounds[0].pendingCount = 1; },
    (value: any) => { value.catchUp.stable = false; value.catchUp.outcome = "NOT_STABLE"; },
    (value: any) => { value.catchUp.roundsEvaluated = 1; },
    (value: any) => { value.finalFence.outcome = "FENCE_BLOCKED"; value.finalFence.eligible = false; value.finalFence.reasons = ["FENCE_BLOCKED"]; }
  ];
  for (const mutate of mutations) { const forged: any = JSON.parse(JSON.stringify(base)); mutate(forged); freezeTree(forged); assert.equal(validateOfflineGenerationResult(forged).valid, false); }
});

test("hash-consistent semantic legacy forges never reconstruct VALID", async () => {
  const candidateFixture = await fixture();
  const generationFixture = await fixture();
  try {
    const forgedCandidate: any = JSON.parse(JSON.stringify(candidateFixture.candidateBundle)); forgedCandidate.orders[0].classification = "ABSENT_CANDIDATE"; forgedCandidate.orders[0].seenInSweep = true; forgedCandidate.orders[0].reasons = ["ORDER_NOT_ACTIVE"]; freezeTree(forgedCandidate);
    await writeLegacyGraph(candidateFixture.writer, forgedCandidate, generationFixture.generationResult);
    const candidateResult = await reconstructIntegratedEvidence(candidateFixture.writer, SWEEP, PROVENANCE);
    assert.notEqual(candidateResult.status, "VALID");

    const forgedGeneration: any = JSON.parse(JSON.stringify(generationFixture.generationResult)); forgedGeneration.catchUp.rounds = forgedGeneration.catchUp.rounds.slice(0, 1); freezeTree(forgedGeneration);
    await writeLegacyGraph(generationFixture.writer, candidateFixture.candidateBundle, forgedGeneration);
    const generationResult = await reconstructIntegratedEvidence(generationFixture.writer, SWEEP, PROVENANCE);
    assert.notEqual(generationResult.status, "VALID");
  } finally { await rm(candidateFixture.root, { recursive: true, force: true }); await rm(generationFixture.root, { recursive: true, force: true }); }
});

test("candidate advancement eligibility requires the exact canonical reason relationship", async () => {
  const f = await fixture();
  try {
    const canonical: any = JSON.parse(JSON.stringify(f.generationResult));
    assert.equal(validateOfflineGenerationResult(f.generationResult).valid, true);
    const mutations = [
      (value: any) => { value.candidateAdvancement[0].reasons = ["FENCE_BLOCKED"]; },
      (value: any) => { value.candidateAdvancement[0].sourceClassification = "PRESENT"; },
      (value: any) => { value.candidateAdvancement[0].authorityGranted = true; },
      (value: any) => { value.finalFence.outcome = "FENCE_BLOCKED"; value.finalFence.eligible = false; value.finalFence.reasons = ["FENCE_BLOCKED"]; }
    ];
    for (const mutate of mutations) {
      const forged: any = JSON.parse(JSON.stringify(canonical)); mutate(forged); freezeTree(forged);
      assert.equal(validateOfflineGenerationResult(forged).valid, false);
    }
    const forged: any = JSON.parse(JSON.stringify(canonical)); forged.candidateAdvancement[0].reasons = ["FENCE_BLOCKED"]; freezeTree(forged);
    await assert.rejects(() => persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: forged, sourceProvenance: PROVENANCE }), /INVALID_GENERATION_INTEGRATION_INPUT/);
    assert.equal((await f.writer.readGeneration()).status, "INCOMPLETE");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("real UNSAFE output preserves trailing unevaluated rounds and validates", () => {
  const input: any = generation();
  input.maxCatchUpRounds = 2;
  input.catchUpRounds = [...input.catchUpRounds, { roundNumber: 3, observedHighWater: { eventId: "100", receivedAt: END }, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }];
  input.catchUpRounds[0] = { ...input.catchUpRounds[0], pendingCount: 1 };
  const result = evaluateOfflineGeneration(input);
  assert.equal(result.catchUp.outcome, "UNSAFE");
  assert.equal(result.catchUp.roundsEvaluated, 2);
  assert.equal(result.catchUp.rounds.length, 3);
  assert.equal(validateOfflineGenerationResult(result).valid, true);
});

test("candidate top-level orders must retain classifier canonical order", () => {
  const canonical = candidate(["PRESENT", "ABSENT_CANDIDATE"]);
  assert.equal(validateOfflineCandidateBundle(canonical).valid, true);
  const forged: any = JSON.parse(JSON.stringify(canonical)); forged.orders.reverse(); freezeTree(forged);
  assert.equal(validateOfflineCandidateBundle(forged).valid, false);
});

test("targeted eligibility semantic legacy graph is rejected during reconstruction", async () => {
  const f = await fixture();
  try {
    const forged: any = JSON.parse(JSON.stringify(f.generationResult)); forged.candidateAdvancement[0].reasons = ["FENCE_BLOCKED"]; freezeTree(forged);
    await writeLegacyGraph(f.writer, f.candidateBundle, forged);
    const result = await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE);
    assert.equal(result.status, "MISMATCHED");
    assert.deepEqual(result.reasons, ["BARRIER_ENVELOPE_MISMATCH"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("real evaluator corpus remains accepted by the result validator", () => {
  const cases: any[] = [];
  cases.push(generation());
  const partial: any = generation(); partial.transport = { ...partial.transport, transportResult: "PARTIAL", paginationExhausted: false, nextCursor: "more" }; cases.push(partial);
  const unsafe: any = generation(); unsafe.catchUpRounds = unsafe.catchUpRounds.map((round: any, index: number) => index === 0 ? { ...round, pendingCount: 1 } : round); cases.push(unsafe);
  const budget: any = generation(); budget.maxCatchUpRounds = 2; budget.catchUpRounds = [budget.catchUpRounds[0], { ...budget.catchUpRounds[1], observedHighWater: { eventId: "101", receivedAt: END } }, { roundNumber: 3, observedHighWater: { eventId: "102", receivedAt: END }, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }]; cases.push(budget);
  const notStable: any = generation(); notStable.catchUpRounds = [notStable.catchUpRounds[0]]; cases.push(notStable);
  const late: any = generation(); late.catchUpRounds = [{ ...late.catchUpRounds[0], observedHighWater: { eventId: "110", receivedAt: END } }, { ...late.catchUpRounds[1], observedHighWater: { eventId: "111", receivedAt: END } }, { roundNumber: 3, observedHighWater: { eventId: "111", receivedAt: END }, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }]; late.endBarrier = { ...late.endBarrier, eventHighWaterAfter: { eventId: "110", receivedAt: END } }; cases.push(late);
  for (const input of cases) assert.equal(validateOfflineGenerationResult(evaluateOfflineGeneration(input)).valid, true);
});

test("real canonical UNSAFE result persists and reconstructs VALID", async () => {
  const f = await fixture();
  try {
    const input: any = generation(); input.candidateBundle = f.candidateBundle; input.maxCatchUpRounds = 2; input.catchUpRounds = [...input.catchUpRounds, { roundNumber: 3, observedHighWater: { eventId: "100", receivedAt: END }, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }]; input.catchUpRounds[0] = { ...input.catchUpRounds[0], pendingCount: 1 };
    const result = evaluateOfflineGeneration(input);
    assert.equal(result.state, "ABORTED"); assert.equal(result.catchUp.outcome, "UNSAFE"); assert.equal(validateOfflineGenerationResult(result).valid, true);
    await persistIntegratedEvidence(f.writer, { candidateBundle: f.candidateBundle, generationResult: result, sourceProvenance: PROVENANCE });
    assert.equal((await reconstructIntegratedEvidence(f.writer, SWEEP, PROVENANCE)).status, "VALID");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
