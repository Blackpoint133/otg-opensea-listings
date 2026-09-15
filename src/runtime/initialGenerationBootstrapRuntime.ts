import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256File, ActiveListingsClient, DEFAULT_ACTIVE_LISTINGS_POLICY, type ActiveListingsSnapshotEvidence } from "../activeListings.js";
import type { DbPool } from "../db/types.js";
import { V2_RUNTIME_GUARD_KEY } from "./runtimeGuard.js";
import { PostgresGenerationJournalWindowReader, createGenerationWindowScopeFromInitialProjection, type GenerationWindowObservation, type GenerationWindowStart } from "../reconciliation/generationJournalWindowReader.js";
import { projectInitialGenerationBaseline } from "../reconciliation/initialGenerationBaseline.js";
import { evaluateOfflineGeneration, type OfflineCatchUpRound } from "../reconciliation/offlineGenerationBarrierModel.js";
import { createGenerationEvidenceWriter } from "../reconciliation/evidence/fileEvidenceStore.js";
import { persistIntegratedEvidence, reconstructIntegratedEvidence } from "../reconciliation/evidence/reconciliationEvidenceIntegration.js";
import { createGenerationPublicationEvidence, PostgresGenerationPublicationStore } from "../reconciliation/generationPublication.js";
import { createInitialBaselineAdoptionPlan, isTrustedInitialBaselineAdoptionPlan, PostgresInitialBaselineAdoptionStore } from "../reconciliation/initialBaselineAdoption.js";
import type { GenerationEvidenceWriter } from "../reconciliation/evidence/evidenceTypes.js";
import { persistInitialBaselineSnapshotArtifact } from "../reconciliation/initialBaselineAdoption.js";
import { sha256Canonical } from "../reconciliation/evidence/canonicalEvidence.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PROVENANCE_FILES = [
  "src/activeListings.ts", "src/reconciliation/initialGenerationBaseline.ts", "src/reconciliation/generationJournalWindowReader.ts",
  "src/reconciliation/offlineCandidateModel.ts", "src/reconciliation/offlineGenerationBarrierModel.ts", "src/reconciliation/evidence/fileEvidenceStore.ts",
  "src/reconciliation/evidence/reconciliationEvidenceIntegration.ts", "src/reconciliation/generationPublication.ts", "src/reconciliation/initialBaselineAdoption.ts",
  "src/runtime/initialGenerationBootstrapRuntime.ts", "src/cli/runInitialGenerationBootstrap.ts", "package.json"
] as const;

export type BootstrapStatus = "VERIFIED_ADOPTED" | "PUBLISHED_NOT_ADOPTED";
export interface BootstrapResult { readonly status: BootstrapStatus; readonly sweepId: string; readonly snapshot: { readonly observed: number; readonly normalized: number }; readonly publicationId?: string; readonly adoptionId?: string; readonly reason?: string; }
export interface BootstrapHealthProbe { (): Promise<boolean>; }
export interface BootstrapDependencies {
  readonly pool: DbPool;
  readonly evidenceRoot: string;
  readonly apiKey: string;
  readonly sweepId?: string;
  readonly now?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly hashFile?: (file: string) => Promise<string>;
  readonly sourceFiles?: readonly string[];
  readonly healthProbe?: BootstrapHealthProbe;
  readonly preflight?: () => Promise<void>;
  readonly activeListingsClient?: Pick<ActiveListingsClient, "fetchSnapshot" | "close">;
  readonly activeListingsFactory?: (apiKey: string) => Pick<ActiveListingsClient, "fetchSnapshot" | "close">;
  readonly journalReader?: Pick<PostgresGenerationJournalWindowReader, "captureStart" | "observe">;
  readonly writerFactory?: (root: string, identity: any) => Promise<GenerationEvidenceWriter>;
  readonly reconstruct?: typeof reconstructIntegratedEvidence;
  readonly publicationStore?: Pick<PostgresGenerationPublicationStore, "publish">;
  readonly adoptionStore?: Pick<PostgresInitialBaselineAdoptionStore, "adopt">;
  readonly project?: typeof projectInitialGenerationBaseline;
  readonly scopeFactory?: typeof createGenerationWindowScopeFromInitialProjection;
  readonly persistSnapshotArtifact?: typeof persistInitialBaselineSnapshotArtifact;
  readonly persistIntegrated?: typeof persistIntegratedEvidence;
  readonly evaluate?: typeof evaluateOfflineGeneration;
  readonly planFactory?: typeof createInitialBaselineAdoptionPlan;
  readonly isTrustedPlan?: (value: unknown) => boolean;
}

function fail(code: string): never { throw new Error(code); }
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function completeSnapshot(snapshot: ActiveListingsSnapshotEvidence): void {
  if (snapshot.result !== "COMPLETE" || !snapshot.paginationExhausted || snapshot.nextCursor !== null || snapshot.counters.malformed !== 0 || snapshot.counters.unsupported !== 0 || snapshot.counters.conflicts !== 0 || snapshot.cursorCycleDetected || snapshot.repeatedPageDetected || snapshot.truncatedByPageLimit || snapshot.truncatedByListingLimit || snapshot.warnings.length !== 0 || snapshot.errors.length !== 0) fail("INITIAL_GENERATION_SNAPSHOT_NOT_COMPLETE");
}
function transport(snapshot: ActiveListingsSnapshotEvidence, sourceProvenance: Readonly<Record<string, string>>) {
  return { transportResult: snapshot.result, snapshotStartedAt: snapshot.startedAt, snapshotCompletedAt: snapshot.completedAt, paginationExhausted: snapshot.paginationExhausted, nextCursor: snapshot.nextCursor, truncatedByPageLimit: snapshot.truncatedByPageLimit, truncatedByListingLimit: snapshot.truncatedByListingLimit, malformedCount: snapshot.counters.malformed, unsupportedCount: snapshot.counters.unsupported, conflictCount: snapshot.counters.conflicts, cursorCycleDetected: snapshot.cursorCycleDetected, repeatedPageDetected: snapshot.repeatedPageDetected, warnings: snapshot.warnings, errors: snapshot.errors, sourceProvenance, pageAttempts: snapshot.pageAttempts, pagesFetched: snapshot.pagesFetched, httpAttempts: snapshot.httpAttempts, retryAttempts: snapshot.retryAttempts, rawPagesCount: snapshot.rawPages.length, responseHashesCount: snapshot.responseHashes.length, observedCount: snapshot.counters.observed, normalizedCount: snapshot.counters.normalized, pageAttemptDetailsCount: snapshot.pageAttemptDetails.length, successfulPageAttempts: snapshot.pageAttemptDetails.filter((p) => p.successful).length };
}
async function sourceProvenance(deps: BootstrapDependencies): Promise<Record<string, string>> {
  const files = deps.sourceFiles ?? PROVENANCE_FILES.map((file) => path.resolve(ROOT, file));
  const hash = deps.hashFile ?? sha256File;
  const entries: [string, string][] = [];
  for (const file of files) entries.push([path.relative(ROOT, file).replace(/\\/g, "/"), (await hash(file)).toLowerCase()]);
  if (new Set(entries.map(([file]) => file)).size !== entries.length || entries.some(([, value]) => !/^[0-9a-f]{64}$/.test(value))) fail("INITIAL_GENERATION_PROVENANCE_INVALID");
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
async function defaultPreflight(pool: DbPool): Promise<void> {
  const identity = await pool.query<{ database: string; schema: string }>("SELECT current_database() AS database,current_schema() AS schema");
  if (identity.rows[0]?.database !== "server_otg" || identity.rows[0]?.schema !== "public") fail("WRONG_PRODUCTION_DATABASE");
  const required = await pool.query<{ missing: string | null }>("SELECT string_agg(x.name,',') AS missing FROM (VALUES ('opensea_listings_initial_baseline_adoptions'),('opensea_listings_v2')) x(name) WHERE to_regclass('public.'||x.name) IS NULL");
  if (required.rows[0]?.missing) fail("MIGRATION_009_PREFLIGHT_FAILED");
  const columns = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='opensea_listings_v2' AND column_name IN ('protocol_address','initial_baseline_adoption_id','raw_baseline_listing')");
  if (columns.rows.length !== 3) fail("MIGRATION_009_PREFLIGHT_FAILED");
  const unsafe = await pool.query<{ failed: string; stale: string }>("SELECT count(*) FILTER (WHERE processing_status='failed')::text AS failed,count(*) FILTER (WHERE processing_status='processing' AND processing_started_at IS NOT NULL AND processing_started_at <= now()-interval '15 minutes')::text AS stale FROM public.opensea_listings_events_v2");
  if (Number(unsafe.rows[0]?.failed ?? 0) > 0) fail("INITIAL_GENERATION_FAILED_INBOX_ROWS");
  if (Number(unsafe.rows[0]?.stale ?? 0) > 0) fail("INITIAL_GENERATION_STALE_PROCESSING_ROWS");
  const state = await pool.query<{ listings: string; adoptions: string }>("SELECT (SELECT count(*)::text FROM public.opensea_listings_v2) listings,(SELECT count(*)::text FROM public.opensea_listings_initial_baseline_adoptions) adoptions");
  if (Number(state.rows[0]?.adoptions ?? 0) > 0) fail("INITIAL_BASELINE_ALREADY_ADOPTED");
  if (Number(state.rows[0]?.listings ?? 0) > 0) fail("INITIAL_BASELINE_LOCAL_STATE_NOT_EMPTY");
}
async function defaultHealth(pool: DbPool): Promise<boolean> {
  const active = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='opensea_listings_v2_production_ingestion' LIMIT 1");
  if (active.rows.length !== 1) return false;
  const client = await pool.connect();
  try { const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [V2_RUNTIME_GUARD_KEY]); if (result.rows[0]?.acquired) { await client.query("SELECT pg_advisory_unlock($1::bigint)", [V2_RUNTIME_GUARD_KEY]); return false; } return true; } finally { client.release(); }
}
function assertHealthy(probe: BootstrapHealthProbe): Promise<void> { return probe().then((ok) => { if (!ok) fail("PRODUCTION_INGESTION_CONTINUITY_LOST"); }); }

export async function runInitialGenerationBootstrap(deps: BootstrapDependencies): Promise<BootstrapResult> {
  if (!path.isAbsolute(deps.evidenceRoot)) fail("EVIDENCE_ROOT_MUST_BE_ABSOLUTE");
  if (!deps.apiKey?.trim()) fail("OPENSEA_API_KEY_MISSING");
  const health = deps.healthProbe ?? (() => defaultHealth(deps.pool));
  await (deps.preflight ?? (() => defaultPreflight(deps.pool)))();
  await assertHealthy(health);
  const sweepId = deps.sweepId ?? randomUUID();
  const provenance = await sourceProvenance(deps);
  const startedAt = deps.now?.() ?? new Date().toISOString();
  const reader = deps.journalReader ?? new PostgresGenerationJournalWindowReader(deps.pool);
  const start: GenerationWindowStart = await reader.captureStart();
  const client = deps.activeListingsClient ?? deps.activeListingsFactory?.(deps.apiKey) ?? new ActiveListingsClient({ apiKey: deps.apiKey, policy: DEFAULT_ACTIVE_LISTINGS_POLICY });
  let snapshot: ActiveListingsSnapshotEvidence;
  try { snapshot = await client.fetchSnapshot(startedAt, provenance); } finally { await client.close(); }
  completeSnapshot(snapshot);
  const evidence = { sourceProvenance: provenance, snapshot };
  const projection = (deps.project ?? projectInitialGenerationBaseline)(evidence, { sourceEvidencePath: "active-listings-snapshot.json", sweepId });
  const scope = (deps.scopeFactory ?? createGenerationWindowScopeFromInitialProjection)(projection);
  await assertHealthy(health);
  const endObservation = await reader.observe(start, scope, 0);
  const writer = await (deps.writerFactory ?? ((root, identity) => createGenerationEvidenceWriter(root, identity)))(deps.evidenceRoot, { sweepId, modelVersion: "generation-v2", scope: { chain: "gunzilla", collection: "off-the-grid", contract: snapshot.expectedContract, endpoint: snapshot.endpoint }, snapshotStartedAt: startedAt, sourceProvenance: provenance, policyHash: sha256Canonical(DEFAULT_ACTIVE_LISTINGS_POLICY) });
  await (deps.persistSnapshotArtifact ?? persistInitialBaselineSnapshotArtifact)(writer, evidence);
  const rounds: OfflineCatchUpRound[] = [];
  let observation: GenerationWindowObservation = endObservation;
  const settlingDeadline = Date.now() + 30_000;
  while (observation.round.pendingCount > 0 || observation.round.processingCount > 0) { if (observation.round.failedCount > 0 || observation.round.reconciliationRequiredCount > 0 || observation.round.unknownStatusCount > 0 || Date.now() >= settlingDeadline) fail("INITIAL_GENERATION_SETTLING_FAILED"); await (deps.sleep ?? wait)(250); observation = await reader.observe(start, scope, 0); }
  if (observation.round.failedCount > 0 || observation.round.reconciliationRequiredCount > 0 || observation.round.unknownStatusCount > 0) fail("INITIAL_GENERATION_UNSAFE_SETTLING");
  const endBarrier = { snapshotCompletedAt: snapshot.completedAt, eventHighWaterAfter: endObservation.observedHighWater };
  let roundNumber = 1; let previousHigh: string | null = null; let stable = false; const maxRounds = 10;
  while (roundNumber <= maxRounds) { observation = await reader.observe(start, scope, roundNumber); rounds.push(observation.round); if (observation.round.failedCount || observation.round.reconciliationRequiredCount || observation.round.unknownStatusCount || observation.round.pendingCount || observation.round.processingCount) fail("INITIAL_GENERATION_OFFICIAL_ROUND_UNSAFE"); if (previousHigh === observation.observedHighWater.eventId) { stable = true; break; } previousHigh = observation.observedHighWater.eventId; roundNumber += 1; }
  if (!stable) fail("INITIAL_GENERATION_CATCH_UP_BUDGET_EXHAUSTED");
  const generation = (deps.evaluate ?? evaluateOfflineGeneration)({ sweepId, initialState: "OPEN", snapshotStartedAt: startedAt, snapshotCompletedAt: snapshot.completedAt, sourceProvenance: provenance, startBarrier: { sweepId, snapshotStartedAt: startedAt, eventHighWaterBefore: start.eventHighWaterBefore }, endBarrier, transport: transport(snapshot, provenance), catchUpRounds: rounds, maxCatchUpRounds: maxRounds, candidateBundle: projection.candidateBundle });
  if (generation.state !== "VERIFIED" || generation.catchUp.outcome !== "STABLE" || !generation.catchUp.stable || generation.finalFence.outcome !== "FENCE_ELIGIBLE" || !generation.finalFence.eligible || generation.deactivationAuthorityGranted !== false) fail("GENERATION_NOT_VERIFIED");
  await writer.writeArtifact({ artifactType: "seen-orders", artifactId: "seen-orders", relativePath: "seen-orders.jsonl", payload: projection.evidence.seenOrders });
  await writer.writeArtifact({ artifactType: "catchup-rounds", artifactId: "catchup-rounds", relativePath: "catchup-rounds.jsonl", payload: rounds.map((r) => ({ sweepId, roundNumber: r.roundNumber, eventId: r.observedHighWater.eventId, receivedAt: r.observedHighWater.receivedAt, pendingCount: r.pendingCount, processingCount: r.processingCount, failedCount: r.failedCount, reconciliationRequiredCount: r.reconciliationRequiredCount, unknownCount: r.unknownStatusCount, observationProvenance: provenance })) });
  await (deps.persistIntegrated ?? persistIntegratedEvidence)(writer, { candidateBundle: projection.candidateBundle, generationResult: generation, sourceProvenance: provenance });
  const reconstructed = await (deps.reconstruct ?? reconstructIntegratedEvidence)(writer, sweepId, provenance);
  if (reconstructed.status !== "VALID") fail("GENERATION_EVIDENCE_RECONSTRUCTION_FAILED");
  await assertHealthy(health);
  const publication = await (deps.publicationStore ?? new PostgresGenerationPublicationStore(deps.pool)).publish({ integratedEvidence: reconstructed, protocolAddress: projection.protocolAddress, createdAt: deps.now?.() ?? new Date().toISOString() });
  if (publication.publicationState !== "ACCEPTED") fail("GENERATION_PUBLICATION_NOT_ACCEPTED");
  const plan = (deps.planFactory ?? createInitialBaselineAdoptionPlan)({ evidence, projection, integratedEvidence: reconstructed, publication });
  if (!(deps.isTrustedPlan ?? isTrustedInitialBaselineAdoptionPlan)(plan)) fail("INITIAL_BASELINE_PLAN_UNTRUSTED");
  await assertHealthy(health);
  try {
    const adoption = await (deps.adoptionStore ?? new PostgresInitialBaselineAdoptionStore(deps.pool)).adopt(plan);
    await assertHealthy(health);
    return { status: adoption.outcome === "ADOPTED" || adoption.outcome === "ALREADY_ADOPTED" ? "VERIFIED_ADOPTED" : "PUBLISHED_NOT_ADOPTED", sweepId, snapshot: { observed: snapshot.counters.observed, normalized: snapshot.counters.normalized }, publicationId: publication.generationPublicationId, adoptionId: adoption.adoptionId };
  } catch (error) {
    return { status: "PUBLISHED_NOT_ADOPTED", sweepId, snapshot: { observed: snapshot.counters.observed, normalized: snapshot.counters.normalized }, publicationId: publication.generationPublicationId, reason: error instanceof Error ? error.message : String(error) };
  }
}
