import type { DbPool } from "../db/types.js";
import type { GenerationPublicationEvidenceV1 } from "./generationPublication.js";
import type { ContinuityLossRebaselinePlanV2 } from "./continuityLossRebaseline.js";
import { canonicalEvidence } from "./evidence/canonicalEvidence.js";
import { normalizeStoredRawEvent } from "../db/pendingInboxApplicationService.js";
import { reduceOrderState, applyTransferToOrder } from "../state/orderReducer.js";
import type { OrderState, NormalizedOrderEvent, NormalizedTransferEvent } from "../state/types.js";

const SUPPORTED_ORDER_EVENTS = new Set(["item_listed", "item_cancelled", "item_sold", "order_invalidate", "order_revalidate"]);
const SAFE_STATUSES = new Set(["applied", "reconciliation_required", "ignored_duplicate", "ignored_older"]);
function expectedBaseline(row: any): OrderState {
  return { orderHash: row.orderHash, nft: { nftId: row.nftId, chain: row.chain, contractAddress: row.contractAddress, tokenId: row.tokenId }, collectionSlug: row.collectionSlug, seller: row.sellerAddress, price: { raw: row.priceRaw, normalizedDecimalString: row.priceNormalized, tokenAddress: row.paymentTokenAddress, symbol: row.paymentTokenSymbol, decimals: row.paymentTokenDecimals }, listingStartAt: row.listingStartAt, expirationAt: row.expirationAt, status: "active", isActive: true, needsReconciliation: false, reconciliationReason: null, lastOrderEventType: null, lastOrderEventTimestamp: null, lastOrderEventVersion: null, lastNftEventTimestamp: null, lastNftEventVersion: null, lastTransferTransactionHash: null, item: { name: null, imageUrl: null, permalink: null }, source: "continuity_loss_rebaseline", lastStreamReceivedAt: null, lastReconciledAt: null, createdAt: "", updatedAt: "", rawLastEvent: null };
}
function eventBusinessTime(event: NormalizedOrderEvent | NormalizedTransferEvent): number | null { const value = event.eventType === "item_transferred" ? (event.eventTimestamp ?? event.transactionTimestamp) : event.eventTimestamp; const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
function scalar(value: unknown): string | null { if (value === null || value === undefined) return null; if (value instanceof Date) return value.toISOString(); return typeof value === "string" || typeof value === "number" ? String(value) : null; }
function instantValue(value: unknown): string | null { const s = scalar(value); if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function numericEqual(a: unknown, b: unknown): boolean { const left = scalar(a); const right = scalar(b); if (left === null || right === null) return left === right; const norm = (v: string) => { const [whole, fraction = ""] = v.split("."); return `${whole.replace(/^(-?)0+(?=\d)/, "$1")}.${fraction.replace(/0+$/, "") || "0"}`; }; return norm(left) === norm(right); }
function instant(value: unknown): string | null { if (value === null || value === undefined) return null; const date = value instanceof Date ? value : new Date(String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function lifecycleEqual(actual: any, expected: OrderState): boolean { return actual.status === expected.status && Boolean(actual.is_active) === expected.isActive && Boolean(actual.needs_reconciliation) === expected.needsReconciliation && (actual.reconciliation_reason ?? null) === expected.reconciliationReason && (actual.last_order_event_type ?? null) === expected.lastOrderEventType && instant(actual.last_order_event_timestamp) === instant(expected.lastOrderEventTimestamp) && (actual.last_order_event_version ?? null) === expected.lastOrderEventVersion && instant(actual.last_nft_event_timestamp) === instant(expected.lastNftEventTimestamp) && (actual.last_nft_event_version ?? null) === expected.lastNftEventVersion && (actual.last_transfer_transaction_hash ?? null) === expected.lastTransferTransactionHash; }

/** Fail-closed durable verifier for continuity-loss adoption.  It deliberately
 * returns only a boolean so no database or credential material can leak into
 * operator diagnostics. */
export async function verifyContinuityLossRebaselineDurable(
  pool: DbPool,
  plan: ContinuityLossRebaselinePlanV2,
  publication: GenerationPublicationEvidenceV1,
  supersededPublicationId: string,
  supersededSweepId: string,
  leaseProbe: () => Promise<{ pid: string; backendStart: string; applicationName: string; database: string } | null>,
  initialLease: { pid: string; backendStart: string; applicationName: string; database: string }
): Promise<boolean> {
  try {
    const receipt = await pool.query<any>("SELECT schema_version,adoption_id,generation_publication_id,publication_sequence,sweep_id,source_evidence_hash,snapshot_artifact_hash,generation_root_hash,candidate_artifact_hash,barrier_artifact_hash,scope,scope_fingerprint,protocol_address,stable_event_id,stable_received_at,snapshot_started_at,snapshot_completed_at,expected_order_count,adopted_order_count,rows_commitment,payload,adopted_at FROM public.opensea_listings_initial_baseline_adoptions WHERE adoption_id=$1", [plan.adoptionId]);
    if (receipt.rows.length !== 1) return false;
    const r = receipt.rows[0];
    let payload: unknown = r.payload; if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return false; } }
    let receiptScope: unknown = r.scope; if (typeof receiptScope === "string") { try { receiptScope = JSON.parse(receiptScope); } catch { return false; } }
    if (r.schema_version !== "initial-baseline-adoption-v2" || r.adoption_id !== plan.adoptionId || r.generation_publication_id !== publication.generationPublicationId || Number(r.publication_sequence) !== publication.publicationSequence || r.sweep_id !== publication.sweepId || r.source_evidence_hash !== plan.sourceEvidenceHash || r.snapshot_artifact_hash !== plan.snapshotArtifactHash || r.generation_root_hash !== plan.generationRootHash || r.candidate_artifact_hash !== plan.candidateArtifactHash || r.barrier_artifact_hash !== plan.barrierArtifactHash || canonicalEvidence(receiptScope) !== canonicalEvidence(plan.scope) || r.scope_fingerprint !== plan.scopeFingerprint || r.protocol_address !== plan.protocolAddress || scalar(r.stable_event_id) !== plan.stableWatermark.eventId || instantValue(r.stable_received_at) !== instantValue(plan.stableWatermark.receivedAt) || instantValue(r.snapshot_started_at) !== instantValue(plan.snapshotStartedAt) || instantValue(r.snapshot_completed_at) !== instantValue(plan.snapshotCompletedAt) || Number(r.expected_order_count) !== plan.expectedOrderCount || Number(r.adopted_order_count) !== plan.expectedOrderCount || r.rows_commitment !== plan.rowsCommitment || canonicalEvidence(payload) !== canonicalEvidence(plan) || !instantValue(r.adopted_at)) return false;
    const linked = await pool.query<any>("SELECT order_hash,protocol_address,initial_baseline_adoption_id,raw_baseline_listing FROM public.opensea_listings_v2 WHERE initial_baseline_adoption_id=$1", [plan.adoptionId]);
    if (linked.rows.length !== plan.expectedOrderCount || new Set(linked.rows.map((x: any) => x.order_hash)).size !== plan.expectedOrderCount) return false;
    const expected = new Map(plan.rows.map((x) => [x.orderHash, x]));
    for (const row of linked.rows) {
      const baseline = expected.get(row.order_hash);
      let raw: unknown = row.raw_baseline_listing; if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return false; } }
      if (!baseline || row.initial_baseline_adoption_id !== plan.adoptionId || row.protocol_address !== plan.protocolAddress || canonicalEvidence(raw) !== canonicalEvidence(baseline.rawBaselineListing)) return false;
    }
    const expectedStates = new Map(plan.rows.map((row) => [row.orderHash, expectedBaseline(row)]));
    const journal = await pool.query<any>("SELECT event_id::text,event_type,processing_status,order_hash,chain,contract_address,token_id,raw_payload,received_at::text AS received_at FROM public.opensea_listings_events_v2 WHERE event_id > $1::bigint ORDER BY event_id ASC", [plan.recoveryEntryJournalEventId]);
    let previousEventId: bigint | null = null;
    for (const eventRow of journal.rows) {
      if (!/^\d+$/.test(String(eventRow.event_id))) return false;
      const eventId = BigInt(eventRow.event_id); if (previousEventId !== null && eventId <= previousEventId) return false; previousEventId = eventId;
      if (!SUPPORTED_ORDER_EVENTS.has(eventRow.event_type) && eventRow.event_type !== "item_transferred") continue;
      if (!SAFE_STATUSES.has(eventRow.processing_status)) return false;
      if (eventRow.processing_status === "ignored_duplicate" || eventRow.processing_status === "ignored_older") continue;
      let normalized: NormalizedOrderEvent | NormalizedTransferEvent | null; try { normalized = normalizeStoredRawEvent(eventRow.raw_payload, eventRow.received_at); } catch { normalized = null; }
      if (!normalized || eventBusinessTime(normalized) === null) return false;
      if (eventBusinessTime(normalized)! <= Date.parse(plan.snapshotCompletedAt)) continue;
      if (normalized.eventType === "item_transferred") {
        if (!normalized.nft) return false;
        for (const state of expectedStates.values()) if (state.nft.chain === normalized.nft.chain && state.nft.contractAddress === normalized.nft.contractAddress && state.nft.tokenId === normalized.nft.tokenId) { const reduced = applyTransferToOrder(state, normalized, state.updatedAt || plan.snapshotCompletedAt); if (reduced.state && !reduced.ignored) Object.assign(state, reduced.state); }
      } else {
        const order = normalized.orderHash ? expectedStates.get(normalized.orderHash) : undefined;
        if (!order) continue;
        const reduced = reduceOrderState(order, normalized, order.updatedAt || plan.snapshotCompletedAt); if (reduced.state && !reduced.ignored) expectedStates.set(order.orderHash, reduced.state);
      }
    }
    const durable = await pool.query<any>("SELECT order_hash,nft_id,chain,contract_address,token_id,collection_slug,seller_address,price_raw,price_normalized,payment_token_address,payment_token_symbol,payment_token_decimals,listing_start_at,expiration_at,status,is_active,needs_reconciliation,reconciliation_reason,last_order_event_type,last_order_event_timestamp,last_order_event_version,last_nft_event_timestamp,last_nft_event_version,last_transfer_transaction_hash,source,protocol_address,initial_baseline_adoption_id,raw_baseline_listing FROM public.opensea_listings_v2 WHERE initial_baseline_adoption_id=$1", [plan.adoptionId]);
    if (durable.rows.length !== expectedStates.size || durable.rows.some((row: any) => {
      const expected = expectedStates.get(row.order_hash); const baseline = plan.rows.find((x) => x.orderHash === row.order_hash);
      if (!expected || !baseline || !lifecycleEqual(row, expected)) return true;
      let raw: unknown = row.raw_baseline_listing; if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return true; } }
      return String(row.nft_id) !== baseline.nftId || row.chain !== baseline.chain || row.contract_address !== baseline.contractAddress || String(row.token_id) !== baseline.tokenId || row.collection_slug !== baseline.collectionSlug || row.seller_address !== expected.seller || !numericEqual(row.price_raw, expected.price?.raw ?? "") || !numericEqual(row.price_normalized, expected.price?.normalizedDecimalString ?? "") || row.payment_token_address !== expected.price?.tokenAddress || row.payment_token_symbol !== expected.price?.symbol || (row.payment_token_decimals === null ? null : Number(row.payment_token_decimals)) !== expected.price?.decimals || instantValue(row.listing_start_at) !== instantValue(expected.listingStartAt) || instantValue(row.expiration_at) !== instantValue(expected.expirationAt) || row.source !== "continuity_loss_rebaseline" || canonicalEvidence(raw) !== canonicalEvidence(baseline.rawBaselineListing);
    })) return false;
    const current = await pool.query<any>("SELECT generation_publication_id,publication_sequence,publication_state,sweep_id FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1", [publication.generationPublicationId]);
    if (current.rows.length !== 1 || current.rows[0].publication_state !== "ACCEPTED" || Number(current.rows[0].publication_sequence) !== publication.publicationSequence || current.rows[0].sweep_id !== publication.sweepId) return false;
    const accepted = await pool.query<any>("SELECT generation_publication_id,publication_sequence,publication_state,scope FROM public.targeted_verifier_generation_publications WHERE publication_state='ACCEPTED'");
    const publicationScope = publication.scope; const scoped = accepted.rows.filter((x: any) => { let s: any = x.scope; if (typeof s === "string") { try { s = JSON.parse(s); } catch { return false; } } return s && s.chain === publicationScope.chain && s.collectionSlug === publicationScope.collectionSlug && s.contractAddress === publicationScope.contractAddress && s.protocolAddress === publicationScope.protocolAddress; });
    const max = scoped.reduce((m: number, x: any) => Math.max(m, Number(x.publication_sequence)), -1); if (scoped.filter((x: any) => Number(x.publication_sequence) === max).length !== 1 || max !== publication.publicationSequence) return false;
    const superseded = await pool.query<any>("SELECT publication_sequence,publication_state,sweep_id FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1", [supersededPublicationId]);
    if (superseded.rows.length !== 1 || superseded.rows[0].publication_state !== "ACCEPTED" || Number(superseded.rows[0].publication_sequence) !== plan.supersededPublicationSequence || superseded.rows[0].sweep_id !== supersededSweepId) return false;
    const oldAdoptions = await pool.query<any>("SELECT count(*)::int AS count FROM public.opensea_listings_initial_baseline_adoptions WHERE generation_publication_id=$1", [supersededPublicationId]);
    if (Number(oldAdoptions.rows[0]?.count ?? 0) !== 0) return false;
    const unsafe = await pool.query<any>("SELECT count(*)::int AS count FROM public.opensea_listings_events_v2 WHERE event_id > $1::bigint AND processing_status IN ('pending','processing','failed')", [plan.recoveryEntryJournalEventId]);
    if (Number(unsafe.rows[0]?.count ?? 0) !== 0) return false;
    const after = await leaseProbe();
    return !!after && after.pid === initialLease.pid && after.backendStart === initialLease.backendStart && after.applicationName === initialLease.applicationName && after.database === initialLease.database;
  } catch {
    return false;
  }
}
