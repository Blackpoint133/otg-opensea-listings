import { applyTransferToOrder, reduceOrderState } from "../state/orderReducer.js";
import { reduceNftState } from "../state/nftReducer.js";
import { transferDedupeKey } from "../state/eventIdentity.js";
import { normalizeBusinessSecond } from "../state/normalizers.js";
import type { NormalizedOrderEvent, NormalizedTransferEvent } from "../state/types.js";
import { acquireNftTransactionLock, acquireOrderTransactionLock } from "./advisoryLocks.js";
import { finalizeJournalEvent, insertJournalEvent, journalInputFromOrderEvent, journalInputFromTransferEvent } from "./eventJournalRepository.js";
import { findActiveOrdersForNftForUpdate, getOrderStateForUpdate, upsertOrderState } from "./listingRepository.js";
import { getNftStateForUpdate, upsertNftState } from "./nftStateRepository.js";
import type { DbPool, EventApplicationOutcome, EventApplicationResult, JournalInsertInput, TransactionClient } from "./types.js";

function isTransferEvent(event: NormalizedOrderEvent | NormalizedTransferEvent): event is NormalizedTransferEvent {
  return event.eventType === "item_transferred";
}

function outcomeFrom(applyResult: string, reconciliationRequired: boolean, stateChanged: boolean): EventApplicationOutcome {
  if (applyResult.includes("ignored_older")) return "ignored_older_event";
  if (reconciliationRequired) return "journaled_reconciliation_required";
  if (!stateChanged) return "journaled_state_not_persisted";
  return "applied";
}

function duplicateResult(input: JournalInsertInput): EventApplicationResult {
  return {
    dedupeKey: input.dedupeKey,
    eventType: input.eventType,
    orderHash: input.orderHash,
    nftId: input.nftId,
    result: "duplicate_ignored",
    applyResult: "duplicate_ignored",
    reconciliationRequired: false,
    stateChanged: false,
    journalEventId: null
  };
}

export const REST_TRANSFER_AMBIGUOUS_APPLY_RESULT = "rest_transfer_ambiguous_same_second_no_state_mutation";

export interface EventStateApplicationOptions {
  currentJournalEventId?: string | null;
  currentDedupeKey?: string | null;
}

function isRestBackfillTransfer(event: NormalizedTransferEvent): boolean {
  const payload = (event.rawPayload as { payload?: { rest_backfill_source?: { source?: unknown } } } | null)?.payload;
  return payload?.rest_backfill_source?.source === "opensea_rest_events_backfill";
}

export interface RestTransferAmbiguityKey {
  chain: string;
  contractAddress: string;
  tokenId: string;
  eventTimestamp: string;
  transactionHash: string;
  dedupeKey: string;
}

export function restTransferAmbiguityKey(event: NormalizedTransferEvent, dedupeKey = transferDedupeKey(event)): RestTransferAmbiguityKey | null {
  if (!isRestBackfillTransfer(event)) return null;
  const businessSecond = normalizeBusinessSecond(event.eventTimestamp);
  if (!event.nft || !businessSecond || event.eventVersion !== null || !event.transactionHash) return null;
  return {
    chain: event.nft.chain,
    contractAddress: event.nft.contractAddress,
    tokenId: event.nft.tokenId,
    eventTimestamp: businessSecond,
    transactionHash: event.transactionHash,
    dedupeKey
  };
}

export function isSameSecondRestTransferAmbiguity(left: RestTransferAmbiguityKey, right: RestTransferAmbiguityKey): boolean {
  return left.chain === right.chain
    && left.contractAddress === right.contractAddress
    && left.tokenId === right.tokenId
    && left.eventTimestamp === right.eventTimestamp
    && left.transactionHash !== right.transactionHash
    && left.dedupeKey !== right.dedupeKey;
}

async function hasSameSecondRestTransferConflict(client: TransactionClient, event: NormalizedTransferEvent, options: EventStateApplicationOptions): Promise<boolean> {
  const currentDedupeKey = options.currentDedupeKey ?? transferDedupeKey(event);
  const key = restTransferAmbiguityKey(event, currentDedupeKey);
  if (!key) return false;
  const result = await client.query<{ event_id: string }>(
    `SELECT event_id::text
     FROM public.opensea_listings_events_v2
     WHERE event_type = 'item_transferred'
       AND chain = $1
       AND contract_address = $2
       AND token_id = $3
       AND event_timestamp >= $4::timestamptz
       AND event_timestamp < ($4::timestamptz + interval '1 second')
       AND transaction_hash IS NOT NULL
       AND transaction_hash <> $5
       AND dedupe_key <> $6
       AND ($7::text IS NULL OR event_id::text <> $7)
     LIMIT 1`,
    [
      key.chain,
      key.contractAddress,
      key.tokenId,
      key.eventTimestamp,
      key.transactionHash,
      key.dedupeKey,
      options.currentJournalEventId ?? null
    ]
  );
  return result.rows.length > 0;
}

async function applyOrderEvent(client: TransactionClient, event: NormalizedOrderEvent, now: string): Promise<{ applyResult: string; reconciliationRequired: boolean; stateChanged: boolean }> {
  const current = event.orderHash ? await getOrderStateForUpdate(client, event.orderHash) : null;
  const reduced = reduceOrderState(current, event, now);
  if (reduced.state) {
    await upsertOrderState(client, reduced.state);
    return { applyResult: reduced.applyResult, reconciliationRequired: reduced.requiresReconciliation, stateChanged: !reduced.ignored };
  }
  return { applyResult: reduced.applyResult, reconciliationRequired: true, stateChanged: false };
}

async function applyTransferEvent(client: TransactionClient, event: NormalizedTransferEvent, now: string, options: EventStateApplicationOptions): Promise<{ applyResult: string; reconciliationRequired: boolean; stateChanged: boolean }> {
  if (!event.nft) return { applyResult: "journaled_state_not_persisted_missing_nft", reconciliationRequired: true, stateChanged: false };
  if (await hasSameSecondRestTransferConflict(client, event, options)) {
    return { applyResult: REST_TRANSFER_AMBIGUOUS_APPLY_RESULT, reconciliationRequired: true, stateChanged: false };
  }
  const currentNft = await getNftStateForUpdate(client, event.nft.chain, event.nft.contractAddress, event.nft.tokenId);
  const nftResult = reduceNftState(currentNft, event, now);
  let stateChanged = false;
  if (nftResult.state) {
    await upsertNftState(client, nftResult.state);
    stateChanged = !nftResult.ignored;
  }

  let suppressed = 0;
  if (!nftResult.ignored) {
    const activeOrders = await findActiveOrdersForNftForUpdate(client, {
      chain: event.nft.chain,
      contractAddress: event.nft.contractAddress,
      tokenId: event.nft.tokenId
    });
    for (const order of activeOrders) {
      const orderResult = applyTransferToOrder(order, event, now);
      if (orderResult.state && !orderResult.ignored) {
        await upsertOrderState(client, orderResult.state);
        suppressed += 1;
      }
    }
  }

  return {
    applyResult: `${nftResult.applyResult};suppressed_orders=${suppressed}`,
    reconciliationRequired: true,
    stateChanged: stateChanged || suppressed > 0
  };
}

export function applicationOutcomeFrom(applyResult: string, reconciliationRequired: boolean, stateChanged: boolean): EventApplicationOutcome {
  return outcomeFrom(applyResult, reconciliationRequired, stateChanged);
}

export async function acquireEventLocks(client: TransactionClient, event: NormalizedOrderEvent | NormalizedTransferEvent): Promise<void> {
  if (isTransferEvent(event)) {
    if (event.nft) await acquireNftTransactionLock(client, event.nft);
    return;
  }
  // Global order is always NFT lock before ORDER lock to avoid deadlock between listing and transfer paths.
  if (event.nft) await acquireNftTransactionLock(client, event.nft);
  if (event.orderHash) await acquireOrderTransactionLock(client, event.orderHash);
}

export async function applyNormalizedEventStateInTransaction(client: TransactionClient, event: NormalizedOrderEvent | NormalizedTransferEvent, now: string = new Date().toISOString(), options: EventStateApplicationOptions = {}): Promise<{ applyResult: string; reconciliationRequired: boolean; stateChanged: boolean; outcome: EventApplicationOutcome }> {
  await acquireEventLocks(client, event);
  const applied = isTransferEvent(event)
    ? await applyTransferEvent(client, event, now, options)
    : await applyOrderEvent(client, event, now);
  return {
    ...applied,
    outcome: outcomeFrom(applied.applyResult, applied.reconciliationRequired, applied.stateChanged)
  };
}

export async function applyNormalizedEventInTransaction(client: TransactionClient, event: NormalizedOrderEvent | NormalizedTransferEvent, now: string = new Date().toISOString()): Promise<EventApplicationResult> {
  await acquireEventLocks(client, event);
  const input = isTransferEvent(event) ? journalInputFromTransferEvent(event) : journalInputFromOrderEvent(event);
  const journal = await insertJournalEvent(client, input);
  if (!journal.inserted || journal.eventId === null) return duplicateResult(input);

  const applied = isTransferEvent(event)
    ? await applyTransferEvent(client, event, now, { currentJournalEventId: journal.eventId, currentDedupeKey: input.dedupeKey })
    : await applyOrderEvent(client, event, now);
  const outcome = outcomeFrom(applied.applyResult, applied.reconciliationRequired, applied.stateChanged);
  await finalizeJournalEvent(client, journal.eventId, applied.applyResult);
  return {
    dedupeKey: input.dedupeKey,
    eventType: input.eventType,
    orderHash: input.orderHash,
    nftId: input.nftId,
    result: outcome,
    applyResult: applied.applyResult,
    reconciliationRequired: applied.reconciliationRequired,
    stateChanged: applied.stateChanged,
    journalEventId: journal.eventId
  };
}

export async function applyNormalizedEvent(pool: DbPool, event: NormalizedOrderEvent | NormalizedTransferEvent, now: string = new Date().toISOString()): Promise<EventApplicationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await applyNormalizedEventInTransaction(client, event, now);
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
