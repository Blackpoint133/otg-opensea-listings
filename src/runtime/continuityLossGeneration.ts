import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256File, ActiveListingsClient, DEFAULT_ACTIVE_LISTINGS_POLICY, type ActiveListingsSnapshotEvidence } from "../activeListings.js";
import type { DbPool } from "../db/types.js";
import { PostgresGenerationJournalWindowReader, createGenerationWindowScopeFromInitialProjection, type GenerationWindowObservation } from "../reconciliation/generationJournalWindowReader.js";
import { projectInitialGenerationBaseline } from "../reconciliation/initialGenerationBaseline.js";
import { evaluateOfflineGeneration, type OfflineCatchUpRound } from "../reconciliation/offlineGenerationBarrierModel.js";
import { createGenerationEvidenceWriter } from "../reconciliation/evidence/fileEvidenceStore.js";
import { persistIntegratedEvidence, reconstructIntegratedEvidence } from "../reconciliation/evidence/reconciliationEvidenceIntegration.js";
import { PostgresGenerationPublicationStore } from "../reconciliation/generationPublication.js";
import { persistInitialBaselineSnapshotArtifact } from "../reconciliation/initialBaselineAdoption.js";
import { sha256Canonical } from "../reconciliation/evidence/canonicalEvidence.js";
import type { RebaselineGenerationOutput } from "./continuityLossRebaselineRuntime.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SOURCE_FILES = [
  "src/activeListings.ts", "src/reconciliation/initialGenerationBaseline.ts", "src/reconciliation/generationJournalWindowReader.ts",
  "src/reconciliation/offlineCandidateModel.ts", "src/reconciliation/offlineGenerationBarrierModel.ts", "src/reconciliation/evidence/fileEvidenceStore.ts",
  "src/reconciliation/evidence/reconciliationEvidenceIntegration.ts", "src/reconciliation/generationPublication.ts", "src/reconciliation/initialBaselineAdoption.ts",
  "src/reconciliation/continuityLossRebaseline.ts", "src/runtime/continuityLossRebaselineRuntime.ts", "src/runtime/continuityLossGeneration.ts", "src/cli/runContinuityLossRebaseline.ts", "package.json"
];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function complete(snapshot: ActiveListingsSnapshotEvidence): void { if (snapshot.result !== "COMPLETE" || !snapshot.paginationExhausted || snapshot.nextCursor !== null || snapshot.warnings.length || snapshot.errors.length || snapshot.counters.malformed || snapshot.counters.unsupported || snapshot.counters.conflicts || snapshot.cursorCycleDetected || snapshot.repeatedPageDetected || snapshot.truncatedByPageLimit || snapshot.truncatedByListingLimit) throw new Error("CONTINUITY_LOSS_REBASELINE_SNAPSHOT_NOT_COMPLETE"); }
export async function runContinuityLossGeneration(input: { pool: DbPool; apiKey: string; evidenceRoot: string; leaseProbe: () => Promise<any>; expectedLease?: { pid: string; backendStart: string; applicationName: string; database: string }; activeListingsFactory?: (apiKey: string) => Pick<ActiveListingsClient, "fetchSnapshot" | "close">; now?: () => string }): Promise<RebaselineGenerationOutput> {
  const provenance: Record<string, string> = {};
  for (const file of SOURCE_FILES) provenance[file] = (await sha256File(path.resolve(ROOT, file))).toLowerCase();
  const reader = new PostgresGenerationJournalWindowReader(input.pool);
  const start = await reader.captureStart();
  const startedAt = input.now?.() ?? new Date().toISOString();
  const client = input.activeListingsFactory?.(input.apiKey) ?? new ActiveListingsClient({ apiKey: input.apiKey, policy: DEFAULT_ACTIVE_LISTINGS_POLICY });
  let snapshot: ActiveListingsSnapshotEvidence; try { snapshot = await client.fetchSnapshot(startedAt, provenance); } finally { await client.close(); }
  complete(snapshot);
  const sweepId = randomUUID();
  const evidence = { sourceProvenance: provenance, snapshot };
  const projection = projectInitialGenerationBaseline(evidence, { sourceEvidencePath: "active-listings-snapshot.json", sweepId });
  const scope = createGenerationWindowScopeFromInitialProjection(projection);
  const endObservation = await reader.observe(start, scope, 0);
  const writer = await createGenerationEvidenceWriter(input.evidenceRoot, { sweepId, modelVersion: "generation-v2", scope: { chain: "gunzilla", collection: "off-the-grid", contract: snapshot.expectedContract, endpoint: snapshot.endpoint }, snapshotStartedAt: startedAt, sourceProvenance: provenance, policyHash: sha256Canonical(DEFAULT_ACTIVE_LISTINGS_POLICY) });
  await persistInitialBaselineSnapshotArtifact(writer, evidence);
  const rounds: OfflineCatchUpRound[] = []; let observation: GenerationWindowObservation = endObservation; let previous: string | null = null; let stable = false;
  for (let n = 1; n <= 10; n += 1) { observation = await reader.observe(start, scope, n); rounds.push(observation.round); if (observation.round.failedCount || observation.round.reconciliationRequiredCount || observation.round.unknownStatusCount || observation.round.pendingCount || observation.round.processingCount) throw new Error("CONTINUITY_LOSS_REBASELINE_GENERATION_UNSAFE"); if (previous === observation.observedHighWater.eventId) { stable = true; break; } previous = observation.observedHighWater.eventId; }
  if (!stable) throw new Error("CONTINUITY_LOSS_REBASELINE_GENERATION_UNSTABLE");
  const generation = evaluateOfflineGeneration({ sweepId, initialState: "OPEN", snapshotStartedAt: startedAt, snapshotCompletedAt: snapshot.completedAt, sourceProvenance: provenance, startBarrier: { sweepId, snapshotStartedAt: startedAt, eventHighWaterBefore: start.eventHighWaterBefore }, endBarrier: { snapshotCompletedAt: snapshot.completedAt, eventHighWaterAfter: endObservation.observedHighWater }, transport: { transportResult: snapshot.result, snapshotStartedAt: snapshot.startedAt, snapshotCompletedAt: snapshot.completedAt, paginationExhausted: snapshot.paginationExhausted, nextCursor: snapshot.nextCursor, truncatedByPageLimit: snapshot.truncatedByPageLimit, truncatedByListingLimit: snapshot.truncatedByListingLimit, malformedCount: snapshot.counters.malformed, unsupportedCount: snapshot.counters.unsupported, conflictCount: snapshot.counters.conflicts, cursorCycleDetected: snapshot.cursorCycleDetected, repeatedPageDetected: snapshot.repeatedPageDetected, warnings: snapshot.warnings, errors: snapshot.errors, sourceProvenance: provenance, pageAttempts: snapshot.pageAttempts, pagesFetched: snapshot.pagesFetched, httpAttempts: snapshot.httpAttempts, retryAttempts: snapshot.retryAttempts, rawPagesCount: snapshot.rawPages.length, responseHashesCount: snapshot.responseHashes.length, observedCount: snapshot.counters.observed, normalizedCount: snapshot.counters.normalized, pageAttemptDetailsCount: snapshot.pageAttemptDetails.length, successfulPageAttempts: snapshot.pageAttemptDetails.filter((p) => p.successful).length }, catchUpRounds: rounds, maxCatchUpRounds: 10, candidateBundle: projection.candidateBundle });
  if (generation.state !== "VERIFIED" || generation.deactivationAuthorityGranted !== false) throw new Error("CONTINUITY_LOSS_REBASELINE_GENERATION_NOT_VERIFIED");
  await writer.writeArtifact({ artifactType: "seen-orders", artifactId: "seen-orders", relativePath: "seen-orders.jsonl", payload: projection.evidence.seenOrders });
  await writer.writeArtifact({ artifactType: "catchup-rounds", artifactId: "catchup-rounds", relativePath: "catchup-rounds.jsonl", payload: rounds });
  await persistIntegratedEvidence(writer, { candidateBundle: projection.candidateBundle, generationResult: generation, sourceProvenance: provenance });
  const integratedEvidence = await reconstructIntegratedEvidence(writer, sweepId, provenance); if (integratedEvidence.status !== "VALID") throw new Error("CONTINUITY_LOSS_REBASELINE_EVIDENCE_INVALID");
  const lease = await input.leaseProbe(); if (!lease || (input.expectedLease && (lease.pid !== input.expectedLease.pid || lease.backendStart !== input.expectedLease.backendStart || lease.applicationName !== input.expectedLease.applicationName || lease.database !== input.expectedLease.database))) throw new Error("CONTINUITY_LOSS_REBASELINE_LEASE_LOST_BEFORE_PUBLICATION");
  const publication = await new PostgresGenerationPublicationStore(input.pool).publish({ integratedEvidence, protocolAddress: projection.protocolAddress, createdAt: input.now?.() ?? new Date().toISOString() });
  if (publication.publicationState !== "ACCEPTED") throw new Error("CONTINUITY_LOSS_REBASELINE_PUBLICATION_NOT_ACCEPTED");
  return { evidence, projection, integratedEvidence, publication };
}
