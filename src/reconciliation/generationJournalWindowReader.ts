import type { DbPool } from "../db/types.js";
import type { CanonicalLocalIdentity } from "./identityScope.js";
import { ADDRESS_PATTERN, SUPPORTED_CHAIN, SUPPORTED_CONTRACT_ADDRESS, validateCanonicalIdentity } from "./identityScope.js";
import type { OfflineCatchUpRound, OfflineLocalAdmissionWatermark } from "./offlineGenerationBarrierModel.js";
import { isCanonicalAddress, isCanonicalOrderHash, isDecimal, isIso } from "./verifier/targetedVerifierPolicy.js";
import { deepFreeze, sha256Canonical } from "./evidence/canonicalEvidence.js";
import { validateOfflineCandidateBundle, type OfflineCandidateBundle } from "./offlineCandidateModel.js";
import type { InitialGenerationBaselineProjection } from "./initialGenerationBaseline.js";

const SCOPE_SCHEMA = "generation-window-scope-v1" as const;
const statuses = new Set(["pending", "processing", "applied", "reconciliation_required", "failed", "ignored_duplicate", "ignored_older"]);
const orderEvents = new Set(["item_listed", "item_sold", "item_cancelled", "order_invalidate", "order_revalidate"]);

export interface GenerationWindowScope {
  readonly identities: readonly CanonicalLocalIdentity[];
  readonly scopeFingerprint: string;
}
export interface GenerationWindowStart { readonly eventHighWaterBefore: OfflineLocalAdmissionWatermark; }
export interface GenerationWindowObservation {
  readonly observedHighWater: OfflineLocalAdmissionWatermark;
  readonly round: OfflineCatchUpRound;
  readonly eventIds: readonly string[];
  readonly scopeFingerprint: string;
}
interface EventRow { event_id: string; received_at: string | Date; event_type: string; processing_status: string; order_hash: string | null; chain: string | null; contract_address: string | null; token_id: string | null; }

function watermark(id: unknown, received: unknown): OfflineLocalAdmissionWatermark {
  const value = received instanceof Date ? received.toISOString() : received;
  if (!isDecimal(id) || !isIso(value)) throw new Error("GENERATION_WINDOW_MALFORMED_WATERMARK");
  return { eventId: id, receivedAt: value };
}
function validateStart(start: GenerationWindowStart): OfflineLocalAdmissionWatermark {
  if (start === null || typeof start !== "object") throw new Error("GENERATION_WINDOW_MALFORMED_WATERMARK");
  return watermark(start.eventHighWaterBefore?.eventId, start.eventHighWaterBefore?.receivedAt);
}
function nftKey(chain: string, contract: string, tokenId: string): string { return `${chain}\u0000${contract}\u0000${tokenId}`; }
function scopeKey(identity: CanonicalLocalIdentity): string { return nftKey(identity.chain, identity.contractAddress, identity.tokenId); }

function createScopeFromIdentities(input: readonly CanonicalLocalIdentity[]): GenerationWindowScope {
  if (!Array.isArray(input) || input.length === 0) throw new Error("GENERATION_WINDOW_SCOPE_EMPTY");
  const identities = input.map((value) => {
    if (validateCanonicalIdentity(value) !== "VALID") throw new Error("GENERATION_WINDOW_SCOPE_INVALID_IDENTITY");
    return { ...value };
  });
  identities.sort((left, right) => left.orderHash.localeCompare(right.orderHash) || scopeKey(left).localeCompare(scopeKey(right)) || left.protocolAddress.localeCompare(right.protocolAddress));
  const orderHashes = new Set<string>();
  const protocols = new Set<string>();
  for (const identity of identities) {
    if (orderHashes.has(identity.orderHash)) throw new Error("GENERATION_WINDOW_SCOPE_DUPLICATE_ORDER");
    orderHashes.add(identity.orderHash);
    protocols.add(identity.protocolAddress);
  }
  if (protocols.size !== 1) throw new Error(protocols.size === 0 ? "GENERATION_WINDOW_SCOPE_PROTOCOL_UNPROVEN" : "GENERATION_WINDOW_SCOPE_PROTOCOL_AMBIGUOUS");
  const owned = deepFreeze(identities);
  const scopeFingerprint = sha256Canonical({ schema: SCOPE_SCHEMA, identities: owned.map((identity) => ({ orderHash: identity.orderHash, chain: identity.chain, contractAddress: identity.contractAddress, tokenId: identity.tokenId, collectionSlug: identity.collectionSlug, protocolAddress: identity.protocolAddress })) });
  return deepFreeze({ identities: owned, scopeFingerprint });
}
/** Construct the journal scope only from a complete, accepted initial projection. */
export function createGenerationWindowScopeFromInitialProjection(projection: InitialGenerationBaselineProjection): GenerationWindowScope {
  if (projection === null || typeof projection !== "object" || !Array.isArray(projection.localOrders) || projection.candidateBundle === null || typeof projection.candidateBundle !== "object") throw new Error("GENERATION_WINDOW_SCOPE_PROJECTION_INVALID");
  const candidateBundle = projection.candidateBundle as OfflineCandidateBundle;
  if (!validateOfflineCandidateBundle(candidateBundle).valid) throw new Error("GENERATION_WINDOW_SCOPE_CANDIDATE_INVALID");
  if (candidateBundle.orders.length !== projection.localOrders.length || candidateBundle.counts.present !== projection.localOrders.length || candidateBundle.counts.absentCandidate !== 0 || candidateBundle.counts.blocked !== 0) throw new Error("GENERATION_WINDOW_SCOPE_PROJECTION_MISMATCH");
  const candidates = new Map<string, typeof candidateBundle.orders[number]>();
  for (const candidate of candidateBundle.orders) {
    if (candidates.has(candidate.orderHash)) throw new Error("GENERATION_WINDOW_SCOPE_PROJECTION_MISMATCH");
    candidates.set(candidate.orderHash, candidate);
  }
  const identities: CanonicalLocalIdentity[] = [];
  for (const local of projection.localOrders) {
    if (validateCanonicalIdentity(local.identity) !== "VALID" || local.orderHash !== local.identity.orderHash) throw new Error("GENERATION_WINDOW_SCOPE_PROJECTION_MISMATCH");
    const candidate = candidates.get(local.orderHash);
    if (!candidate || candidate.classification !== "PRESENT" || candidate.seenInSweep !== true || candidate.authorityGranted !== false || candidate.reasons.length !== 0 || validateCanonicalIdentity(candidate.identity) !== "VALID") throw new Error("GENERATION_WINDOW_SCOPE_PROJECTION_MISMATCH");
    const candidateIdentity = candidate.identity;
    if (candidate.orderHash !== local.orderHash || candidateIdentity.orderHash !== local.identity.orderHash || candidateIdentity.chain !== local.identity.chain || candidateIdentity.contractAddress !== local.identity.contractAddress || candidateIdentity.tokenId !== local.identity.tokenId || candidateIdentity.collectionSlug !== local.identity.collectionSlug || candidateIdentity.protocolAddress !== local.identity.protocolAddress) throw new Error("GENERATION_WINDOW_SCOPE_PROJECTION_MISMATCH");
    identities.push(local.identity);
  }
  if (candidates.size !== identities.length || typeof projection.protocolAddress !== "string" || identities.some((identity) => identity.protocolAddress !== projection.protocolAddress)) throw new Error("GENERATION_WINDOW_SCOPE_PROTOCOL_MISMATCH");
  return createScopeFromIdentities(identities);
}
function scopeSets(scope: GenerationWindowScope): { orderHashes: ReadonlySet<string>; nftKeys: ReadonlySet<string> } {
  if (scope === null || typeof scope !== "object" || !Array.isArray(scope.identities) || scope.identities.length === 0) throw new Error("GENERATION_WINDOW_SCOPE_EMPTY");
  const checked = createScopeFromIdentities(scope.identities);
  if (scope.scopeFingerprint !== checked.scopeFingerprint) throw new Error("GENERATION_WINDOW_SCOPE_FINGERPRINT_MISMATCH");
  return { orderHashes: new Set(checked.identities.map((identity) => identity.orderHash)), nftKeys: new Set(checked.identities.map(scopeKey)) };
}
function supportedOrder(row: EventRow): boolean {
  if (row.chain === null) throw new Error("GENERATION_WINDOW_MALFORMED_IDENTITY");
  if (row.chain !== SUPPORTED_CHAIN) return false;
  if (row.contract_address === null || !ADDRESS_PATTERN.test(row.contract_address)) throw new Error("GENERATION_WINDOW_MALFORMED_IDENTITY");
  if (row.contract_address !== SUPPORTED_CONTRACT_ADDRESS) return false;
  if (row.order_hash === null || !isCanonicalOrderHash(row.order_hash)) throw new Error("GENERATION_WINDOW_MALFORMED_IDENTITY");
  return true;
}
function relevantTransfer(row: EventRow, nftKeys: ReadonlySet<string>): boolean {
  if (row.chain === null) throw new Error("GENERATION_WINDOW_MALFORMED_IDENTITY");
  if (row.chain !== SUPPORTED_CHAIN) return false;
  if (row.contract_address === null || !isCanonicalAddress(row.contract_address)) throw new Error("GENERATION_WINDOW_MALFORMED_IDENTITY");
  if (row.contract_address !== SUPPORTED_CONTRACT_ADDRESS) return false;
  if (row.token_id === null || !isDecimal(row.token_id)) throw new Error("GENERATION_WINDOW_MALFORMED_IDENTITY");
  return nftKeys.has(nftKey(row.chain, row.contract_address, row.token_id));
}

export class PostgresGenerationJournalWindowReader {
  constructor(private readonly pool: DbPool) {}
  async captureStart(): Promise<GenerationWindowStart> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const result = await client.query<{ event_id: string; received_at: string | Date }>("SELECT event_id::text,received_at FROM public.opensea_listings_events_v2 ORDER BY event_id DESC LIMIT 1");
      const high = result.rows[0] ? watermark(result.rows[0].event_id, result.rows[0].received_at) : watermark("0", (await client.query<{ now: string | Date }>("SELECT transaction_timestamp() now")).rows[0]?.now);
      await client.query("COMMIT");
      return { eventHighWaterBefore: high };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
  async observe(start: GenerationWindowStart, scope: GenerationWindowScope, roundNumber = 1): Promise<GenerationWindowObservation> {
    const startWatermark = validateStart(start);
    const sets = scopeSets(scope);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const highResult = await client.query<{ event_id: string; received_at: string | Date }>("SELECT event_id::text,received_at FROM public.opensea_listings_events_v2 ORDER BY event_id DESC LIMIT 1");
      const observedHighWater = highResult.rows[0] ? watermark(highResult.rows[0].event_id, highResult.rows[0].received_at) : watermark("0", (await client.query<{ now: string | Date }>("SELECT transaction_timestamp() now")).rows[0]?.now);
      if (BigInt(observedHighWater.eventId) < BigInt(startWatermark.eventId)) throw new Error("GENERATION_WINDOW_WATERMARK_REGRESSION");
      const result = await client.query<EventRow>("SELECT event_id::text,received_at,event_type,processing_status,order_hash,chain,contract_address,token_id FROM public.opensea_listings_events_v2 WHERE event_id > $1::bigint AND event_id <= $2::bigint ORDER BY event_id ASC", [startWatermark.eventId, observedHighWater.eventId]);
      let pending = 0; let processing = 0; let failed = 0; let reconciliation = 0; let unknown = 0;
      const eventIds: string[] = [];
      for (const row of result.rows) {
        const relevant = orderEvents.has(row.event_type) ? supportedOrder(row) : row.event_type === "item_transferred" && relevantTransfer(row, sets.nftKeys);
        if (!relevant) continue;
        eventIds.push(row.event_id);
        if (!statuses.has(row.processing_status)) { unknown++; continue; }
        if (row.processing_status === "pending") pending++;
        else if (row.processing_status === "processing") processing++;
        else if (row.processing_status === "failed") failed++;
        else if (row.processing_status === "reconciliation_required") reconciliation++;
      }
      await client.query("COMMIT");
      return { observedHighWater, eventIds, scopeFingerprint: scope.scopeFingerprint, round: { roundNumber, observedHighWater, pendingCount: pending, processingCount: processing, failedCount: failed, reconciliationRequiredCount: reconciliation, unknownStatusCount: unknown } };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  }
}
