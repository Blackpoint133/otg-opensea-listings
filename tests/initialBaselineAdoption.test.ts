import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isTrustedInitialBaselineAdoptionPlan } from "../src/reconciliation/initialBaselineAdoption.js";
import { persistInitialBaselineSnapshotArtifact } from "../src/reconciliation/initialBaselineAdoption.js";
import { createInitialBaselineAdoptionPlan, isTrustedInitialBaselineAdoptionPlan, PostgresInitialBaselineAdoptionStore } from "../src/reconciliation/initialBaselineAdoption.js";
import { ActiveListingsClient, ACTIVE_LISTINGS_CONTRACT } from "../src/activeListings.js";
import { projectInitialGenerationBaseline } from "../src/reconciliation/initialGenerationBaseline.js";
import { createGenerationEvidenceWriter } from "../src/reconciliation/evidence/fileEvidenceStore.js";
import { persistIntegratedEvidence, reconstructIntegratedEvidence } from "../src/reconciliation/evidence/reconciliationEvidenceIntegration.js";
import { evaluateOfflineGeneration } from "../src/reconciliation/offlineGenerationBarrierModel.js";
import { createGenerationPublicationEvidence } from "../src/reconciliation/generationPublication.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sha256Canonical } from "../src/reconciliation/evidence/canonicalEvidence.js";

function rawListing(): any { return { order_hash: `0x${"1".repeat(64)}`, chain: "gunzilla", protocol_address: `0x${"a".repeat(40)}`, asset: { identifier: "7", contract: ACTIVE_LISTINGS_CONTRACT }, remaining_quantity: 1, protocol_data: { parameters: { offerer: `0x${"2".repeat(40)}`, offer: [{ itemType: 2, token: ACTIVE_LISTINGS_CONTRACT, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }], consideration: [{ itemType: 0, token: `0x${"0".repeat(40)}`, identifierOrCriteria: "0", startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: `0x${"2".repeat(40)}` }], startTime: "1787323440", endTime: "1789915440", orderType: 0 } }, price: { current: { currency: "GUN", decimals: 18, value: "1000000000000000000" } }, order_created_at: 1787323444, type: "basic", status: "ACTIVE" }; }

async function completeEvidence(): Promise<any> { const client = new ActiveListingsClient({ apiKey: "test", dependencies: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ listings: [rawListing()], next: null }) }) as any, sleep: async () => undefined }, policy: { maxPages: 1, maxListings: 10 }, retryPolicy: { maxRetries: 0 } }); return { sourceProvenance: { fixture: "a".repeat(64) }, snapshot: await client.fetchSnapshot("2026-09-01T00:00:00.000Z", { fixture: "a".repeat(64) }) }; }

async function trustedFixture() {
  const evidence = await completeEvidence();
  const projection = projectInitialGenerationBaseline(evidence, { sourceEvidencePath: "fixture", sweepId: "123e4567-e89b-12d3-a456-426614174000" });
  const root = await mkdtemp(`${tmpdir()}\\adoption-`);
  const writer = await createGenerationEvidenceWriter(root, { sweepId: "123e4567-e89b-12d3-a456-426614174000", modelVersion: "generation-v2", scope: { chain: "gunzilla", collection: "off-the-grid", contract: ACTIVE_LISTINGS_CONTRACT, endpoint: "https://api.opensea.io/api/v2/listings/collection/off-the-grid/all" }, snapshotStartedAt: "2026-09-01T00:00:00.000Z", sourceProvenance: { fixture: "a".repeat(64) }, policyHash: "b".repeat(64) });
  await persistInitialBaselineSnapshotArtifact(writer, evidence);
  const w = projection.localOrders[0].identity;
  const watermark = { eventId: "0", receivedAt: "2026-09-01T00:01:00.000Z" };
  const generation = evaluateOfflineGeneration({ sweepId: projection.evidence.manifest.sweepId, snapshotStartedAt: projection.evidence.manifest.snapshotStartedAt, snapshotCompletedAt: projection.evidence.manifest.snapshotCompletedAt, sourceProvenance: { fixture: "a".repeat(64) }, startBarrier: { sweepId: projection.evidence.manifest.sweepId, snapshotStartedAt: projection.evidence.manifest.snapshotStartedAt, eventHighWaterBefore: watermark }, endBarrier: { snapshotCompletedAt: projection.evidence.manifest.snapshotCompletedAt, eventHighWaterAfter: watermark }, transport: { transportResult: "COMPLETE", snapshotStartedAt: projection.evidence.manifest.snapshotStartedAt, snapshotCompletedAt: projection.evidence.manifest.snapshotCompletedAt, paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, warnings: [], errors: [], sourceProvenance: { fixture: "a".repeat(64) }, pageAttempts: 1, pagesFetched: 1, httpAttempts: 1, retryAttempts: 0, rawPagesCount: 1, responseHashesCount: 1, observedCount: 1, normalizedCount: 1, pageAttemptDetailsCount: 1, successfulPageAttempts: 1 }, catchUpRounds: [{ roundNumber: 1, observedHighWater: watermark, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }, { roundNumber: 2, observedHighWater: watermark, pendingCount: 0, processingCount: 0, failedCount: 0, reconciliationRequiredCount: 0, unknownStatusCount: 0 }], maxCatchUpRounds: 2, candidateBundle: projection.candidateBundle });
  await persistIntegratedEvidence(writer, { candidateBundle: projection.candidateBundle, generationResult: generation, sourceProvenance: { fixture: "a".repeat(64) } });
  const integrated = await reconstructIntegratedEvidence(writer, projection.evidence.manifest.sweepId, { fixture: "a".repeat(64) });
  const publication = createGenerationPublicationEvidence({ integratedEvidence: integrated, protocolAddress: w.protocolAddress, createdAt: "2026-09-01T00:02:00.000Z" }, 1);
  const plan = createInitialBaselineAdoptionPlan({ evidence, projection, integratedEvidence: integrated, publication });
  return { evidence, projection, integrated, publication, plan, root };
}

function publicationRow(p: any): any { return { generation_publication_id: p.generationPublicationId, generation_commitment_id: p.generationCommitmentId, publication_sequence: p.publicationSequence, publication_state: p.publicationState, sweep_id: p.sweepId, generation_root_hash: p.generationRootHash, candidate_artifact_hash: p.candidateArtifactHash, barrier_artifact_hash: p.barrierArtifactHash, candidate_model_version: p.candidateModelVersion, generation_model_version: p.generationModelVersion, verifier_schema_version: p.verifierSchemaVersion, verifier_policy_version: p.verifierPolicyVersion, provider_contract_version: p.providerContractVersion, normalizer_version: p.normalizerVersion, scope: p.scope, payload: p, source_evidence_hash: p.sourceEvidenceHash, created_at: p.createdAt }; }
class AdoptionFakeClient {
  readonly sql: string[] = []; readonly values: unknown[][] = []; receipt: any = null; linked: any[] = []; localCount = 0; after: any[] = []; failInsert = false; countOverride: string | null = null; now = "2026-09-02T00:00:00.000Z";
  constructor(private readonly publication: any) {}
  async query(text: string, values: readonly unknown[] = []): Promise<any> { this.sql.push(text); this.values.push([...values]); if (text === "BEGIN" || text.startsWith("SET LOCAL") || text.startsWith("LOCK TABLE") || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 }; if (text.includes("sequence_key")) return { rows: [{ sequence_key: "targeted-verifier-generation" }], rowCount: 1 }; if (text.includes("initial_baseline_adoptions WHERE adoption_id")) return { rows: this.receipt ? [this.receipt] : [], rowCount: this.receipt ? 1 : 0 }; if (text.includes("targeted_verifier_generation_publications")) return { rows: [publicationRow(this.publication)], rowCount: 1 }; if (text.includes("count(*)") && text.includes("chain=$1")) return { rows: [{ count: String(this.localCount) }], rowCount: 1 }; if (text.includes("event_id::text,event_type")) return { rows: this.after, rowCount: this.after.length }; if (text.includes("transaction_timestamp")) return { rows: [{ now: this.now }], rowCount: 1 }; if (text.startsWith("INSERT INTO public.opensea_listings_initial")) { if (this.failInsert) throw new Error("receipt insert failed"); this.receipt = { schema_version: "initial-baseline-adoption-v1", adoption_id: values[1], generation_publication_id: values[2], publication_sequence: values[3], sweep_id: values[4], source_evidence_hash: values[5], snapshot_artifact_hash: values[6], generation_root_hash: values[7], candidate_artifact_hash: values[8], barrier_artifact_hash: values[9], scope: JSON.parse(String(values[10])), scope_fingerprint: values[11], protocol_address: values[12], stable_event_id: values[13], stable_received_at: new Date(String(values[14])), snapshot_started_at: new Date(String(values[15])), snapshot_completed_at: new Date(String(values[16])), expected_order_count: values[17], adopted_order_count: values[18], rows_commitment: values[19], payload: JSON.parse(String(values[20])), adopted_at: new Date(String(values[21])) }; return { rows: [], rowCount: 1 }; } if (text.startsWith("INSERT INTO public.opensea_listings_v2")) { if (this.failInsert) throw new Error("listing insert failed"); this.linked.push({ order_hash: values[0], initial_baseline_adoption_id: values[18], protocol_address: values[17], raw_baseline_listing: JSON.parse(String(values[19])) }); return { rows: [], rowCount: 1 }; } if (text.includes("initial_baseline_adoption_id=$1") && text.includes("count(*)")) return { rows: [{ count: this.countOverride ?? String(this.linked.length || this.publication.expectedOrderCount || 1) }], rowCount: 1 }; if (text.includes("initial_baseline_adoption_id=$1")) return { rows: this.linked, rowCount: this.linked.length }; return { rows: [], rowCount: 0 }; }
  release(): void {}
}
class AdoptionFakePool { constructor(readonly client: AdoptionFakeClient) {} async connect(): Promise<any> { return this.client; } async query(): Promise<any> { return { rows: [], rowCount: 0 }; } async end(): Promise<void> {} }

test("initial baseline adoption migration declares immutable provenance and constraints", async () => {
  const sql = await readFile(join(process.cwd(), "sql", "009_add_initial_baseline_adoption.sql"), "utf8");
  assert.match(sql, /CREATE TABLE public\.opensea_listings_initial_baseline_adoptions/);
  assert.match(sql, /UNIQUE \(generation_publication_id\)/);
  assert.match(sql, /REFERENCES public\.targeted_verifier_generation_publications/);
  assert.match(sql, /ADD COLUMN protocol_address text NULL/);
  assert.match(sql, /ADD COLUMN initial_baseline_adoption_id text NULL/);
  assert.match(sql, /ADD COLUMN raw_baseline_listing jsonb NULL/);
  assert.match(sql, /snapshot_artifact_hash text NOT NULL/);
  assert.match(sql, /snapshot_artifact_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test("structural adoption plans are never trusted", () => {
  const forged = { schemaVersion: "initial-baseline-adoption-v1", adoptionId: "a" };
  assert.equal(isTrustedInitialBaselineAdoptionPlan(forged), false);
  assert.equal(isTrustedInitialBaselineAdoptionPlan({ ...forged }), false);
  assert.equal(isTrustedInitialBaselineAdoptionPlan(JSON.parse(JSON.stringify(forged))), false);
});

test("complete snapshot is persisted through the accepted evidence writer artifact contract", async () => {
  const evidence = await completeEvidence();
  const calls: any[] = [];
  const writer: any = { writeArtifact: async (input: any) => { calls.push(input); return { artifactType: input.artifactType, artifactId: input.artifactId, relativePath: input.relativePath, schemaVersion: input.schemaVersion, sweepId: "sweep", contentHash: "" }; } };
  const { sha256Canonical } = await import("../src/reconciliation/evidence/canonicalEvidence.js");
  writer.writeArtifact = async (input: any) => { calls.push(input); return { ...input, sweepId: "sweep", contentHash: sha256Canonical(input.payload) }; };
  const result = await persistInitialBaselineSnapshotArtifact(writer, evidence);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].artifactType, "transport");
  assert.equal(calls[0].artifactId, "initial-active-listings-snapshot");
  assert.equal(calls[0].relativePath, "initial-active-listings-snapshot.json");
  assert.equal(result.contentHash, sha256Canonical(evidence));
});

test("real projection, evidence reconstruction, publication and plan construction form a trusted root-bound plan", async () => {
  const fixture = await trustedFixture();
  assert.equal(isTrustedInitialBaselineAdoptionPlan(fixture.plan), true);
  assert.equal(fixture.plan.snapshotArtifactHash.length, 64);
  assert.equal(fixture.plan.rowsCommitment.length, 64);
  assert.equal(fixture.plan.adoptionId.length, 64);
  await rm(fixture.root, { recursive: true, force: true });
});

test("production adoption store executes the lock/fence/receipt/listing transaction atomically", async () => {
  const fixture = await trustedFixture();
  const client = new AdoptionFakeClient(fixture.publication);
  client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString();
  const pool: any = new AdoptionFakePool(client);
  const result = await new PostgresInitialBaselineAdoptionStore(pool).adopt(fixture.plan);
  assert.equal(result.outcome, "ADOPTED");
  const lockJournal = client.sql.findIndex((s) => s.includes("LOCK TABLE public.opensea_listings_events_v2"));
  const lockListings = client.sql.findIndex((s) => s.includes("LOCK TABLE public.opensea_listings_v2"));
  assert.ok(lockJournal >= 0 && lockListings > lockJournal);
  assert.ok(client.sql.includes("COMMIT"));
  assert.equal(client.sql.some((s) => /INSERT INTO public\.opensea_listings_events_v2|UPDATE public\.opensea_listings_events_v2|DELETE FROM public\.opensea_listings_events_v2|opensea_listings_nft_state_v2|ON CONFLICT DO UPDATE/i.test(s)), false);
  await rm(fixture.root, { recursive: true, force: true });
});
