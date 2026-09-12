import type { DbPool, TransactionClient } from "../../db/types.js";
import { applyJournalFence } from "./targetedVerifierArtifact.js";
import { eventFingerprint, isCanonicalAddress, isCanonicalOrderHash, isDecimal, isIso } from "./targetedVerifierPolicy.js";
import type { FenceResult, JournalFenceSnapshot, ProviderResult, TargetedVerifierContext, RelevantEventType, RelevantOrderEvent } from "./targetedVerifierTypes.js";

const EVENT_TYPES = new Set<RelevantEventType>(["item_listed", "item_sold", "item_cancelled", "order_invalidate", "order_revalidate", "item_transferred", "reconciliation_required"]);
const SUPPORTED_CHAIN = "gunzilla";

export interface JournalFenceSnapshotIdentity { readonly orderHash: string; readonly chain: string; readonly contractAddress: string; readonly tokenId: string; }
export interface JournalFenceSnapshotReader { readSnapshot(identity: Readonly<JournalFenceSnapshotIdentity>): Promise<JournalFenceSnapshot>; }
interface WatermarkRow { event_id: string; received_at: string; }
interface EventRow { event_id: string; event_type: string; event_version: string | null; order_hash: string | null; chain: string | null; contract_address: string | null; token_id: string | null; }

function validateIdentity(identity: JournalFenceSnapshotIdentity): void {
  if (!isCanonicalOrderHash(identity.orderHash) || identity.chain !== SUPPORTED_CHAIN || !isCanonicalAddress(identity.contractAddress) || !isDecimal(identity.tokenId)) throw new Error("INVALID_JOURNAL_SNAPSHOT_IDENTITY");
}
function iso(value: unknown): string { if (typeof value !== "string" || !isIso(value)) throw new Error("INVALID_JOURNAL_TIMESTAMP"); return value; }
function project(row: EventRow, target: string): RelevantOrderEvent {
  if (!isDecimal(row.event_id) || !EVENT_TYPES.has(row.event_type as RelevantEventType) || (row.event_version !== null && !isDecimal(row.event_version))) throw new Error("MALFORMED_JOURNAL_EVENT");
  return { eventId: row.event_id, eventType: row.event_type as RelevantEventType, orderHash: target, eventVersion: row.event_version };
}

export class PostgresJournalFenceSnapshotReader implements JournalFenceSnapshotReader {
  constructor(private readonly pool: DbPool) {}
  async readSnapshot(identity: Readonly<JournalFenceSnapshotIdentity>): Promise<JournalFenceSnapshot> {
    validateIdentity(identity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const high = await client.query<WatermarkRow>("SELECT event_id::text AS event_id, received_at FROM public.opensea_listings_events_v2 ORDER BY event_id DESC LIMIT 1");
      const watermark: JournalFenceSnapshot["watermark"] = high.rows[0] ? { eventId: high.rows[0].event_id, receivedAt: iso(high.rows[0].received_at) } : { eventId: "0", receivedAt: iso((await client.query<{ now: string }>("SELECT transaction_timestamp()::timestamptz::text AS now")).rows[0]?.now) };
      if (!isDecimal(watermark.eventId)) throw new Error("INVALID_JOURNAL_WATERMARK");
      const rows = await client.query<EventRow>("SELECT event_id::text AS event_id,event_type,event_version::text AS event_version,order_hash,chain,contract_address,token_id FROM public.opensea_listings_events_v2 WHERE event_id <= $1::bigint AND (order_hash = $2 OR (chain = $3 AND contract_address = $4 AND token_id = $5)) ORDER BY event_id ASC", [watermark.eventId, identity.orderHash, identity.chain, identity.contractAddress, identity.tokenId]);
      const events = rows.rows.map((row) => project(row, identity.orderHash));
      const snapshot = { watermark, relevantOrderFingerprint: eventFingerprint(events, identity.orderHash, false) };
      if (!(await import("./targetedVerifierPolicy.js")).validateJournalFenceSnapshot(snapshot)) throw new Error("INVALID_JOURNAL_SNAPSHOT");
      await client.query("COMMIT");
      return snapshot;
    } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve deterministic original error */ } throw error; } finally { client.release(); }
  }
}

export async function applyProductionJournalFence(input: { readonly providerResult: ProviderResult; readonly context: TargetedVerifierContext; readonly snapshotReader: JournalFenceSnapshotReader }): Promise<FenceResult> {
  const postVerification = await input.snapshotReader.readSnapshot({ orderHash: input.context.orderHash, chain: input.context.chain, contractAddress: input.context.contractAddress, tokenId: input.context.expectedIdentity.tokenId });
  return applyJournalFence(input.providerResult, input.context.preVerification, postVerification);
}
