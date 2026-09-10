import { createHash } from "node:crypto";
import { createDatabasePool } from "../src/db/pool.js";
import { applyNormalizedEventInTransaction } from "../src/db/eventApplicationService.js";
import { getOrderStateForUpdate } from "../src/db/listingRepository.js";
import { getNftStateForUpdate } from "../src/db/nftStateRepository.js";
import type { DbPool, EventApplicationResult, QueryResult, TransactionClient } from "../src/db/types.js";
import type { NormalizedOrderEvent, NormalizedTransferEvent } from "../src/state/types.js";

const NOW = "2026-08-10T12:00:00.000Z";
const RECEIVED = "2026-08-10T12:00:01.000Z";
const CHAIN = "otg-smoke-chain";
const CONTRACT = "0x0000000000000000000000000000000000000abc";
const OTHER_CONTRACT = "0x0000000000000000000000000000000000000abd";

type SmokeClient = TransactionClient & { query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> };

function raw(eventType: string, id: string, payload: Record<string, unknown>): unknown {
  return { smoke: true, event_type: eventType, id, payload };
}

function nft(tokenId: string, contractAddress = CONTRACT) {
  return { nftId: `${CHAIN}/${contractAddress}/${tokenId}`, chain: CHAIN, contractAddress, tokenId };
}

function item(name: string, tokenId: string) {
  return { name, imageUrl: `https://example.invalid/smoke/${tokenId}.png`, permalink: `https://example.invalid/smoke/${tokenId}` };
}

function orderEvent(args: {
  eventType: NormalizedOrderEvent["eventType"];
  orderHash: string | null;
  tokenId: string;
  eventTimestamp: string | null;
  eventVersion: number;
  seller?: string | null;
  priceRaw?: string | null;
  priceNormalized?: string | null;
  expirationAt?: string | null;
  rawId?: string;
}): NormalizedOrderEvent {
  const price = args.priceRaw && args.priceNormalized
    ? { raw: args.priceRaw, normalizedDecimalString: args.priceNormalized, tokenAddress: "0x0000000000000000000000000000000000000000", symbol: "GUN", decimals: 18 }
    : null;
  return {
    eventType: args.eventType,
    eventTimestamp: args.eventTimestamp,
    eventVersion: args.eventVersion,
    orderHash: args.orderHash,
    nft: args.orderHash || args.tokenId ? nft(args.tokenId) : null,
    seller: args.seller ?? null,
    buyerCandidate: args.eventType === "item_sold" ? "0x0000000000000000000000000000000000000b01" : null,
    price,
    listingStartAt: args.eventType === "item_listed" ? "2026-08-10T12:00:00.000Z" : null,
    expirationAt: args.expirationAt ?? null,
    item: item(`Smoke ${args.tokenId}`, args.tokenId),
    transactionHash: args.eventType === "item_sold" ? `0xsmokesale${args.tokenId}` : null,
    receivedAt: RECEIVED,
    rawPayload: raw(args.eventType, args.rawId ?? `${args.eventType}-${args.orderHash ?? "null"}-${args.eventVersion}`, { orderHash: args.orderHash, tokenId: args.tokenId }),
    mappingSuspicious: false,
    mappingIssues: []
  };
}

function transferEvent(tokenId: string, version: number, to = "0x0000000000000000000000000000000000000c02"): NormalizedTransferEvent {
  return {
    eventType: "item_transferred",
    nft: nft(tokenId),
    from: "0x0000000000000000000000000000000000000c01",
    to,
    transactionHash: `0xsmoketransfer${tokenId}${version}`,
    transactionTimestamp: "2026-08-10T12:10:00.000Z",
    eventTimestamp: "2026-08-10T12:10:01.000Z",
    eventVersion: version,
    receivedAt: RECEIVED,
    rawPayload: raw("item_transferred", `transfer-${tokenId}-${version}`, { tokenId, to }),
    item: item(`Smoke ${tokenId}`, tokenId)
  };
}

function revalidateEvent(): NormalizedOrderEvent {
  return {
    eventType: "order_revalidate",
    eventTimestamp: null,
    eventVersion: 99,
    orderHash: null,
    nft: null,
    seller: null,
    buyerCandidate: null,
    price: null,
    listingStartAt: null,
    expirationAt: null,
    item: { name: null, imageUrl: null, permalink: null },
    transactionHash: null,
    receivedAt: RECEIVED,
    rawPayload: raw("order_revalidate", "revalidate-null-identity", {}),
    mappingSuspicious: true,
    mappingIssues: ["order_revalidate_payload_unverified"]
  };
}

async function countRows(client: SmokeClient): Promise<Record<string, number>> {
  const tables = ["opensea_listings_v2", "opensea_listings_nft_state_v2", "opensea_listings_events_v2"];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const result = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.${table}`);
    out[table] = Number(result.rows[0]?.count ?? 0);
  }
  return out;
}

async function v1Baseline(client: SmokeClient): Promise<Record<string, unknown>> {
  const exists = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='opensea_listings') AS exists");
  if (!exists.rows[0]?.exists) return { exists: false };
  const count = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings");
  const pk = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema='public' AND tc.table_name='opensea_listings' AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`
  );
  const columns = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='opensea_listings'");
  return { exists: true, rowCount: Number(count.rows[0]?.count ?? 0), pk: pk.rows.map((row) => row.column_name), columnCount: Number(columns.rows[0]?.count ?? 0) };
}

async function journalStatus(client: SmokeClient, dedupeKey: string): Promise<{ count: number; applyResult: string | null; appliedAt: string | null }> {
  const result = await client.query<{ count: string; apply_result: string | null; applied_at: string | null }>(
    `SELECT COUNT(*)::text AS count, max(apply_result) AS apply_result, max(applied_at)::text AS applied_at
     FROM public.opensea_listings_events_v2
     WHERE dedupe_key = $1`,
    [dedupeKey]
  );
  const row = result.rows[0];
  return { count: Number(row?.count ?? 0), applyResult: row?.apply_result ?? null, appliedAt: row?.applied_at ?? null };
}

async function allJournalsFinalized(client: SmokeClient): Promise<boolean> {
  const result = await client.query<{ unfinished: string }>(
    "SELECT COUNT(*)::text AS unfinished FROM public.opensea_listings_events_v2 WHERE apply_result IS NULL OR applied_at IS NULL"
  );
  return Number(result.rows[0]?.unfinished ?? 0) === 0;
}

function assertSmoke(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const pool = createDatabasePool();
  const client = await pool.connect() as SmokeClient;
  const report: Record<string, unknown> = { startedAt, scenarios: {} };
  let rollbackResult = "not_started";
  try {
    const database = await client.query<{ database: string }>("SELECT current_database() AS database");
    report.database = database.rows[0]?.database;
    const preCounts = await countRows(client);
    report.preCounts = preCounts;
    assertSmoke(Object.values(preCounts).every((count) => count === 0), `preflight V2 counts are not zero: ${JSON.stringify(preCounts)}`);
    report.v1Before = await v1Baseline(client);

    await client.query("BEGIN");
    report.transactionBegin = "ok";

    const listed = orderEvent({ eventType: "item_listed", orderHash: "0xsmoke-listed-1", tokenId: "9000001", eventTimestamp: "2026-08-10T12:00:00.000Z", eventVersion: 1, seller: "0x0000000000000000000000000000000000000a01", priceRaw: "12345678901234567890123", priceNormalized: "12345.678901234567890123", expirationAt: "2026-09-10T12:00:00.000Z" });
    const listedResult = await applyNormalizedEventInTransaction(client, listed, NOW);
    const listedState = await getOrderStateForUpdate(client, listed.orderHash!);
    const listedJournal = await journalStatus(client, listedResult.dedupeKey);
    assertSmoke(listedState?.status === "active", "item_listed did not create active state");
    assertSmoke(listedState.isActive === true, "item_listed is_active mismatch");
    assertSmoke(listedState.needsReconciliation === false, "item_listed reconciliation mismatch");
    assertSmoke(listedState.price?.raw === listed.price?.raw, "price_raw mismatch");
    assertSmoke(listedState.price?.normalizedDecimalString === listed.price?.normalizedDecimalString, "price_normalized roundtrip mismatch");
    assertSmoke(listedState.rawLastEvent !== null, "raw_last_event missing");
    assertSmoke(listedJournal.applyResult !== null && listedJournal.appliedAt !== null, "listed journal unfinished");
    (report.scenarios as Record<string, unknown>).item_listed = { result: listedResult.result, status: listedState.status, priceNormalized: listedState.price?.normalizedDecimalString };

    const duplicate = await applyNormalizedEventInTransaction(client, listed, NOW);
    const duplicateJournal = await journalStatus(client, listedResult.dedupeKey);
    assertSmoke(duplicate.result === "duplicate_ignored", "duplicate result mismatch");
    assertSmoke(duplicateJournal.count === 1, "duplicate created extra journal row");
    (report.scenarios as Record<string, unknown>).duplicate_item_listed = { result: duplicate.result, journalCount: duplicateJournal.count };

    const cancelOrder = "0xsmoke-cancel-1";
    const cancelListed = orderEvent({ eventType: "item_listed", orderHash: cancelOrder, tokenId: "9000002", eventTimestamp: "2026-08-10T12:01:00.000Z", eventVersion: 2, seller: "0x0000000000000000000000000000000000000a02", priceRaw: "2000000000000000000", priceNormalized: "2.0", expirationAt: "2026-09-10T12:00:00.000Z" });
    const cancelEvent = orderEvent({ eventType: "item_cancelled", orderHash: cancelOrder, tokenId: "9000002", eventTimestamp: "2026-08-10T12:02:00.000Z", eventVersion: 3, rawId: "cancel-terminal" });
    await applyNormalizedEventInTransaction(client, cancelListed, NOW);
    await applyNormalizedEventInTransaction(client, cancelEvent, NOW);
    const cancelState = await getOrderStateForUpdate(client, cancelOrder);
    assertSmoke(cancelState?.status === "cancelled", "cancel final status mismatch");
    assertSmoke(cancelState.isActive === false, "cancel active mismatch");
    assertSmoke(cancelState.seller === cancelListed.seller, "cancel seller preservation mismatch");
    assertSmoke(cancelState.price?.raw === cancelListed.price?.raw, "cancel price preservation mismatch");
    (report.scenarios as Record<string, unknown>).listed_cancelled = { status: cancelState.status, isActive: cancelState.isActive };

    const soldOrder = "0xsmoke-sold-1";
    const soldListed = orderEvent({ eventType: "item_listed", orderHash: soldOrder, tokenId: "9000003", eventTimestamp: "2026-08-10T12:03:00.000Z", eventVersion: 4, seller: "0x0000000000000000000000000000000000000a03", priceRaw: "3000000000000000000", priceNormalized: "3.0", expirationAt: "2026-09-10T12:00:00.000Z" });
    const soldEvent = orderEvent({ eventType: "item_sold", orderHash: soldOrder, tokenId: "9000003", eventTimestamp: "2026-08-10T12:04:00.000Z", eventVersion: 5, priceRaw: "3000000000000000000", priceNormalized: "3.0", rawId: "sold-terminal" });
    const invalidateAfterSold = orderEvent({ eventType: "order_invalidate", orderHash: soldOrder, tokenId: "9000003", eventTimestamp: "2026-08-10T12:05:00.000Z", eventVersion: 6, rawId: "invalidate-after-sold" });
    await applyNormalizedEventInTransaction(client, soldListed, NOW);
    await applyNormalizedEventInTransaction(client, soldEvent, NOW);
    await applyNormalizedEventInTransaction(client, invalidateAfterSold, NOW);
    const soldState = await getOrderStateForUpdate(client, soldOrder);
    assertSmoke(soldState?.status === "sold", "sold state downgraded by invalidate");
    assertSmoke(soldState.isActive === false, "sold active mismatch");
    (report.scenarios as Record<string, unknown>).listed_sold_invalidate = { status: soldState.status, isActive: soldState.isActive };

    const tombstone = orderEvent({ eventType: "order_invalidate", orderHash: "0xsmoke-invalidate-only", tokenId: "9000004", eventTimestamp: "2026-08-10T12:06:00.000Z", eventVersion: 7, rawId: "invalidate-only" });
    await applyNormalizedEventInTransaction(client, tombstone, NOW);
    const tombstoneState = await getOrderStateForUpdate(client, tombstone.orderHash!);
    assertSmoke(tombstoneState?.status === "invalidated", "tombstone status mismatch");
    assertSmoke(tombstoneState.isActive === false && tombstoneState.needsReconciliation === true, "tombstone reconciliation mismatch");
    assertSmoke(tombstoneState.seller === null && tombstoneState.price === null, "tombstone fabricated seller/price");
    (report.scenarios as Record<string, unknown>).invalidate_only = { status: tombstoneState.status, needsReconciliation: tombstoneState.needsReconciliation };

    const transferOnly = transferEvent("9000005", 8);
    await applyNormalizedEventInTransaction(client, transferOnly, NOW);
    const nftState = await getNftStateForUpdate(client, CHAIN, CONTRACT, "9000005");
    assertSmoke(nftState?.currentOwnerAddress === transferOnly.to, "NFT owner mismatch");
    assertSmoke(nftState.lastTransferTransactionHash === transferOnly.transactionHash, "NFT tx mismatch");
    (report.scenarios as Record<string, unknown>).transfer_nft_state = { owner: nftState.currentOwnerAddress, tx: nftState.lastTransferTransactionHash };

    const suppressOrder = "0xsmoke-transfer-suppress";
    const unrelatedOrder = "0xsmoke-transfer-unrelated";
    const suppressListed = orderEvent({ eventType: "item_listed", orderHash: suppressOrder, tokenId: "9000006", eventTimestamp: "2026-08-10T12:07:00.000Z", eventVersion: 9, seller: "0x0000000000000000000000000000000000000a06", priceRaw: "6000000000000000000", priceNormalized: "6.0", expirationAt: "2026-09-10T12:00:00.000Z" });
    const unrelatedListed = orderEvent({ eventType: "item_listed", orderHash: unrelatedOrder, tokenId: "9000007", eventTimestamp: "2026-08-10T12:07:10.000Z", eventVersion: 10, seller: "0x0000000000000000000000000000000000000a07", priceRaw: "7000000000000000000", priceNormalized: "7.0", expirationAt: "2026-09-10T12:00:00.000Z" });
    await applyNormalizedEventInTransaction(client, suppressListed, NOW);
    await applyNormalizedEventInTransaction(client, unrelatedListed, NOW);
    await applyNormalizedEventInTransaction(client, transferEvent("9000006", 11), NOW);
    const suppressedState = await getOrderStateForUpdate(client, suppressOrder);
    const unrelatedState = await getOrderStateForUpdate(client, unrelatedOrder);
    assertSmoke(suppressedState?.isActive === false && suppressedState.needsReconciliation === true && suppressedState.reconciliationReason === "transfer_observed", "transfer suppression mismatch");
    assertSmoke(unrelatedState?.isActive === true && unrelatedState.status === "active", "unrelated NFT was suppressed");
    (report.scenarios as Record<string, unknown>).transfer_suppression = { suppressed: suppressedState.reconciliationReason, unrelatedIsActive: unrelatedState.isActive };

    const revalidate = revalidateEvent();
    const revalidateResult = await applyNormalizedEventInTransaction(client, revalidate, NOW);
    const revalidateJournal = await journalStatus(client, revalidateResult.dedupeKey);
    assertSmoke(revalidateResult.result === "journaled_reconciliation_required", "revalidate result mismatch");
    assertSmoke(revalidateJournal.applyResult === "journal_only_revalidate", "revalidate apply_result mismatch");
    assertSmoke(revalidateJournal.appliedAt !== null, "revalidate applied_at missing");
    const activeForRevalidate = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_v2 WHERE order_hash LIKE '0xsmoke-revalidate%'");
    assertSmoke(Number(activeForRevalidate.rows[0]?.count ?? 0) === 0, "revalidate inserted fake order");
    (report.scenarios as Record<string, unknown>).order_revalidate_journal_only = { result: revalidateResult.result, applyResult: revalidateJournal.applyResult };

    assertSmoke(await allJournalsFinalized(client), "some journal rows are unfinished");
    report.innerCountsBeforeRollback = await countRows(client);
  } finally {
    try {
      await client.query("ROLLBACK");
      rollbackResult = "rolled_back";
    } catch (error) {
      rollbackResult = `rollback_failed:${error instanceof Error ? error.message : String(error)}`;
    }
    client.release();
    await pool.end();
  }

  report.rollbackResult = rollbackResult;
  const verifyPool = createDatabasePool();
  try {
    const verify = await verifyPool.connect() as SmokeClient;
    try {
      report.finalCounts = await countRows(verify);
      report.v1After = await v1Baseline(verify);
    } finally {
      verify.release();
    }
  } finally {
    await verifyPool.end();
  }
  const finalCounts = report.finalCounts as Record<string, number>;
  assertSmoke(Object.values(finalCounts).every((count) => count === 0), `final V2 counts are not zero: ${JSON.stringify(finalCounts)}`);
  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
