import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { runPublishedInitialBaselineAdoptionRecovery } from "../src/runtime/publishedInitialBaselineAdoptionRecovery.js";
import { parsePublishedRecoveryArgs } from "../src/cli/runPublishedInitialBaselineAdoptionRecovery.js";
import { createRecoveryEntryAnchor, createContinuityLossRebaselinePlan, PostgresContinuityLossBaselineAdoptionStore } from "../src/reconciliation/continuityLossRebaseline.js";

function rawListing(token = "7", hashChar = "1"): any { return { order_hash: `0x${hashChar.repeat(64)}`, chain: "gunzilla", protocol_address: `0x${"a".repeat(40)}`, asset: { identifier: token, contract: ACTIVE_LISTINGS_CONTRACT }, remaining_quantity: 1, protocol_data: { parameters: { offerer: `0x${"2".repeat(40)}`, offer: [{ itemType: 2, token: ACTIVE_LISTINGS_CONTRACT, identifierOrCriteria: token, startAmount: "1", endAmount: "1" }], consideration: [{ itemType: 0, token: `0x${"0".repeat(40)}`, identifierOrCriteria: "0", startAmount: "1000000000000000000", endAmount: "1000000000000000000", recipient: `0x${"2".repeat(40)}` }], startTime: "1787323440", endTime: "1789915440", orderType: 0 } }, price: { current: { currency: "GUN", decimals: 18, value: "1000000000000000000" } }, order_created_at: 1787323444, type: "basic", status: "ACTIVE" }; }

async function completeEvidence(count = 1): Promise<any> { const listings = Array.from({ length: count }, (_, i) => rawListing(String(7 + i), String(i + 1))); const client = new ActiveListingsClient({ apiKey: "test", dependencies: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ listings, next: null }) }) as any, sleep: async () => undefined }, policy: { maxPages: 1, maxListings: 10 }, retryPolicy: { maxRetries: 0 } }); return { sourceProvenance: { fixture: "a".repeat(64) }, snapshot: await client.fetchSnapshot("2026-09-01T00:00:00.000Z", { fixture: "a".repeat(64) }) }; }

async function trustedFixture(count = 1) {
  const evidence = await completeEvidence(count);
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
  readonly sql: string[] = []; readonly values: unknown[][] = []; receipt: any = null; publicationRows: any[] | null = null; receiptOverride: any = null; linked: any[] = []; linkedRows: any[] | null = null; localCount = 0; after: any[] = []; failReceiptInsert = false; failListingInsert = false; finalLinkedCountOverride: string | null = null; now = "2026-09-02T00:00:00.000Z";
  constructor(private readonly publication: any) {}
  async query(text: string, values: readonly unknown[] = []): Promise<any> { this.sql.push(text); this.values.push([...values]); if (text === "BEGIN" || text.startsWith("SET LOCAL") || text.startsWith("LOCK TABLE") || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 }; if (text.includes("sequence_key")) return { rows: [{ sequence_key: "targeted-verifier-generation" }], rowCount: 1 }; if (text.includes("initial_baseline_adoptions WHERE adoption_id")) { const r = this.receiptOverride ?? this.receipt; return { rows: r ? [r] : [], rowCount: r ? 1 : 0 }; } if (text.includes("targeted_verifier_generation_publications")) { const rows = this.publicationRows ?? [publicationRow(this.publication)]; return { rows, rowCount: rows.length }; } if (text.includes("count(*)") && text.includes("chain=$1")) return { rows: [{ count: String(this.localCount) }], rowCount: 1 }; if (text.includes("event_id::text,event_type")) return { rows: this.after, rowCount: this.after.length }; if (text.includes("transaction_timestamp")) return { rows: [{ now: this.now }], rowCount: 1 }; if (text.startsWith("INSERT INTO public.opensea_listings_initial")) { if (this.failReceiptInsert) throw new Error("receipt insert failed"); this.receipt = { schema_version: "initial-baseline-adoption-v1", adoption_id: values[1], generation_publication_id: values[2], publication_sequence: values[3], sweep_id: values[4], source_evidence_hash: values[5], snapshot_artifact_hash: values[6], generation_root_hash: values[7], candidate_artifact_hash: values[8], barrier_artifact_hash: values[9], scope: JSON.parse(String(values[10])), scope_fingerprint: values[11], protocol_address: values[12], stable_event_id: values[13], stable_received_at: new Date(String(values[14])), snapshot_started_at: new Date(String(values[15])), snapshot_completed_at: new Date(String(values[16])), expected_order_count: values[17], adopted_order_count: values[18], rows_commitment: values[19], payload: JSON.parse(String(values[20])), adopted_at: new Date(String(values[21])) }; return { rows: [], rowCount: 1 }; } if (text.startsWith("INSERT INTO public.opensea_listings_v2")) { if (this.failListingInsert) throw new Error("listing insert failed"); this.linked.push({ order_hash: values[0], initial_baseline_adoption_id: values[18], protocol_address: values[17], raw_baseline_listing: JSON.parse(String(values[19])) }); return { rows: [], rowCount: 1 }; } if (text.includes("initial_baseline_adoption_id=$1") && text.includes("count(*)")) return { rows: [{ count: this.finalLinkedCountOverride ?? String((this.linkedRows ?? this.linked).length || this.publication.expectedOrderCount || 1) }], rowCount: 1 }; if (text.includes("initial_baseline_adoption_id=$1")) { const rows = this.linkedRows ?? this.linked; return { rows, rowCount: rows.length }; } return { rows: [], rowCount: 0 }; }
  release(): void {}
}
class AdoptionFakePool { constructor(readonly client: AdoptionFakeClient) {} async connect(): Promise<any> { return this.client; } async query(): Promise<any> { return { rows: [], rowCount: 0 }; } async end(): Promise<void> {} }

function replayPayload(type: string, row: any, timestamp: string): any {
  const payload: any = { order_hash: row.orderHash, item: { nft_id: `${row.chain}/${row.contractAddress}/${row.tokenId}`, metadata: {} }, event_timestamp: timestamp, listing_date: timestamp, expiration_date: row.expirationAt, maker: { address: row.sellerAddress }, protocol_data: { parameters: { offerer: row.sellerAddress, offer: [{ token: row.contractAddress, identifierOrCriteria: row.tokenId }] } }, base_price: "1000000000000000000", sale_price: "1000000000000000000", payment_token: { address: "0x" + "0".repeat(40), symbol: "GUN", decimals: 18 } };
  return { event_type: type, version: "1", payload };
}
function transferPayload(row: any, timestamp: string): any { return { event_type: "item_transferred", version: "1", payload: { item: { nft_id: `${row.chain}/${row.contractAddress}/${row.tokenId}` }, event_timestamp: timestamp, transaction: { timestamp, hash: "0x" + "b".repeat(64) }, from_account: { address: "0x" + "1".repeat(40) }, to_account: { address: "0x" + "2".repeat(40) } } }; }
function liveDbRow(row: any, overrides: any = {}): any { return { order_hash: row.orderHash, nft_id: row.nftId, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, collection_slug: row.collectionSlug, seller_address: row.sellerAddress, price_raw: row.priceRaw, price_normalized: row.priceNormalized, payment_token_address: null, payment_token_symbol: row.paymentTokenSymbol, payment_token_decimals: row.paymentTokenDecimals, listing_start_at: row.listingStartAt, expiration_at: row.expirationAt, status: "active", is_active: true, needs_reconciliation: false, reconciliation_reason: null, last_order_event_type: null, last_order_event_timestamp: null, last_order_event_version: null, last_nft_event_timestamp: null, last_nft_event_version: null, last_transfer_transaction_hash: null, item_name: null, image_url: null, permalink: null, source: "stream", last_stream_received_at: null, last_reconciled_at: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", raw_last_event: null, protocol_address: null, initial_baseline_adoption_id: null, raw_baseline_listing: null, ...overrides }; }
class StatefulReplayClient {
  readonly sql: string[] = []; readonly rows = new Map<string, any>(); receipt: any = null; publicationRows: any[] | null = null; after: any[] = []; now = "2026-09-02T00:00:00.000Z"; constructor(readonly publication: any, readonly plan: any, existing: any[] = []) { for (const row of existing) this.rows.set(row.order_hash, row); }
  private full(values: readonly unknown[], baseline: boolean): any {
    if (baseline) { const v2 = values.length === 19; return { order_hash: values[0], nft_id: values[1], chain: values[2], contract_address: values[3], token_id: values[4], collection_slug: values[5], seller_address: values[6], price_raw: values[7], price_normalized: values[8], payment_token_address: values[9], payment_token_symbol: values[10], payment_token_decimals: values[11], listing_start_at: values[12], expiration_at: values[13], status: "active", is_active: true, needs_reconciliation: false, reconciliation_reason: null, last_order_event_type: null, last_order_event_timestamp: null, last_order_event_version: null, last_nft_event_timestamp: null, last_nft_event_version: null, last_transfer_transaction_hash: null, item_name: null, image_url: null, permalink: null, source: values[14], last_stream_received_at: null, last_reconciled_at: null, created_at: values[15], updated_at: values[15], raw_last_event: null, protocol_address: values[v2 ? 16 : 17], initial_baseline_adoption_id: values[v2 ? 17 : 18], raw_baseline_listing: JSON.parse(String(values[v2 ? 18 : 19])) }; }
    const old = this.rows.get(String(values[0])); return { ...old, order_hash: values[0], nft_id: values[1], chain: values[2], contract_address: values[3], token_id: values[4], collection_slug: values[5], seller_address: values[6], price_raw: values[7], price_normalized: values[8], payment_token_address: values[9], payment_token_symbol: values[10], payment_token_decimals: values[11], listing_start_at: values[12], expiration_at: values[13], status: values[14], is_active: values[15], needs_reconciliation: values[16], reconciliation_reason: values[17], last_order_event_type: values[18], last_order_event_timestamp: values[19], last_order_event_version: values[20], last_nft_event_timestamp: values[21], last_nft_event_version: values[22], last_transfer_transaction_hash: values[23], item_name: values[24], image_url: values[25], permalink: values[26], source: values[27], last_stream_received_at: values[28], last_reconciled_at: values[29], created_at: values[30], updated_at: values[31], raw_last_event: JSON.parse(String(values[32])) };
  }
  async query(text: string, values: readonly unknown[] = []): Promise<any> {
    this.sql.push(text);
    if (text === "BEGIN" || text.startsWith("SET LOCAL") || text.startsWith("LOCK TABLE") || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (text.includes("sequence_key")) return { rows: [{ sequence_key: "targeted-verifier-generation" }], rowCount: 1 };
    if (text.includes("initial_baseline_adoptions WHERE adoption_id")) return { rows: this.receipt ? [this.receipt] : [], rowCount: this.receipt ? 1 : 0 };
    if (text.includes("targeted_verifier_generation_publications")) { let rows = this.publicationRows ?? [publicationRow(this.publication)]; if (text.includes("WHERE generation_publication_id=$1")) rows = rows.filter((row: any) => row.generation_publication_id === values[0]); return { rows, rowCount: rows.length }; }
    if (text.includes("transaction_timestamp")) return { rows: [{ now: this.now }], rowCount: 1 };
    if (text.includes("event_id::text,event_type")) return { rows: this.after, rowCount: this.after.length };
    if (text.includes("WHERE order_hash = $1") && text.includes("FOR UPDATE")) return { rows: this.rows.has(String(values[0])) ? [this.rows.get(String(values[0]))] : [], rowCount: this.rows.has(String(values[0])) ? 1 : 0 };
    if (text.includes("WHERE order_hash=$1") && text.includes("FOR UPDATE")) { const row = this.rows.get(String(values[0])); return { rows: row ? [{ order_hash: row.order_hash, nft_id: row.nft_id, chain: row.chain, contract_address: row.contract_address, token_id: row.token_id, collection_slug: row.collection_slug, protocol_address: row.protocol_address ?? null, initial_baseline_adoption_id: row.initial_baseline_adoption_id ?? null, raw_baseline_listing: row.raw_baseline_listing ?? null }] : [], rowCount: row ? 1 : 0 }; }
    if (text.includes("WHERE chain = $1") && text.includes("status = 'active'")) return { rows: [...this.rows.values()].filter((row) => row.chain === values[0] && row.contract_address === values[1] && row.token_id === values[2] && row.status === "active" && row.is_active) };
    if (text.startsWith("INSERT INTO public.opensea_listings_v2")) { const baseline = text.includes("initial_baseline_adoption_id"); const row = this.full(values, baseline); this.rows.set(String(row.order_hash), row); return { rows: [], rowCount: 1 }; }
    if (text.startsWith("UPDATE public.opensea_listings_v2 SET protocol_address")) { const row = this.rows.get(String(values[0])); if (row) Object.assign(row, { protocol_address: values[1], initial_baseline_adoption_id: values[2], raw_baseline_listing: JSON.parse(String(values[3])) }); return { rows: [], rowCount: 1 }; }
    if (text.startsWith("UPDATE public.opensea_listings_v2 SET nft_id=$2")) { const row = this.rows.get(String(values[0])); if (row) Object.assign(row, { nft_id: values[1], chain: values[2], contract_address: values[3], token_id: values[4], collection_slug: values[5], seller_address: values[6], price_raw: values[7], price_normalized: values[8], payment_token_address: values[9], payment_token_symbol: values[10], payment_token_decimals: values[11], listing_start_at: values[12], expiration_at: values[13], status: "active", is_active: true, needs_reconciliation: false, reconciliation_reason: null, last_order_event_type: null, last_order_event_timestamp: null, last_order_event_version: null, last_nft_event_timestamp: null, last_nft_event_version: null, last_transfer_transaction_hash: null, source: values[14], last_reconciled_at: values[15], updated_at: values[15], raw_last_event: null, protocol_address: values[17], initial_baseline_adoption_id: values[18], raw_baseline_listing: JSON.parse(String(values[19])) }); return { rows: [], rowCount: 1 }; }
    if (text.includes("initial_baseline_adoption_id=$1")) { const linked = [...this.rows.values()].filter((row) => row.initial_baseline_adoption_id === values[0]).map((row) => ({ order_hash: row.order_hash, initial_baseline_adoption_id: row.initial_baseline_adoption_id, protocol_address: row.protocol_address, raw_baseline_listing: row.raw_baseline_listing })); return { rows: linked, rowCount: linked.length }; }
    if (text.startsWith("INSERT INTO public.opensea_listings_initial")) { this.receipt = { schema_version: values[0], adoption_id: values[1], generation_publication_id: values[2], publication_sequence: values[3], sweep_id: values[4], source_evidence_hash: values[5], snapshot_artifact_hash: values[6], generation_root_hash: values[7], candidate_artifact_hash: values[8], barrier_artifact_hash: values[9], scope: JSON.parse(String(values[10])), scope_fingerprint: values[11], protocol_address: values[12], stable_event_id: values[13], stable_received_at: new Date(String(values[14])), snapshot_started_at: new Date(String(values[15])), snapshot_completed_at: new Date(String(values[16])), expected_order_count: values[17], adopted_order_count: values[18], rows_commitment: values[19], payload: JSON.parse(String(values[20])), adopted_at: new Date(String(values[21])) }; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  release(): void {}
}
class StatefulReplayPool { constructor(readonly client: StatefulReplayClient) {} async connect(): Promise<any> { return this.client; } async query(text: string, values: readonly unknown[] = []): Promise<any> { return this.client.query(text, values); } }

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

test("root-bound snapshot economic and artifact tampering is rejected by the production plan constructor", async () => {
  const mutations = [
    (e: any) => e.snapshot.listings[0].sellerAddress = "0x" + "3".repeat(40),
    (e: any) => e.snapshot.listings[0].price.raw = "2",
    (e: any) => e.snapshot.listings[0].expirationAt = "2030-01-01T00:00:00.000Z",
    (e: any) => e.snapshot.listings[0].rawListing = { changed: true },
    (e: any) => e.snapshot.rawPages[0].listings[0].asset.identifier = "8",
    (e: any) => e.snapshot.listings[0].tokenId = "8"
  ];
  for (const mutate of mutations) { const fixture = await trustedFixture(); const tampered = structuredClone(fixture.evidence); mutate(tampered); assert.throws(() => createInitialBaselineAdoptionPlan({ evidence: tampered, projection: fixture.projection, integratedEvidence: fixture.integrated, publication: fixture.publication })); await rm(fixture.root, { recursive: true, force: true }); }
  const fixture = await trustedFixture(); const missing = { ...fixture.integrated, manifest: { ...fixture.integrated.manifest!, artifacts: fixture.integrated.manifest!.artifacts.filter((a) => a.artifactId !== "initial-active-listings-snapshot") } } as any; assert.throws(() => createInitialBaselineAdoptionPlan({ evidence: fixture.evidence, projection: fixture.projection, integratedEvidence: missing, publication: fixture.publication })); await rm(fixture.root, { recursive: true, force: true });
  const hashed = await trustedFixture(); const artifacts = hashed.integrated.manifest!.artifacts.map((a) => a.artifactId === "initial-active-listings-snapshot" ? { ...a, contentHash: "f".repeat(64) } : a); const wrongHash = { ...hashed.integrated, manifest: { ...hashed.integrated.manifest!, artifacts } } as any; assert.throws(() => createInitialBaselineAdoptionPlan({ evidence: hashed.evidence, projection: hashed.projection, integratedEvidence: wrongHash, publication: hashed.publication })); await rm(hashed.root, { recursive: true, force: true });
});

test("post-stable null-chain and malformed identity events fail closed while unrelated scope is ignored", async () => {
  const fixture = await trustedFixture();
  const cases = [
    { event_type: "item_listed", chain: null, contract_address: ACTIVE_LISTINGS_CONTRACT, order_hash: fixture.plan.rows[0].orderHash, token_id: null },
    { event_type: "item_transferred", chain: null, contract_address: ACTIVE_LISTINGS_CONTRACT, order_hash: null, token_id: "7" },
    { event_type: "item_listed", chain: "gunzilla", contract_address: ACTIVE_LISTINGS_CONTRACT, order_hash: "bad", token_id: null },
    { event_type: "item_transferred", chain: "gunzilla", contract_address: ACTIVE_LISTINGS_CONTRACT, order_hash: null, token_id: null }
  ];
  for (const row of cases) { const client = new AdoptionFakeClient(fixture.publication); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); client.after = [{ ...row, event_id: "1", processing_status: "applied" }]; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any).adopt(fixture.plan), /INITIAL_BASELINE_POST_STABLE_EVENT_MALFORMED/); assert.ok(client.sql.includes("ROLLBACK")); }
  const unrelated = new AdoptionFakeClient(fixture.publication); unrelated.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); unrelated.after = [{ event_id: "1", event_type: "item_transferred", processing_status: "applied", chain: "ethereum", contract_address: "0x" + "f".repeat(40), order_hash: null, token_id: "7" }]; const result = await new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(unrelated) as any).adopt(fixture.plan); assert.equal(result.outcome, "ADOPTED"); await rm(fixture.root, { recursive: true, force: true });
});

test("adoption store covers the complete order lifecycle and transfer matrix", async () => {
  const lifecycle = ["item_listed", "item_sold", "item_cancelled", "order_invalidate", "order_revalidate"];
  for (const [i, event_type] of lifecycle.entries()) {
    const fixture = await trustedFixture();
    const client = new AdoptionFakeClient(fixture.publication);
    client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString();
    client.after = [{ event_id: "1", event_type, processing_status: ["applied", "ignored_duplicate", "ignored_older"][i % 3], chain: "gunzilla", contract_address: ACTIVE_LISTINGS_CONTRACT, order_hash: fixture.plan.rows[0].orderHash, token_id: null }];
    if (client.after[0].processing_status === "applied") { await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any).adopt(fixture.plan), /INITIAL_BASELINE_REPLAY_NORMALIZATION_FAILED/); assert.ok(client.sql.includes("ROLLBACK")); }
    else { assert.equal((await new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any).adopt(fixture.plan)).outcome, "ADOPTED"); assert.ok(client.sql.includes("COMMIT")); }
    await rm(fixture.root, { recursive: true, force: true });
  }
  const malformed = await trustedFixture();
  const bad = new AdoptionFakeClient(malformed.publication); bad.now = new Date(Date.parse(malformed.plan.snapshotCompletedAt) + 1000).toISOString();
  bad.after = [{ event_id: "1", event_type: "item_listed", processing_status: "applied", chain: "gunzilla", contract_address: ACTIVE_LISTINGS_CONTRACT, order_hash: "0x" + "z".repeat(64), token_id: null }];
  await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(bad) as any).adopt(malformed.plan), /MALFORMED/); await rm(malformed.root, { recursive: true, force: true });
  const matching = await trustedFixture(); const transfer = new AdoptionFakeClient(matching.publication); transfer.now = new Date(Date.parse(matching.plan.snapshotCompletedAt) + 1000).toISOString(); transfer.after = [{ event_id: "1", event_type: "item_transferred", processing_status: "applied", chain: "gunzilla", contract_address: ACTIVE_LISTINGS_CONTRACT, token_id: matching.plan.rows[0].tokenId, order_hash: null }]; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(transfer) as any).adopt(matching.plan), /INITIAL_BASELINE_REPLAY_NORMALIZATION_FAILED/); await rm(matching.root, { recursive: true, force: true });
  const nonmatching = await trustedFixture(); const outside = new AdoptionFakeClient(nonmatching.publication); outside.now = new Date(Date.parse(nonmatching.plan.snapshotCompletedAt) + 1000).toISOString(); outside.after = [{ event_id: "1", event_type: "item_transferred", processing_status: "applied", chain: "gunzilla", contract_address: ACTIVE_LISTINGS_CONTRACT, token_id: "999", order_hash: null }]; const ok = await new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(outside) as any).adopt(nonmatching.plan); assert.equal(ok.outcome, "ADOPTED"); await rm(nonmatching.root, { recursive: true, force: true });
  const differentChain = await trustedFixture(); const dc = new AdoptionFakeClient(differentChain.publication); dc.now = new Date(Date.parse(differentChain.plan.snapshotCompletedAt) + 1000).toISOString(); dc.after = [{ event_id: "1", event_type: "item_transferred", processing_status: "applied", chain: "ethereum", contract_address: ACTIVE_LISTINGS_CONTRACT, token_id: "7", order_hash: null }]; assert.equal((await new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(dc) as any).adopt(differentChain.plan)).outcome, "ADOPTED"); await rm(differentChain.root, { recursive: true, force: true });
  const differentContract = await trustedFixture(); const dct = new AdoptionFakeClient(differentContract.publication); dct.now = new Date(Date.parse(differentContract.plan.snapshotCompletedAt) + 1000).toISOString(); dct.after = [{ event_id: "1", event_type: "item_transferred", processing_status: "applied", chain: "gunzilla", contract_address: "0x" + "f".repeat(40), token_id: "7", order_hash: null }]; assert.equal((await new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(dct) as any).adopt(differentContract.plan)).outcome, "ADOPTED"); await rm(differentContract.root, { recursive: true, force: true });
  const missingToken = await trustedFixture(); const mt = new AdoptionFakeClient(missingToken.publication); mt.now = new Date(Date.parse(missingToken.plan.snapshotCompletedAt) + 1000).toISOString(); mt.after = [{ event_id: "1", event_type: "item_transferred", processing_status: "applied", chain: "gunzilla", contract_address: ACTIVE_LISTINGS_CONTRACT, token_id: null, order_hash: null }]; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(mt) as any).adopt(missingToken.plan), /MALFORMED/); await rm(missingToken.root, { recursive: true, force: true });
});

test("publication, local-state, expiration, and atomic failure controls are executable", async () => {
  const fixture = await trustedFixture();
  const newer = new AdoptionFakeClient(fixture.publication); const newerPublication = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:03:00.000Z" }, 2); newer.publicationRows = [publicationRow(newerPublication)]; newer.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(newer) as any).adopt(fixture.plan), /PUBLICATION_NOT_CURRENT/); assert.ok(newer.sql.includes("ROLLBACK"));
  const conflict = new AdoptionFakeClient(fixture.publication); const p2 = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:03:00.000Z" }, 2); const p3 = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:04:00.000Z" }, 2); conflict.publicationRows = [publicationRow(p2), publicationRow(p3)]; conflict.now = newer.now; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(conflict) as any).adopt(fixture.plan), /PUBLICATION_NOT_CURRENT/);
  const none = new AdoptionFakeClient(fixture.publication); none.publicationRows = []; none.now = newer.now; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(none) as any).adopt(fixture.plan), /PUBLICATION_NOT_CURRENT/);
  const local = new AdoptionFakeClient(fixture.publication); local.localCount = 1; local.now = newer.now; const merged = await new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(local) as any).adopt(fixture.plan); assert.equal(merged.outcome, "ADOPTED"); assert.equal(local.localCount, 1);
  const expired = new AdoptionFakeClient(fixture.publication); expired.now = fixture.plan.rows[0].expirationAt; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(expired) as any).adopt(fixture.plan), /SNAPSHOT_EXPIRED/);
  for (const mode of ["receipt", "listing", "count"] as const) { const c = new AdoptionFakeClient(fixture.publication); c.now = newer.now; if (mode === "receipt") c.failReceiptInsert = true; if (mode === "listing") c.failListingInsert = true; if (mode === "count") c.linkedRows = []; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(c) as any).adopt(fixture.plan)); assert.ok(c.sql.includes("ROLLBACK")); assert.equal(c.sql.includes("COMMIT"), false); }
  await rm(fixture.root, { recursive: true, force: true });
});

test("exact retry accepts PostgreSQL Date timestamps and never rewrites later Stream state", async () => {
  const fixture = await trustedFixture(); const client = new AdoptionFakeClient(fixture.publication); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString();
  const store = new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any); assert.equal((await store.adopt(fixture.plan)).outcome, "ADOPTED");
  const insertsBefore = client.sql.filter((s) => s.startsWith("INSERT INTO public.opensea_listings_v2")).length; const linked = client.linked[0]; linked.status = "sold"; linked.is_active = false; linked.updated_at = new Date(); linked.source = "stream"; client.linkedRows = [linked]; client.receipt = { ...client.receipt, stable_received_at: new Date(client.receipt.stable_received_at), snapshot_started_at: new Date(client.receipt.snapshot_started_at), snapshot_completed_at: new Date(client.receipt.snapshot_completed_at), adopted_at: new Date(client.receipt.adopted_at) };
  const retry = await store.adopt(fixture.plan); assert.equal(retry.outcome, "ALREADY_ADOPTED"); assert.equal(client.sql.filter((s) => s.startsWith("INSERT INTO public.opensea_listings_v2")).length, insertsBefore); assert.equal(client.sql.some((s) => /UPDATE public\.opensea_listings_v2/i.test(s)), false); await rm(fixture.root, { recursive: true, force: true });
});

test("continuity-loss rebaseline resets an existing inactive snapshot member while preserving absent rows", async () => {
  const fixture = await trustedFixture(2);
  const newerPublication = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:03:00.000Z" }, 2);
  const anchor = createRecoveryEntryAnchor({ capturedAt: "2026-09-02T00:00:00.000Z", journalHighWater: { eventId: "10", receivedAt: "2026-09-01T00:02:00.000Z" }, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: fixture.publication.publicationSequence, supersededSweepId: fixture.publication.sweepId, adoptionCount: 0, listingCount: 2, activeListingCount: 0, genericPendingCount: 0, specializedPendingCount: 3, processingCount: 0, failedCount: 0, staleProcessingCount: 0, validProductionIngestionLeaseCount: 0 });
  const plan = createContinuityLossRebaselinePlan({ evidence: fixture.evidence, projection: fixture.projection, integratedEvidence: fixture.integrated, publication: newerPublication, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: fixture.publication.publicationSequence, supersededSweepId: fixture.publication.sweepId, recoveryEntryAnchor: anchor });
  const absent = liveDbRow(fixture.plan.rows[0], { order_hash: "0x" + "e".repeat(64), nft_id: `gunzilla/${ACTIVE_LISTINGS_CONTRACT}/99`, token_id: "99", status: "cancelled", is_active: false });
  const existing = liveDbRow(fixture.plan.rows[0], { status: "sold", is_active: false, last_order_event_timestamp: "2030-01-01T00:00:00.000Z", last_nft_event_timestamp: "2030-01-01T00:00:00.000Z", last_transfer_transaction_hash: "0x" + "f".repeat(64), needs_reconciliation: true });
  const client = new StatefulReplayClient(newerPublication, plan, [absent, existing]); client.publicationRows = [publicationRow(fixture.publication), publicationRow(newerPublication)]; client.now = "2026-09-02T00:00:00.000Z";
  const result = await new PostgresContinuityLossBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(plan);
  assert.equal(result.outcome, "ADOPTED");
  const rebased = client.rows.get(fixture.plan.rows[0].orderHash);
  assert.deepEqual([rebased.status, rebased.is_active, rebased.needs_reconciliation, rebased.last_order_event_timestamp, rebased.last_nft_event_timestamp, rebased.last_transfer_transaction_hash], ["active", true, false, null, null, null]);
  assert.equal(rebased.initial_baseline_adoption_id, plan.adoptionId);
  assert.equal(client.rows.get(absent.order_hash).initial_baseline_adoption_id, null);
  assert.equal(client.receipt.schema_version, "initial-baseline-adoption-v2");
  await rm(fixture.root, { recursive: true, force: true });
});

test("continuity-loss rebaseline replays a real post-snapshot cancel after authoritative reset", async () => {
  const fixture = await trustedFixture();
  const newerPublication = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:03:00.000Z" }, 2);
  const anchor = createRecoveryEntryAnchor({ capturedAt: "2026-09-02T00:00:00.000Z", journalHighWater: { eventId: "10", receivedAt: "2026-09-01T00:02:00.000Z" }, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, adoptionCount: 0, listingCount: 0, activeListingCount: 0, genericPendingCount: 0, specializedPendingCount: 13, processingCount: 0, failedCount: 0, staleProcessingCount: 0, validProductionIngestionLeaseCount: 0 });
  const plan = createContinuityLossRebaselinePlan({ evidence: fixture.evidence, projection: fixture.projection, integratedEvidence: fixture.integrated, publication: newerPublication, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, recoveryEntryAnchor: anchor });
  const client = new StatefulReplayClient(newerPublication, plan); client.publicationRows = [publicationRow(fixture.publication), publicationRow(newerPublication)];
  const row = plan.rows[0]; const eventAt = new Date(Date.parse(plan.snapshotCompletedAt) + 1000).toISOString();
  client.after = [{ event_id: "11", event_type: "item_cancelled", processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_cancelled", row, eventAt), received_at: eventAt }];
  const result = await new PostgresContinuityLossBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(plan);
  const final = client.rows.get(row.orderHash);
  assert.equal(result.outcome, "ADOPTED"); assert.deepEqual([final.status, final.is_active, final.initial_baseline_adoption_id], ["cancelled", false, plan.adoptionId]);
  await rm(fixture.root, { recursive: true, force: true });
});

test("continuity-loss order replay persists reducer state even when ignored", async () => {
  const fixture = await trustedFixture();
  const newerPublication = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:03:00.000Z" }, 2);
  const anchor = createRecoveryEntryAnchor({ capturedAt: "2026-09-02T00:00:00.000Z", journalHighWater: { eventId: "10", receivedAt: "2026-09-01T00:02:00.000Z" }, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, adoptionCount: 0, listingCount: 0, activeListingCount: 0, genericPendingCount: 0, specializedPendingCount: 0, processingCount: 0, failedCount: 0, staleProcessingCount: 0, validProductionIngestionLeaseCount: 0 });
  const plan = createContinuityLossRebaselinePlan({ evidence: fixture.evidence, projection: fixture.projection, integratedEvidence: fixture.integrated, publication: newerPublication, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, recoveryEntryAnchor: anchor });
  const client = new StatefulReplayClient(newerPublication, plan); client.publicationRows = [publicationRow(fixture.publication), publicationRow(newerPublication)];
  const row = plan.rows[0]; const eventAt = new Date(Date.parse(plan.snapshotCompletedAt) + 1000).toISOString();
  client.after = [{ event_id: "11", event_type: "order_revalidate", processing_status: "reconciliation_required", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("order_revalidate", row, eventAt), received_at: eventAt }];
  const result = await new PostgresContinuityLossBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(plan);
  const final = client.rows.get(row.orderHash);
  assert.equal(result.outcome, "ADOPTED");
  assert.deepEqual([final.status, final.is_active, final.needs_reconciliation, final.reconciliation_reason, final.last_order_event_type], ["active", false, true, "order_revalidate_unverified", null]);
  await rm(fixture.root, { recursive: true, force: true });
});

test("continuity-loss terminal conflict persists the ignored reducer state", async () => {
  const fixture = await trustedFixture();
  const newerPublication = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:03:00.000Z" }, 2);
  const anchor = createRecoveryEntryAnchor({ capturedAt: "2026-09-02T00:00:00.000Z", journalHighWater: { eventId: "10", receivedAt: "2026-09-01T00:02:00.000Z" }, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, adoptionCount: 0, listingCount: 0, activeListingCount: 0, genericPendingCount: 0, specializedPendingCount: 0, processingCount: 0, failedCount: 0, staleProcessingCount: 0, validProductionIngestionLeaseCount: 0 });
  const plan = createContinuityLossRebaselinePlan({ evidence: fixture.evidence, projection: fixture.projection, integratedEvidence: fixture.integrated, publication: newerPublication, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, recoveryEntryAnchor: anchor });
  const client = new StatefulReplayClient(newerPublication, plan); client.publicationRows = [publicationRow(fixture.publication), publicationRow(newerPublication)];
  const row = plan.rows[0]; const soldAt = new Date(Date.parse(plan.snapshotCompletedAt) + 1000).toISOString(); const cancelAt = new Date(Date.parse(plan.snapshotCompletedAt) + 2000).toISOString();
  client.after = [
    { event_id: "11", event_type: "item_sold", processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_sold", row, soldAt), received_at: soldAt },
    { event_id: "12", event_type: "item_cancelled", processing_status: "reconciliation_required", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_cancelled", row, cancelAt), received_at: cancelAt }
  ];
  const result = await new PostgresContinuityLossBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(plan);
  const final = client.rows.get(row.orderHash);
  assert.equal(result.outcome, "ADOPTED");
  assert.deepEqual([final.status, final.is_active, final.needs_reconciliation, final.reconciliation_reason, final.last_order_event_type], ["sold", false, true, "terminal_event_conflict", "item_sold"]);
  await rm(fixture.root, { recursive: true, force: true });
});

test("continuity-loss replay rejects normalized order NFT identity conflicts before mutation", async () => {
  const fixture = await trustedFixture();
  const newerPublication = createGenerationPublicationEvidence({ integratedEvidence: fixture.integrated, protocolAddress: fixture.plan.protocolAddress, createdAt: "2026-09-01T00:03:00.000Z" }, 2);
  const anchor = createRecoveryEntryAnchor({ capturedAt: "2026-09-02T00:00:00.000Z", journalHighWater: { eventId: "10", receivedAt: "2026-09-01T00:02:00.000Z" }, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, adoptionCount: 0, listingCount: 0, activeListingCount: 0, genericPendingCount: 0, specializedPendingCount: 0, processingCount: 0, failedCount: 0, staleProcessingCount: 0, validProductionIngestionLeaseCount: 0 });
  const plan = createContinuityLossRebaselinePlan({ evidence: fixture.evidence, projection: fixture.projection, integratedEvidence: fixture.integrated, publication: newerPublication, supersededPublicationId: fixture.publication.generationPublicationId, supersededPublicationSequence: 1, supersededSweepId: fixture.publication.sweepId, recoveryEntryAnchor: anchor });
  const client = new StatefulReplayClient(newerPublication, plan); client.publicationRows = [publicationRow(fixture.publication), publicationRow(newerPublication)];
  const row = plan.rows[0]; const eventAt = new Date(Date.parse(plan.snapshotCompletedAt) + 1000).toISOString(); const payload = replayPayload("item_cancelled", row, eventAt); payload.payload.item.nft_id = `${row.chain}/${row.contractAddress}/999`;
  client.after = [{ event_id: "11", event_type: "item_cancelled", processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: payload, received_at: eventAt }];
  await assert.rejects(() => new PostgresContinuityLossBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(plan), /EVENT_IDENTITY_INVALID/);
  assert.ok(client.sql.includes("ROLLBACK"));
  await rm(fixture.root, { recursive: true, force: true });
});

test("receipt and linked baseline provenance corruption is fail closed", async () => {
  const fields = ["source_evidence_hash", "snapshot_artifact_hash", "scope_fingerprint", "protocol_address", "stable_event_id", "stable_received_at", "generation_root_hash", "candidate_artifact_hash", "barrier_artifact_hash", "rows_commitment", "expected_order_count", "adopted_order_count", "payload"];
  for (const field of fields) { const fixture = await trustedFixture(); const client = new AdoptionFakeClient(fixture.publication); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); const store = new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any); await store.adopt(fixture.plan); const bad = { ...client.receipt }; if (field === "payload") bad.payload = { changed: true }; else if (field.includes("timestamp")) bad[field] = new Date("2026-09-03T00:00:00.000Z"); else if (field.includes("count")) bad[field] = 99; else if (field === "stable_event_id") bad[field] = "9"; else bad[field] = "f".repeat(64); client.receiptOverride = bad; await assert.rejects(() => store.adopt(fixture.plan), /DURABLE_CORRUPTION/); await rm(fixture.root, { recursive: true, force: true }); }
  for (const mutation of [(r: any) => r.protocol_address = "0x" + "b".repeat(40), (r: any) => r.raw_baseline_listing = { changed: true }, (r: any) => r.order_hash = "0x" + "f".repeat(64)]) { const fixture = await trustedFixture(); const client = new AdoptionFakeClient(fixture.publication); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); const store = new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any); await store.adopt(fixture.plan); mutation(client.linked[0]); await assert.rejects(() => store.adopt(fixture.plan), /DURABLE_CORRUPTION/); await rm(fixture.root, { recursive: true, force: true }); }
});

test("trusted plans reject spread, JSON, and content-correct structural clones", async () => {
  const fixture = await trustedFixture(); assert.equal(isTrustedInitialBaselineAdoptionPlan(fixture.plan), true); assert.equal(isTrustedInitialBaselineAdoptionPlan({ ...fixture.plan }), false); assert.equal(isTrustedInitialBaselineAdoptionPlan(JSON.parse(JSON.stringify(fixture.plan))), false); const clone = JSON.parse(JSON.stringify(fixture.plan)); assert.equal(isTrustedInitialBaselineAdoptionPlan(clone), false); await rm(fixture.root, { recursive: true, force: true });
});

test("two-listing root-bound plan adopts the complete immutable linked set", async () => {
  const fixture = await trustedFixture(2);
  assert.equal(fixture.plan.rows.length, 2);
  assert.deepEqual(fixture.plan.rows.map((r: any) => r.orderHash), [...fixture.plan.rows].sort((a: any, b: any) => a.orderHash.localeCompare(b.orderHash)).map((r: any) => r.orderHash));
  const client = new AdoptionFakeClient(fixture.publication); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString();
  const result = await new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any).adopt(fixture.plan);
  assert.equal(result.outcome, "ADOPTED"); assert.equal(client.linked.length, 2);
  await rm(fixture.root, { recursive: true, force: true });
});

test("linked baseline omission and addition are durable corruption", async () => {
  for (const mode of ["missing", "extra"] as const) {
    const fixture = await trustedFixture(); const client = new AdoptionFakeClient(fixture.publication); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); const store = new PostgresInitialBaselineAdoptionStore(new AdoptionFakePool(client) as any); await store.adopt(fixture.plan);
    if (mode === "missing") client.linkedRows = []; else client.linkedRows = [...client.linked, { ...client.linked[0], order_hash: "0x" + "f".repeat(64) }];
    await assert.rejects(() => store.adopt(fixture.plan), /DURABLE_CORRUPTION/); assert.ok(client.sql.includes("ROLLBACK")); await rm(fixture.root, { recursive: true, force: true });
  }
});

test("published-baseline recovery is explicitly bound, evidence-backed, and performs no sweep", async () => {
  const fixture = await trustedFixture();
  const lease = { pid: "42", backendStart: "2026-09-02T00:00:00.000Z", applicationName: "opensea_listings_v2_production_ingestion", database: "server_otg" } as const;
  const queries: string[] = [];
  const pool: any = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("targeted_verifier_generation_publications WHERE generation_publication_id")) return { rows: [publicationRow(fixture.publication)] };
      if (text.includes("targeted_verifier_generation_publications WHERE publication_state='ACCEPTED'")) return { rows: [publicationRow(fixture.publication)] };
      if (text.includes("initial_baseline_adoptions WHERE generation_publication_id")) return { rows: [] };
      if (text.includes("initial_baseline_adoptions WHERE adoption_id")) return { rows: [{ generation_publication_id: fixture.publication.generationPublicationId, sweep_id: fixture.publication.sweepId, expected_order_count: fixture.plan.expectedOrderCount, adopted_order_count: fixture.plan.expectedOrderCount }] };
      if (text.includes("initial_baseline_adoption_id=$1")) return { rows: fixture.plan.rows.map((row: any) => ({ order_hash: row.orderHash, protocol_address: row.protocolAddress, initial_baseline_adoption_id: fixture.plan.adoptionId, raw_baseline_listing: row.rawBaselineListing })) };
      throw new Error(`unexpected query: ${text}`);
    }
  };
  let adopted = 0;
  const result = await runPublishedInitialBaselineAdoptionRecovery({
    pool,
    publicationId: fixture.publication.generationPublicationId,
    sweepId: fixture.publication.sweepId,
    evidenceRoot: fixture.root,
    leaseProbe: async () => lease,
    project: () => fixture.projection,
    reconstruct: async () => fixture.integrated,
    adoptionStore: { adopt: async (plan: any) => { adopted += 1; assert.equal(plan.adoptionId, fixture.plan.adoptionId); return { outcome: "ADOPTED", adoptionId: plan.adoptionId, adoptedOrderCount: plan.expectedOrderCount }; } },
    postAdoptionVerifier: async () => true
  });
  assert.equal(result.status, "VERIFIED_ADOPTED");
  assert.equal(adopted, 1);
  assert.equal(queries.some((query) => /active.?listings|opensea.*events/i.test(query)), false);
  assert.deepEqual(parsePublishedRecoveryArgs([
    "--confirm-production-published-baseline-recovery", "--confirm-no-new-sweep", "--confirm-existing-publication", "--confirm-external-ingestion-running", "--confirm-no-deactivation-authority",
    "--publication-id", fixture.publication.generationPublicationId, "--sweep-id", fixture.publication.sweepId, "--evidence-root", fixture.root
  ]), { publicationId: fixture.publication.generationPublicationId, sweepId: fixture.publication.sweepId, evidenceRoot: fixture.root });
  await rm(fixture.root, { recursive: true, force: true });
});

test("stateful adoption replays real production-shaped order and transfer effects", async () => {
  const types = ["item_listed", "item_cancelled", "item_sold", "order_invalidate", "order_revalidate"];
  for (const type of types) {
    const fixture = await trustedFixture(); const row = fixture.plan.rows[0]; const client = new StatefulReplayClient(fixture.publication, fixture.plan); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); const eventAt = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 2000).toISOString(); client.after = [{ event_id: "1", event_type: type, processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload(type, row, eventAt), received_at: eventAt }];
    const result = await new PostgresInitialBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(fixture.plan); assert.equal(result.outcome, "ADOPTED"); const final = client.rows.get(row.orderHash); assert.equal(final?.protocol_address, row.protocolAddress); assert.equal(final?.initial_baseline_adoption_id, fixture.plan.adoptionId); assert.deepEqual(final?.raw_baseline_listing, row.rawBaselineListing);
    if (type === "item_cancelled") assert.deepEqual([final.status, final.is_active], ["cancelled", false]);
    if (type === "item_sold") assert.deepEqual([final.status, final.is_active], ["sold", false]);
    if (type === "order_invalidate") assert.deepEqual([final.status, final.is_active, final.needs_reconciliation], ["invalidated", false, true]);
    if (type === "order_revalidate") assert.deepEqual([final.is_active, final.needs_reconciliation], [false, true]);
    await rm(fixture.root, { recursive: true, force: true });
  }
  const transferFixture = await trustedFixture(); const transferClient = new StatefulReplayClient(transferFixture.publication, transferFixture.plan); transferClient.now = new Date(Date.parse(transferFixture.plan.snapshotCompletedAt) + 1000).toISOString(); const transferAt = new Date(Date.parse(transferFixture.plan.snapshotCompletedAt) + 2000).toISOString(); const transferRow = transferFixture.plan.rows[0]; transferClient.after = [{ event_id: "1", event_type: "item_transferred", processing_status: "applied", order_hash: null, chain: transferRow.chain, contract_address: transferRow.contractAddress, token_id: transferRow.tokenId, raw_payload: transferPayload(transferRow, transferAt), received_at: transferAt }]; const transferResult = await new PostgresInitialBaselineAdoptionStore(new StatefulReplayPool(transferClient) as any).adopt(transferFixture.plan); assert.equal(transferResult.outcome, "ADOPTED"); const transferred = transferClient.rows.get(transferRow.orderHash); assert.deepEqual([transferred.is_active, transferred.needs_reconciliation, transferred.last_transfer_transaction_hash], [false, true, "0x" + "b".repeat(64)]); assert.equal(transferClient.sql.some((sql) => sql.includes("opensea_listings_nft_state_v2")), false); await rm(transferFixture.root, { recursive: true, force: true });
});

test("stateful replay is ordered, temporally anchored, and rejects unsafe statuses", async () => {
  const fixture = await trustedFixture(); const row = fixture.plan.rows[0]; const client = new StatefulReplayClient(fixture.publication, fixture.plan); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); const after = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 2000).toISOString(); const old = fixture.plan.snapshotCompletedAt; client.after = [{ event_id: "1", event_type: "item_listed", processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_listed", row, after), received_at: after }, { event_id: "2", event_type: "item_cancelled", processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_cancelled", row, after), received_at: after }]; const result = await new PostgresInitialBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(fixture.plan); assert.equal(result.outcome, "ADOPTED"); assert.equal(client.rows.get(row.orderHash).status, "cancelled");
  const delayed = new StatefulReplayClient(fixture.publication, fixture.plan); delayed.now = client.now; delayed.after = [{ event_id: "1", event_type: "item_cancelled", processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_cancelled", row, old), received_at: old }]; assert.equal((await new PostgresInitialBaselineAdoptionStore(new StatefulReplayPool(delayed) as any).adopt(fixture.plan)).outcome, "ADOPTED"); assert.equal(delayed.rows.get(row.orderHash).status, "active");
  for (const status of ["pending", "processing", "failed", "unknown"]) { const unsafe = new StatefulReplayClient(fixture.publication, fixture.plan); unsafe.now = client.now; unsafe.after = [{ event_id: "1", event_type: "item_cancelled", processing_status: status, order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_cancelled", row, after), received_at: after }]; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new StatefulReplayPool(unsafe) as any).adopt(fixture.plan), /INITIAL_BASELINE_POST_STABLE_EVENT_UNSAFE_STATUS/); assert.ok(unsafe.sql.includes("ROLLBACK")); }
  await rm(fixture.root, { recursive: true, force: true });
});

test("stateful merge preserves live rows, rejects identity conflicts, and recovery uses the real pipeline", async () => {
  const fixture = await trustedFixture(2); const unrelated = liveDbRow({ ...fixture.plan.rows[0], orderHash: "0x" + "e".repeat(64), tokenId: "99", nftId: `gunzilla/${ACTIVE_LISTINGS_CONTRACT}/99` }); const existing = liveDbRow(fixture.plan.rows[0], { status: "sold", is_active: false, source: "stream" }); const client = new StatefulReplayClient(fixture.publication, fixture.plan, [unrelated, existing]); client.now = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 1000).toISOString(); const row = fixture.plan.rows[0]; const at = new Date(Date.parse(fixture.plan.snapshotCompletedAt) + 2000).toISOString(); client.after = [{ event_id: "1", event_type: "item_cancelled", processing_status: "applied", order_hash: row.orderHash, chain: row.chain, contract_address: row.contractAddress, token_id: row.tokenId, raw_payload: replayPayload("item_cancelled", row, at), received_at: at }]; const result = await new PostgresInitialBaselineAdoptionStore(new StatefulReplayPool(client) as any).adopt(fixture.plan); assert.equal(result.outcome, "ADOPTED"); assert.equal(client.rows.get(unrelated.order_hash).initial_baseline_adoption_id, null); assert.equal(client.rows.get(existing.order_hash).status, "sold"); assert.equal(client.rows.get(existing.order_hash).initial_baseline_adoption_id, fixture.plan.adoptionId); assert.equal(client.receipt.adopted_order_count, 2);
  const conflict = new StatefulReplayClient(fixture.publication, fixture.plan, [liveDbRow(fixture.plan.rows[0], { token_id: "999" })]); conflict.now = client.now; await assert.rejects(() => new PostgresInitialBaselineAdoptionStore(new StatefulReplayPool(conflict) as any).adopt(fixture.plan), /INITIAL_BASELINE_EXISTING_IDENTITY_CONFLICT/); await rm(fixture.root, { recursive: true, force: true });
  const recoveryFixture = await trustedFixture(); const recoveryClient = new StatefulReplayClient(recoveryFixture.publication, recoveryFixture.plan); recoveryClient.now = new Date(Date.parse(recoveryFixture.plan.snapshotCompletedAt) + 1000).toISOString(); const recoveryPool = new StatefulReplayPool(recoveryClient) as any; const lease = { pid: "7", backendStart: "2026-09-02T00:00:00.000Z", applicationName: "opensea_listings_v2_production_ingestion", database: "server_otg" } as const; const recoveryResult = await runPublishedInitialBaselineAdoptionRecovery({ pool: recoveryPool, publicationId: recoveryFixture.publication.generationPublicationId, sweepId: recoveryFixture.publication.sweepId, evidenceRoot: recoveryFixture.root, leaseProbe: async () => lease }); assert.equal(recoveryResult.status, "VERIFIED_ADOPTED"); assert.equal(recoveryClient.receipt.adoption_id, recoveryFixture.plan.adoptionId); assert.equal(recoveryClient.sql.some((sql) => /active.?listings|fetchSnapshot|targeted_verifier_generation_publications.*INSERT/i.test(sql)), false); await rm(recoveryFixture.root, { recursive: true, force: true });
});

test("already-adopted recovery reports verifier and lease outcomes independently", async () => {
  const fixture = await trustedFixture(); const lease = { pid: "8", backendStart: "2026-09-02T00:00:00.000Z", applicationName: "opensea_listings_v2_production_ingestion", database: "server_otg" } as const;
  for (const [verified, continuity, expectedStatus, expectedReason] of [[true, true, "ALREADY_VERIFIED_ADOPTED", undefined], [false, true, "ADOPTED_WITH_POSTCONDITION_FAILURE", "POST_ADOPTION_DURABLE_VERIFICATION_FAILED"], [true, false, "ADOPTED_WITH_POSTCONDITION_FAILURE", "POST_ADOPTION_INGESTION_CONTINUITY_LOST"], [false, false, "ADOPTED_WITH_POSTCONDITION_FAILURE", "POST_ADOPTION_DURABLE_VERIFICATION_FAILED;POST_ADOPTION_INGESTION_CONTINUITY_LOST"]] as const) {
    const pool: any = { async query(text: string) { if (text.includes("targeted_verifier_generation_publications WHERE generation_publication_id")) return { rows: [publicationRow(fixture.publication)] }; if (text.includes("targeted_verifier_generation_publications WHERE publication_state='ACCEPTED'")) return { rows: [publicationRow(fixture.publication)] }; if (text.includes("initial_baseline_adoptions WHERE generation_publication_id")) return { rows: [{ adoption_id: fixture.plan.adoptionId }] }; throw new Error(`unexpected query: ${text}`); } };
    let leaseCalls = 0; const result = await runPublishedInitialBaselineAdoptionRecovery({ pool, publicationId: fixture.publication.generationPublicationId, sweepId: fixture.publication.sweepId, evidenceRoot: fixture.root, leaseProbe: async () => { leaseCalls += 1; if (!continuity && leaseCalls > 1) throw new Error("lease lost"); return lease; }, postAdoptionVerifier: async () => verified });
    assert.equal(result.status, expectedStatus); assert.equal(result.adoptionCommitted, true); assert.equal(result.postAdoptionVerified, verified); assert.equal(result.ingestionContinuityMaintained, continuity); assert.equal(result.reason, expectedReason);
  }
  await rm(fixture.root, { recursive: true, force: true });
});
