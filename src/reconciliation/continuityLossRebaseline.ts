import type { DbPool, TransactionClient } from "../db/types.js";
import { normalizeStoredRawEvent } from "../db/pendingInboxApplicationService.js";
import { getOrderStateForUpdate, findActiveOrdersForNftForUpdate, upsertOrderState } from "../db/listingRepository.js";
import { reduceOrderState, applyTransferToOrder } from "../state/orderReducer.js";
import type { NormalizedOrderEvent, NormalizedTransferEvent, OrderState } from "../state/types.js";
import { canonicalEvidence, deepFreeze, sha256Canonical } from "./evidence/canonicalEvidence.js";
import { createInitialBaselineAdoptionPlan, type InitialBaselineAdoptionPlanV1, type InitialBaselineRowPlan } from "./initialBaselineAdoption.js";
import type { InitialGenerationBaselineProjection } from "./initialGenerationBaseline.js";
import type { IntegratedEvidenceResult } from "./evidence/reconciliationEvidenceIntegration.js";
import type { GenerationPublicationEvidenceV1 } from "./generationPublication.js";
import { ADDRESS_PATTERN, SUPPORTED_CHAIN, SUPPORTED_COLLECTION_SLUG, SUPPORTED_CONTRACT_ADDRESS } from "./identityScope.js";
import { isDecimal, isIso } from "./verifier/targetedVerifierPolicy.js";
import { V2_RUNTIME_GUARD_KEY } from "../runtime/runtimeGuard.js";

export const CONTINUITY_LOSS_REBASELINE = "CONTINUITY_LOSS_REBASELINE" as const;
const PLAN_SCHEMA = "initial-baseline-adoption-v2" as const;
const SOURCE = "continuity_loss_rebaseline" as const;
const trustedAnchors = new WeakSet<object>();
const trustedPlans = new WeakSet<object>();
const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (code: string): never => { throw new Error(code); };

export interface RecoveryEntryAnchor {
  readonly schemaVersion: "continuity-loss-recovery-entry-v1";
  readonly database: "server_otg";
  readonly schema: "public";
  readonly capturedAt: string;
  readonly journalHighWater: { readonly eventId: string; readonly receivedAt: string };
  readonly supersededPublicationId: string;
  readonly supersededPublicationSequence: number;
  readonly supersededSweepId?: string;
  readonly adoptionCount: number;
  readonly listingCount: number;
  readonly activeListingCount: 0;
  readonly genericPendingCount: 0;
  readonly specializedPendingCount: number;
  readonly processingCount: 0;
  readonly failedCount: 0;
  readonly staleProcessingCount: 0;
  readonly validProductionIngestionLeaseCount: 0;
  readonly commitment: string;
}

export interface RecoveryEntryAnchorInput {
  readonly capturedAt: string;
  readonly journalHighWater: { readonly eventId: string; readonly receivedAt: string };
  readonly supersededPublicationId: string;
  readonly supersededPublicationSequence: number;
  readonly supersededSweepId?: string;
  readonly adoptionCount: number;
  readonly listingCount: number;
  readonly activeListingCount: number;
  readonly genericPendingCount: number;
  readonly specializedPendingCount: number;
  readonly processingCount: number;
  readonly failedCount: number;
  readonly staleProcessingCount: number;
  readonly validProductionIngestionLeaseCount: number;
}

function anchorMaterial(value: Omit<RecoveryEntryAnchor, "commitment">): unknown {
  return { schemaVersion: value.schemaVersion, database: value.database, schema: value.schema, capturedAt: value.capturedAt, journalHighWater: value.journalHighWater, supersededPublicationId: value.supersededPublicationId, supersededPublicationSequence: value.supersededPublicationSequence, ...(value.supersededSweepId ? { supersededSweepId: value.supersededSweepId } : {}), adoptionCount: value.adoptionCount, listingCount: value.listingCount, activeListingCount: value.activeListingCount, genericPendingCount: value.genericPendingCount, specializedPendingCount: value.specializedPendingCount, processingCount: value.processingCount, failedCount: value.failedCount, staleProcessingCount: value.staleProcessingCount, validProductionIngestionLeaseCount: value.validProductionIngestionLeaseCount };
}

export function createRecoveryEntryAnchor(input: RecoveryEntryAnchorInput): RecoveryEntryAnchor {
  if (!isIso(input.capturedAt) || !isDecimal(input.journalHighWater.eventId) || !isIso(input.journalHighWater.receivedAt) || !input.supersededPublicationId || !Number.isSafeInteger(input.supersededPublicationSequence) || input.supersededPublicationSequence < 0) fail("CONTINUITY_LOSS_RECOVERY_ANCHOR_INVALID");
  if (input.supersededSweepId !== undefined && !input.supersededSweepId) fail("CONTINUITY_LOSS_RECOVERY_ANCHOR_INVALID");
  for (const value of [input.adoptionCount, input.listingCount, input.activeListingCount, input.genericPendingCount, input.specializedPendingCount, input.processingCount, input.failedCount, input.staleProcessingCount, input.validProductionIngestionLeaseCount]) if (!Number.isSafeInteger(value) || value < 0) fail("CONTINUITY_LOSS_RECOVERY_ANCHOR_INVALID");
  if (input.activeListingCount !== 0) fail("CONTINUITY_LOSS_RECOVERY_ACTIVE_LISTINGS_PRESENT");
  if (input.adoptionCount !== 0) fail("CONTINUITY_LOSS_RECOVERY_ALREADY_ADOPTED");
  if (input.genericPendingCount !== 0) fail("CONTINUITY_LOSS_RECOVERY_GENERIC_PENDING");
  if (input.processingCount !== 0) fail("CONTINUITY_LOSS_RECOVERY_PROCESSING");
  if (input.failedCount !== 0) fail("CONTINUITY_LOSS_RECOVERY_FAILED");
  if (input.staleProcessingCount !== 0) fail("CONTINUITY_LOSS_RECOVERY_STALE_PROCESSING");
  if (input.validProductionIngestionLeaseCount !== 0) fail("CONTINUITY_LOSS_RECOVERY_INGESTION_ALREADY_RUNNING");
  const base = { schemaVersion: "continuity-loss-recovery-entry-v1" as const, database: "server_otg" as const, schema: "public" as const, ...input, activeListingCount: 0 as const, genericPendingCount: 0 as const, processingCount: 0 as const, failedCount: 0 as const, staleProcessingCount: 0 as const, validProductionIngestionLeaseCount: 0 as const };
  const anchor = deepFreeze({ ...base, commitment: sha256Canonical(anchorMaterial(base)) });
  trustedAnchors.add(anchor);
  return anchor;
}

export function isTrustedRecoveryEntryAnchor(value: unknown): value is RecoveryEntryAnchor { return !!value && typeof value === "object" && trustedAnchors.has(value as object); }

/** Capture the read-only incident boundary. Callers must invoke this before
 * starting the replacement ingestion epoch. No configuration or process
 * environment is consulted by this helper. */
export async function captureRecoveryEntryAnchor(pool: DbPool, supersededPublicationId: string, supersededPublicationSequence: number, capturedAt = new Date().toISOString(), supersededSweepId?: string): Promise<RecoveryEntryAnchor> {
  const identity = await pool.query<any>("SELECT current_database() AS database,current_schema() AS schema");
  if (identity.rows[0]?.database !== "server_otg" || identity.rows[0]?.schema !== "public") fail("CONTINUITY_LOSS_RECOVERY_DATABASE_MISMATCH");
  const publication = await pool.query<any>("SELECT generation_publication_id,publication_sequence,publication_state FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1", [supersededPublicationId]);
  if (publication.rows.length !== 1 || Number(publication.rows[0].publication_sequence) !== supersededPublicationSequence || publication.rows[0].publication_state !== "ACCEPTED") fail("CONTINUITY_LOSS_RECOVERY_PUBLICATION_BINDING_INVALID");
  const journal = await pool.query<any>("SELECT COALESCE(MAX(event_id),0)::text AS event_id,COALESCE(MAX(received_at),transaction_timestamp())::text AS received_at FROM public.opensea_listings_events_v2");
  const listing = await pool.query<any>("SELECT count(*)::text AS listing_count,count(*) FILTER (WHERE is_active=true)::text AS active_count FROM public.opensea_listings_v2");
  const inbox = await pool.query<any>("SELECT count(*) FILTER (WHERE processing_status='pending' AND COALESCE(raw_payload->'payload'->'rest_backfill_source'->>'source','') <> 'opensea_rest_events_backfill')::text AS generic_pending,count(*) FILTER (WHERE processing_status='pending' AND COALESCE(raw_payload->'payload'->'rest_backfill_source'->>'source','') = 'opensea_rest_events_backfill')::text AS specialized_pending,count(*) FILTER (WHERE processing_status='processing')::text AS processing,count(*) FILTER (WHERE processing_status='failed')::text AS failed,count(*) FILTER (WHERE processing_status='processing' AND processing_started_at IS NOT NULL AND processing_started_at <= now()-interval '15 minutes')::text AS stale FROM public.opensea_listings_events_v2");
  const adoption = await pool.query<any>("SELECT count(*)::text AS count FROM public.opensea_listings_initial_baseline_adoptions WHERE generation_publication_id=$1", [supersededPublicationId]);
  const locks = await pool.query<any>("SELECT a.pid::text AS pid,l.classid::text AS classid,l.objid::text AS objid,l.objsubid,l.mode,l.granted,a.application_name,a.datname FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.objsubid=1 AND l.granted=true AND l.mode='ExclusiveLock' AND a.datname='server_otg' AND a.application_name='opensea_listings_v2_production_ingestion'");
  const validLeases = locks.rows.filter((row: any) => { try { return (BigInt(String(row.classid)) << 32n) + BigInt(String(row.objid)) === BigInt(V2_RUNTIME_GUARD_KEY); } catch { return false; } }).length;
  const l = listing.rows[0] ?? {}, i = inbox.rows[0] ?? {};
  return createRecoveryEntryAnchor({ capturedAt, journalHighWater: { eventId: String(journal.rows[0]?.event_id ?? "0"), receivedAt: String(journal.rows[0]?.received_at ?? capturedAt) }, supersededPublicationId, supersededPublicationSequence, ...(supersededSweepId ? { supersededSweepId } : {}), adoptionCount: Number(adoption.rows[0]?.count ?? 0), listingCount: Number(l.listing_count ?? 0), activeListingCount: Number(l.active_count ?? 0), genericPendingCount: Number(i.generic_pending ?? 0), processingCount: Number(i.processing ?? 0), failedCount: Number(i.failed ?? 0), staleProcessingCount: Number(i.stale ?? 0), validProductionIngestionLeaseCount: validLeases, specializedPendingCount: Number(i.specialized_pending ?? 0) });
}

export interface ContinuityLossRebaselinePlanV2 extends Omit<InitialBaselineAdoptionPlanV1, "schemaVersion"|"adoptionId"> {
  readonly schemaVersion: typeof PLAN_SCHEMA;
  readonly recoveryMode: typeof CONTINUITY_LOSS_REBASELINE;
  readonly adoptionId: string;
  readonly supersededPublicationId: string;
  readonly supersededPublicationSequence: number;
  readonly supersededSweepId?: string;
  readonly recoveryEntryAnchorCommitment: string;
}

export function isTrustedContinuityLossRebaselinePlan(value: unknown): value is ContinuityLossRebaselinePlanV2 { return !!value && typeof value === "object" && trustedPlans.has(value as object); }

export function createContinuityLossRebaselinePlan(input: { evidence: unknown; projection: InitialGenerationBaselineProjection; integratedEvidence: IntegratedEvidenceResult; publication: GenerationPublicationEvidenceV1; supersededPublicationId: string; supersededPublicationSequence: number; recoveryEntryAnchor: RecoveryEntryAnchor }): ContinuityLossRebaselinePlanV2 {
  if (!isTrustedRecoveryEntryAnchor(input.recoveryEntryAnchor)) fail("CONTINUITY_LOSS_RECOVERY_ANCHOR_UNTRUSTED");
  const { commitment, ...anchorWithoutCommitment } = input.recoveryEntryAnchor;
  if (commitment !== sha256Canonical(anchorMaterial(anchorWithoutCommitment))) fail("CONTINUITY_LOSS_RECOVERY_ANCHOR_COMMITMENT_MISMATCH");
  if (!input.supersededPublicationId || !Number.isSafeInteger(input.supersededPublicationSequence) || input.supersededPublicationSequence < 0) fail("CONTINUITY_LOSS_REBASELINE_PUBLICATION_BINDING_INVALID");
  if (input.recoveryEntryAnchor.supersededPublicationId !== input.supersededPublicationId || input.recoveryEntryAnchor.supersededPublicationSequence !== input.supersededPublicationSequence) fail("CONTINUITY_LOSS_RECOVERY_ANCHOR_BINDING_MISMATCH");
  if (input.publication.publicationSequence <= input.supersededPublicationSequence || input.publication.generationPublicationId === input.supersededPublicationId) fail("CONTINUITY_LOSS_REBASELINE_NEW_PUBLICATION_REQUIRED");
  const v1 = createInitialBaselineAdoptionPlan(input);
  const supersededSweepId = input.recoveryEntryAnchor.supersededSweepId;
  const rowsCommitment = sha256Canonical({ schema: PLAN_SCHEMA, recoveryMode: CONTINUITY_LOSS_REBASELINE, supersededPublicationId: input.supersededPublicationId, supersededPublicationSequence: input.supersededPublicationSequence, supersededSweepId, generationPublicationId: input.publication.generationPublicationId, generationPublicationSequence: input.publication.publicationSequence, sourceEvidenceHash: v1.sourceEvidenceHash, snapshotArtifactHash: v1.snapshotArtifactHash, generationRootHash: v1.generationRootHash, candidateArtifactHash: v1.candidateArtifactHash, barrierArtifactHash: v1.barrierArtifactHash, scope: v1.scope, scopeFingerprint: v1.scopeFingerprint, protocolAddress: v1.protocolAddress, rows: v1.rows.map((r) => ({ ...r, rawBaselineListingHash: sha256Canonical(r.rawBaselineListing) })) });
  const adoptionId = sha256Canonical({ schema: PLAN_SCHEMA, recoveryMode: CONTINUITY_LOSS_REBASELINE, supersededPublicationId: input.supersededPublicationId, supersededPublicationSequence: input.supersededPublicationSequence, supersededSweepId, generationPublicationId: input.publication.generationPublicationId, generationPublicationSequence: input.publication.publicationSequence, recoveryEntryAnchorCommitment: input.recoveryEntryAnchor.commitment, stableWatermark: v1.stableWatermark, snapshotCompletedAt: v1.snapshotCompletedAt, rowsCommitment });
  const plan = deepFreeze({ ...v1, schemaVersion: PLAN_SCHEMA, recoveryMode: CONTINUITY_LOSS_REBASELINE, adoptionId, supersededPublicationId: input.supersededPublicationId, supersededPublicationSequence: input.supersededPublicationSequence, supersededSweepId, recoveryEntryAnchorCommitment: input.recoveryEntryAnchor.commitment, rowsCommitment });
  trustedPlans.add(plan);
  return plan;
}

const ORDER_EVENTS = new Set(["item_listed", "item_cancelled", "item_sold", "order_invalidate", "order_revalidate"]);
const ACCEPTED_STATUSES = new Set(["applied", "reconciliation_required", "ignored_duplicate", "ignored_older"]);
function eventTime(event: NormalizedOrderEvent | NormalizedTransferEvent): number | null { const value = event.eventType === "item_transferred" ? event.eventTimestamp ?? event.transactionTimestamp : event.eventTimestamp; const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
function sameIdentity(existing: any, row: InitialBaselineRowPlan): boolean { return existing.order_hash === row.orderHash && existing.nft_id === row.nftId && existing.chain === row.chain && existing.contract_address === row.contractAddress && String(existing.token_id) === row.tokenId && existing.collection_slug === row.collectionSlug; }

function baselineValues(row: InitialBaselineRowPlan, adoptedAt: string, adoptionId: string): unknown[] { return [row.orderHash,row.nftId,row.chain,row.contractAddress,row.tokenId,row.collectionSlug,row.sellerAddress,row.priceRaw,row.priceNormalized,row.paymentTokenAddress,row.paymentTokenSymbol,row.paymentTokenDecimals,row.listingStartAt,row.expirationAt,SOURCE,adoptedAt,row.protocolAddress,adoptionId,JSON.stringify(row.rawBaselineListing)]; }

async function resetOrInsert(client: TransactionClient, row: InitialBaselineRowPlan, adoptedAt: string, adoptionId: string): Promise<void> {
  const existing = (await client.query<any>("SELECT order_hash,nft_id,chain,contract_address,token_id,collection_slug FROM public.opensea_listings_v2 WHERE order_hash=$1 FOR UPDATE", [row.orderHash])).rows[0];
  if (existing && !sameIdentity(existing, row)) fail("CONTINUITY_LOSS_REBASELINE_EXISTING_IDENTITY_CONFLICT");
  const v = baselineValues(row, adoptedAt, adoptionId);
  if (!existing) {
    await client.query("INSERT INTO public.opensea_listings_v2 (order_hash,nft_id,chain,contract_address,token_id,collection_slug,seller_address,price_raw,price_normalized,payment_token_address,payment_token_symbol,payment_token_decimals,listing_start_at,expiration_at,status,is_active,needs_reconciliation,reconciliation_reason,last_order_event_type,last_order_event_timestamp,last_order_event_version,last_nft_event_timestamp,last_nft_event_version,last_transfer_transaction_hash,last_stream_received_at,source,last_reconciled_at,created_at,updated_at,raw_last_event,protocol_address,initial_baseline_adoption_id,raw_baseline_listing) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',true,false,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$15,$16,$16,NULL,$17,$18,$19::jsonb)", v);
    return;
  }
  await client.query("UPDATE public.opensea_listings_v2 SET nft_id=$2,chain=$3,contract_address=$4,token_id=$5,collection_slug=$6,seller_address=$7,price_raw=$8,price_normalized=$9::numeric,payment_token_address=$10,payment_token_symbol=$11,payment_token_decimals=$12,listing_start_at=$13,expiration_at=$14,status='active',is_active=true,needs_reconciliation=false,reconciliation_reason=NULL,last_order_event_type=NULL,last_order_event_timestamp=NULL,last_order_event_version=NULL,last_nft_event_timestamp=NULL,last_nft_event_version=NULL,last_transfer_transaction_hash=NULL,last_stream_received_at=NULL,source=$15,last_reconciled_at=$16,updated_at=$16,raw_last_event=NULL,protocol_address=$17,initial_baseline_adoption_id=$18,raw_baseline_listing=$19::jsonb WHERE order_hash=$1", v);
}

async function replay(client: TransactionClient, plan: ContinuityLossRebaselinePlanV2, adoptedAt: string): Promise<void> {
  const events = await client.query<any>("SELECT event_id::text,event_type,processing_status,order_hash,chain,contract_address,token_id,raw_payload,received_at::text AS received_at FROM public.opensea_listings_events_v2 WHERE event_id > $1::bigint ORDER BY event_id ASC", [plan.stableWatermark.eventId]);
  let previous: bigint | null = null;
  for (const row of events.rows) {
    if (!isDecimal(row.event_id)) fail("CONTINUITY_LOSS_REBASELINE_EVENT_MALFORMED");
    const id = BigInt(row.event_id); if (previous !== null && id <= previous) fail("CONTINUITY_LOSS_REBASELINE_EVENT_ORDER_INVALID"); previous = id;
    if (!ORDER_EVENTS.has(row.event_type) && row.event_type !== "item_transferred") continue;
    if (row.chain !== SUPPORTED_CHAIN || row.contract_address !== SUPPORTED_CONTRACT_ADDRESS) continue;
    if (!ACCEPTED_STATUSES.has(row.processing_status)) fail("CONTINUITY_LOSS_REBASELINE_UNSAFE_EVENT_STATUS");
    if (row.processing_status === "ignored_duplicate" || row.processing_status === "ignored_older") continue;
    let normalized: NormalizedOrderEvent | NormalizedTransferEvent | null; try { normalized = normalizeStoredRawEvent(row.raw_payload, row.received_at); } catch { normalized = null; }
    if (!normalized) throw new Error("CONTINUITY_LOSS_REBASELINE_EVENT_NORMALIZATION_FAILED");
    if (eventTime(normalized) !== null && eventTime(normalized)! <= Date.parse(plan.snapshotCompletedAt)) continue;
    if (normalized.eventType === "item_transferred") {
      if (!normalized.nft || normalized.nft.chain !== row.chain || normalized.nft.contractAddress !== row.contract_address || normalized.nft.tokenId !== row.token_id) fail("CONTINUITY_LOSS_REBASELINE_EVENT_IDENTITY_INVALID");
      const targets = await findActiveOrdersForNftForUpdate(client, { chain: row.chain, contractAddress: row.contract_address, tokenId: row.token_id });
      for (const target of targets) { const reduced = applyTransferToOrder(target, normalized, adoptedAt); if (reduced.state && !reduced.ignored) await upsertOrderState(client, reduced.state); }
    } else {
      const orderEvent = normalized as NormalizedOrderEvent;
      const orderHash = orderEvent.orderHash;
      if (typeof orderHash !== "string" || orderHash !== row.order_hash) throw new Error("CONTINUITY_LOSS_REBASELINE_EVENT_IDENTITY_INVALID");
      const current = await getOrderStateForUpdate(client, orderHash); const reduced = reduceOrderState(current, { ...orderEvent, orderHash } as NormalizedOrderEvent, adoptedAt); if (reduced.state && !reduced.ignored) await upsertOrderState(client, reduced.state);
    }
  }
}

function scalar(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "string") return String(value);
  return null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function publicationScopeMatches(value: unknown, plan: ContinuityLossRebaselinePlanV2): boolean {
  const scope = parseJson(value);
  return record(scope) && scope.chain === SUPPORTED_CHAIN && scope.collectionSlug === SUPPORTED_COLLECTION_SLUG && scope.contractAddress === SUPPORTED_CONTRACT_ADDRESS && scope.protocolAddress === plan.protocolAddress;
}

function validateExistingReceipt(receipt: any, plan: ContinuityLossRebaselinePlanV2): boolean {
  if (!receipt || receipt.schema_version !== PLAN_SCHEMA || receipt.adoption_id !== plan.adoptionId || receipt.generation_publication_id !== plan.generationPublicationId || Number(receipt.publication_sequence) !== plan.publicationSequence || receipt.sweep_id !== plan.sweepId || receipt.source_evidence_hash !== plan.sourceEvidenceHash || receipt.snapshot_artifact_hash !== plan.snapshotArtifactHash || receipt.generation_root_hash !== plan.generationRootHash || receipt.candidate_artifact_hash !== plan.candidateArtifactHash || receipt.barrier_artifact_hash !== plan.barrierArtifactHash || canonicalEvidence(parseJson(receipt.scope)) !== canonicalEvidence(plan.scope) || receipt.scope_fingerprint !== plan.scopeFingerprint || receipt.protocol_address !== plan.protocolAddress || String(receipt.stable_event_id) !== plan.stableWatermark.eventId || scalar(receipt.stable_received_at) !== plan.stableWatermark.receivedAt || scalar(receipt.snapshot_started_at) !== plan.snapshotStartedAt || scalar(receipt.snapshot_completed_at) !== plan.snapshotCompletedAt || Number(receipt.expected_order_count) !== plan.expectedOrderCount || Number(receipt.adopted_order_count) !== plan.expectedOrderCount || receipt.rows_commitment !== plan.rowsCommitment) return false;
  return canonicalEvidence(parseJson(receipt.payload)) === canonicalEvidence(plan);
}

function receiptColumns(): string { return "schema_version,adoption_id,generation_publication_id,publication_sequence,sweep_id,source_evidence_hash,snapshot_artifact_hash,generation_root_hash,candidate_artifact_hash,barrier_artifact_hash,scope,scope_fingerprint,protocol_address,stable_event_id,stable_received_at,snapshot_started_at,snapshot_completed_at,expected_order_count,adopted_order_count,rows_commitment,payload,adopted_at"; }

export class PostgresContinuityLossBaselineAdoptionStore {
  constructor(private readonly pool: DbPool) {}
  async adopt(plan: ContinuityLossRebaselinePlanV2): Promise<{ outcome: "ADOPTED"|"ALREADY_ADOPTED"; adoptionId: string; adoptedOrderCount: number }> {
    if (!isTrustedContinuityLossRebaselinePlan(plan)) fail("CONTINUITY_LOSS_REBASELINE_PLAN_UNTRUSTED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout = '5000ms'");
      const sequence = await client.query("SELECT sequence_key FROM public.targeted_verifier_generation_publication_sequence WHERE sequence_key=$1 FOR UPDATE", ["targeted-verifier-generation"]); if (sequence.rows.length !== 1) fail("CONTINUITY_LOSS_REBASELINE_SEQUENCE_UNAVAILABLE");
      await client.query("LOCK TABLE public.opensea_listings_events_v2 IN SHARE ROW EXCLUSIVE MODE"); await client.query("LOCK TABLE public.opensea_listings_v2 IN SHARE ROW EXCLUSIVE MODE");
      const existingReceipt = await client.query<any>(`SELECT ${receiptColumns()} FROM public.opensea_listings_initial_baseline_adoptions WHERE adoption_id=$1`, [plan.adoptionId]);
      if (existingReceipt.rows.length > 0) { if (existingReceipt.rows.length !== 1 || !validateExistingReceipt(existingReceipt.rows[0], plan)) fail("CONTINUITY_LOSS_REBASELINE_DURABLE_CORRUPTION"); const linked = await client.query<any>("SELECT order_hash,initial_baseline_adoption_id,protocol_address,raw_baseline_listing FROM public.opensea_listings_v2 WHERE initial_baseline_adoption_id=$1", [plan.adoptionId]); if (linked.rows.length !== plan.expectedOrderCount || new Set(linked.rows.map((r: any) => r.order_hash)).size !== plan.expectedOrderCount || linked.rows.some((r: any) => r.initial_baseline_adoption_id !== plan.adoptionId || r.protocol_address !== plan.protocolAddress || r.raw_baseline_listing == null)) fail("CONTINUITY_LOSS_REBASELINE_DURABLE_CORRUPTION"); await client.query("COMMIT"); return { outcome: "ALREADY_ADOPTED", adoptionId: plan.adoptionId, adoptedOrderCount: plan.expectedOrderCount }; }
      const conflicts = await client.query<any>("SELECT adoption_id FROM public.opensea_listings_initial_baseline_adoptions WHERE generation_publication_id=$1", [plan.generationPublicationId]);
      if (conflicts.rows.some((row: any) => row.adoption_id !== plan.adoptionId)) fail("CONTINUITY_LOSS_REBASELINE_DURABLE_CORRUPTION");
      const pubs = await client.query<any>("SELECT generation_publication_id,publication_sequence,publication_state,sweep_id,scope,payload FROM public.targeted_verifier_generation_publications WHERE publication_state='ACCEPTED' AND scope->>'protocolAddress'=$1 ORDER BY publication_sequence DESC FOR UPDATE", [plan.protocolAddress]);
      const scoped = pubs.rows.filter((p: any) => publicationScopeMatches(p.scope, plan));
      const current = scoped.find((p: any) => p.generation_publication_id === plan.generationPublicationId && Number(p.publication_sequence) === plan.publicationSequence && p.sweep_id === plan.sweepId);
      const topSequence = scoped.reduce((max: number, p: any) => Math.max(max, Number(p.publication_sequence)), -1);
      const top = scoped.filter((p: any) => Number(p.publication_sequence) === topSequence);
      if (!current || topSequence !== plan.publicationSequence || top.length !== 1 || top[0].generation_publication_id !== plan.generationPublicationId) fail("CONTINUITY_LOSS_REBASELINE_PUBLICATION_NOT_CURRENT");
      const now = await client.query<{ now: string }>("SELECT transaction_timestamp()::text AS now"); const adoptedAt = String(now.rows[0]?.now); if (!isIso(adoptedAt)) fail("CONTINUITY_LOSS_REBASELINE_TIMESTAMP_INVALID");
      for (const row of plan.rows) { if (Date.parse(row.expirationAt) <= Date.parse(adoptedAt)) fail("CONTINUITY_LOSS_REBASELINE_SNAPSHOT_EXPIRED"); await resetOrInsert(client, row, adoptedAt, plan.adoptionId); }
      await replay(client, plan, adoptedAt);
      const linked = await client.query<any>("SELECT order_hash,initial_baseline_adoption_id,protocol_address,raw_baseline_listing FROM public.opensea_listings_v2 WHERE initial_baseline_adoption_id=$1", [plan.adoptionId]); if (linked.rows.length !== plan.expectedOrderCount || new Set(linked.rows.map((r: any) => r.order_hash)).size !== plan.expectedOrderCount) fail("CONTINUITY_LOSS_REBASELINE_MEMBERSHIP_INVALID");
      await client.query("INSERT INTO public.opensea_listings_initial_baseline_adoptions (schema_version,adoption_id,generation_publication_id,publication_sequence,sweep_id,source_evidence_hash,snapshot_artifact_hash,generation_root_hash,candidate_artifact_hash,barrier_artifact_hash,scope,scope_fingerprint,protocol_address,stable_event_id,stable_received_at,snapshot_started_at,snapshot_completed_at,expected_order_count,adopted_order_count,rows_commitment,payload,adopted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22)", [PLAN_SCHEMA,plan.adoptionId,plan.generationPublicationId,plan.publicationSequence,plan.sweepId,plan.sourceEvidenceHash,plan.snapshotArtifactHash,plan.generationRootHash,plan.candidateArtifactHash,plan.barrierArtifactHash,JSON.stringify(plan.scope),plan.scopeFingerprint,plan.protocolAddress,plan.stableWatermark.eventId,plan.stableWatermark.receivedAt,plan.snapshotStartedAt,plan.snapshotCompletedAt,plan.expectedOrderCount,plan.expectedOrderCount,plan.rowsCommitment,JSON.stringify(plan),adoptedAt]);
      await client.query("COMMIT"); return { outcome: "ADOPTED", adoptionId: plan.adoptionId, adoptedOrderCount: plan.expectedOrderCount };
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); }
  }
}

export const adoptContinuityLossBaseline = async (pool: DbPool, plan: ContinuityLossRebaselinePlanV2) => new PostgresContinuityLossBaselineAdoptionStore(pool).adopt(plan);

// Explicit aliases keep the continuity-loss boundary discoverable to callers while
// avoiding any change to the ordinary v1 adoption store.
export const createContinuityLossRebaselinePlanV2 = createContinuityLossRebaselinePlan;
export const isTrustedContinuityLossRebaselinePlanV2 = isTrustedContinuityLossRebaselinePlan;
export const PostgresContinuityLossRebaselineStore = PostgresContinuityLossBaselineAdoptionStore;
