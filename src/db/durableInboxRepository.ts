import { orderDedupeKey, payloadHash, transferDedupeKey } from "../state/eventIdentity.js";
import { normalizeBusinessTimestamp, normalizeEventVersion, parseNftIdentity } from "../state/normalizers.js";
import type { NormalizedItem, NormalizedOrderEvent, NormalizedTransferEvent, OrderEventType } from "../state/types.js";
import { stringifyJsonb } from "./jsonb.js";
import type { DbPool, DurableInboxPersistResult, JournalInsertInput, JournalProcessingStatus, Queryable, TransactionClient } from "./types.js";

const ORDER_EVENTS = new Set<OrderEventType>(["item_listed", "item_cancelled", "item_sold", "order_invalidate", "order_revalidate"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventTypeOf(rawEvent: unknown): string | null {
  return text((rawEvent as { event_type?: unknown } | null)?.event_type);
}

function emptyItem(): NormalizedItem {
  return { name: null, imageUrl: null, permalink: null };
}

function minimalOrderEvent(rawEvent: any, receivedAt: string, eventType: OrderEventType): NormalizedOrderEvent {
  const payload = rawEvent?.payload ?? {};
  return {
    eventType,
    eventTimestamp: normalizeBusinessTimestamp(payload.event_timestamp),
    eventVersion: normalizeEventVersion(rawEvent?.version),
    orderHash: text(payload.order_hash),
    nft: parseNftIdentity(payload.item?.nft_id),
    seller: null,
    buyerCandidate: null,
    price: null,
    listingStartAt: null,
    expirationAt: null,
    item: emptyItem(),
    transactionHash: text(payload.transaction?.hash ?? payload.transaction_hash),
    receivedAt,
    rawPayload: rawEvent,
    mappingSuspicious: false,
    mappingIssues: []
  };
}

function minimalTransferEvent(rawEvent: any, receivedAt: string): NormalizedTransferEvent {
  const payload = rawEvent?.payload ?? {};
  return {
    eventType: "item_transferred",
    nft: parseNftIdentity(payload.item?.nft_id),
    from: null,
    to: null,
    transactionHash: text(payload.transaction?.hash),
    transactionTimestamp: null,
    eventTimestamp: normalizeBusinessTimestamp(payload.event_timestamp),
    eventVersion: normalizeEventVersion(rawEvent?.version),
    receivedAt,
    rawPayload: rawEvent,
    item: emptyItem()
  };
}

export function extractInboxJournalEnvelope(rawEvent: unknown, receivedAt: string): JournalInsertInput | null {
  const eventType = eventTypeOf(rawEvent);
  if (eventType === "item_transferred") {
    const event = minimalTransferEvent(rawEvent, receivedAt);
    return {
      eventType: event.eventType,
      eventTimestamp: event.eventTimestamp,
      eventVersion: event.eventVersion,
      orderHash: null,
      nftId: event.nft?.nftId ?? null,
      chain: event.nft?.chain ?? null,
      contractAddress: event.nft?.contractAddress ?? null,
      tokenId: event.nft?.tokenId ?? null,
      transactionHash: event.transactionHash,
      receivedAt,
      payloadHash: payloadHash(rawEvent),
      dedupeKey: transferDedupeKey(event),
      rawPayload: rawEvent
    };
  }
  if (ORDER_EVENTS.has(eventType as OrderEventType)) {
    const event = minimalOrderEvent(rawEvent, receivedAt, eventType as OrderEventType);
    return {
      eventType: event.eventType,
      eventTimestamp: event.eventTimestamp,
      eventVersion: event.eventVersion,
      orderHash: event.orderHash,
      nftId: event.nft?.nftId ?? null,
      chain: event.nft?.chain ?? null,
      contractAddress: event.nft?.contractAddress ?? null,
      tokenId: event.nft?.tokenId ?? null,
      transactionHash: event.transactionHash,
      receivedAt,
      payloadHash: payloadHash(rawEvent),
      dedupeKey: orderDedupeKey(event),
      rawPayload: rawEvent
    };
  }
  return null;
}

interface PendingInsertRow {
  event_id: string;
  processing_status: JournalProcessingStatus;
  attempt_count: number;
}

async function selectExistingInboxEvent(client: Queryable, dedupeKey: string): Promise<PendingInsertRow | null> {
  const result = await client.query<PendingInsertRow>(
    `SELECT event_id::text, processing_status, attempt_count
     FROM public.opensea_listings_events_v2
     WHERE dedupe_key = $1`,
    [dedupeKey]
  );
  return result.rows[0] ?? null;
}

function resultFrom(input: JournalInsertInput, outcome: "inserted_pending" | "duplicate_existing", row: PendingInsertRow): DurableInboxPersistResult {
  return {
    outcome,
    eventId: row.event_id,
    dedupeKey: input.dedupeKey,
    eventType: input.eventType,
    orderHash: input.orderHash,
    nftId: input.nftId,
    processingStatus: row.processing_status,
    attemptCount: row.attempt_count
  };
}

export async function persistRawEventToInboxInTransaction(client: TransactionClient, rawEvent: unknown, receivedAt: string): Promise<DurableInboxPersistResult> {
  const input = extractInboxJournalEnvelope(rawEvent, receivedAt);
  if (input === null) throw new Error("durable inbox unsupported event type");

  const insert = await client.query<PendingInsertRow>(
    `INSERT INTO public.opensea_listings_events_v2 (
      event_type,
      event_timestamp,
      event_version,
      order_hash,
      nft_id,
      chain,
      contract_address,
      token_id,
      transaction_hash,
      received_at,
      payload_hash,
      dedupe_key,
      raw_payload,
      apply_result,
      applied_at,
      processing_status,
      attempt_count,
      processing_started_at,
      last_attempt_at,
      next_retry_at,
      last_error_code,
      last_error_message
    ) VALUES (
      $1, $2, $3::bigint, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
      NULL, NULL, $14, $15, NULL, NULL, NULL, NULL, NULL
    )
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING event_id::text, processing_status, attempt_count`,
    [
      input.eventType,
      input.eventTimestamp,
      input.eventVersion,
      input.orderHash,
      input.nftId,
      input.chain,
      input.contractAddress,
      input.tokenId,
      input.transactionHash,
      input.receivedAt,
      input.payloadHash,
      input.dedupeKey,
      stringifyJsonb(input.rawPayload),
      "pending",
      0
    ]
  );
  const inserted = insert.rows[0];
  if (inserted) return resultFrom(input, "inserted_pending", inserted);

  const existing = await selectExistingInboxEvent(client, input.dedupeKey);
  if (existing === null) throw new Error("durable inbox duplicate conflict row was not found");
  return resultFrom(input, "duplicate_existing", existing);
}

export async function persistRawEventToInbox(pool: DbPool, rawEvent: unknown, receivedAt: string = new Date().toISOString()): Promise<DurableInboxPersistResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await persistRawEventToInboxInTransaction(client, rawEvent, receivedAt);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure for callers.
    }
    throw error;
  } finally {
    client.release();
  }
}
