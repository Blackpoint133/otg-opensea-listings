import { orderDedupeKey, payloadHash, transferDedupeKey } from "../state/eventIdentity.js";
import type { NormalizedOrderEvent, NormalizedTransferEvent } from "../state/types.js";
import type { JournalInsertInput, JournalInsertResult, Queryable } from "./types.js";
import { stringifyJsonb } from "./jsonb.js";

export const EVENT_JOURNAL_TABLE = "public.opensea_listings_events_v2";

export function journalInputFromOrderEvent(event: NormalizedOrderEvent): JournalInsertInput {
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
    receivedAt: event.receivedAt,
    payloadHash: payloadHash(event.rawPayload),
    dedupeKey: orderDedupeKey(event),
    rawPayload: event.rawPayload
  };
}

export function journalInputFromTransferEvent(event: NormalizedTransferEvent): JournalInsertInput {
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
    receivedAt: event.receivedAt,
    payloadHash: payloadHash(event.rawPayload),
    dedupeKey: transferDedupeKey(event),
    rawPayload: event.rawPayload
  };
}

export async function insertJournalEvent(client: Queryable, input: JournalInsertInput): Promise<JournalInsertResult> {
  const result = await client.query<{ event_id: string }>(
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
      applied_at
    ) VALUES (
      $1, $2, $3::bigint, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NULL, NULL
    )
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING event_id::text`,
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
      stringifyJsonb(input.rawPayload)
    ]
  );
  const row = result.rows[0];
  return { inserted: Boolean(row), eventId: row?.event_id ?? null };
}

export async function finalizeJournalEvent(client: Queryable, eventId: string, applyResult: string): Promise<void> {
  const result = await client.query(
    `UPDATE public.opensea_listings_events_v2
     SET apply_result = $2,
         applied_at = now()
     WHERE event_id = $1`,
    [eventId, applyResult]
  );
  if (result.rowCount !== 1) throw new Error(`journal finalization expected 1 row, got ${result.rowCount ?? "null"}`);
}
