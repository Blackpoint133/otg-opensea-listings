import { createDatabasePool } from "../src/db/pool.js";
import { acquireOrderTransactionLock } from "../src/db/advisoryLocks.js";
import { applyNormalizedEventInTransaction } from "../src/db/eventApplicationService.js";
import { getOrderStateForUpdate } from "../src/db/listingRepository.js";
import { getNftStateForUpdate } from "../src/db/nftStateRepository.js";
import type { QueryResult, TransactionClient } from "../src/db/types.js";
import type { NormalizedOrderEvent, NormalizedTransferEvent } from "../src/state/types.js";

const NOW = "2026-08-10T13:00:00.000Z";
const RECEIVED = "2026-08-10T13:00:01.000Z";
const CHAIN = "otg-concurrency-smoke";
const CONTRACT = "0x0000000000000000000000000000000000000abc";
const TABLES = ["opensea_listings_v2", "opensea_listings_nft_state_v2", "opensea_listings_events_v2"] as const;

type SmokeClient = TransactionClient & { query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> };
type Counts = Record<(typeof TABLES)[number], number>;
type ScenarioReport = Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raw(eventType: string, id: string, payload: Record<string, unknown>): unknown {
  return { smoke: true, event_type: eventType, id, payload };
}

function nft(tokenId: string) {
  return { nftId: `${CHAIN}/${CONTRACT}/${tokenId}`, chain: CHAIN, contractAddress: CONTRACT, tokenId };
}

function item(tokenId: string) {
  return { name: `Concurrency Smoke ${tokenId}`, imageUrl: `https://example.invalid/concurrency/${tokenId}.png`, permalink: `https://example.invalid/concurrency/${tokenId}` };
}

function orderEvent(args: {
  eventType: NormalizedOrderEvent["eventType"];
  orderHash: string;
  tokenId: string;
  eventVersion: string;
  eventTimestamp?: string;
  seller?: string | null;
  priceRaw?: string | null;
  rawId?: string;
}): NormalizedOrderEvent {
  const price = args.priceRaw
    ? { raw: args.priceRaw, normalizedDecimalString: "1.0", tokenAddress: "0x0000000000000000000000000000000000000000", symbol: "GUN", decimals: 18 }
    : null;
  return {
    eventType: args.eventType,
    eventTimestamp: args.eventTimestamp ?? "2026-08-10T13:00:00.000Z",
    eventVersion: args.eventVersion,
    orderHash: args.orderHash,
    nft: nft(args.tokenId),
    seller: args.seller ?? (args.eventType === "item_listed" ? "0x0000000000000000000000000000000000000a01" : null),
    buyerCandidate: args.eventType === "item_sold" ? "0x0000000000000000000000000000000000000b01" : null,
    price,
    listingStartAt: args.eventType === "item_listed" ? "2026-08-10T13:00:00.000Z" : null,
    expirationAt: args.eventType === "item_listed" ? "2026-09-10T13:00:00.000Z" : null,
    item: item(args.tokenId),
    transactionHash: args.eventType === "item_sold" ? `0xconcurrencysale${args.tokenId}` : null,
    receivedAt: RECEIVED,
    rawPayload: raw(args.eventType, args.rawId ?? `${args.eventType}-${args.orderHash}-${args.eventVersion}`, { orderHash: args.orderHash, tokenId: args.tokenId }),
    mappingSuspicious: false,
    mappingIssues: []
  };
}

function transferEvent(tokenId: string, version: string): NormalizedTransferEvent {
  return {
    eventType: "item_transferred",
    nft: nft(tokenId),
    from: "0x0000000000000000000000000000000000000c01",
    to: "0x0000000000000000000000000000000000000c02",
    transactionHash: `0xconcurrencytransfer${tokenId}${version}`,
    transactionTimestamp: "2026-08-10T13:02:00.000Z",
    eventTimestamp: "2026-08-10T13:02:01.000Z",
    eventVersion: version,
    receivedAt: RECEIVED,
    rawPayload: raw("item_transferred", `transfer-${tokenId}-${version}`, { tokenId }),
    item: item(tokenId)
  };
}

function tracked<T>(promise: Promise<T>) {
  let settled = false;
  const wrapped = promise.finally(() => {
    settled = true;
  });
  return { promise: wrapped, isSettled: () => settled };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function begin(client: SmokeClient): Promise<void> {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '15000ms'");
}

async function rollback(client: SmokeClient): Promise<string> {
  try {
    await client.query("ROLLBACK");
    return "rolled_back";
  } catch (error) {
    return `rollback_failed:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function commit(client: SmokeClient): Promise<string> {
  await client.query("COMMIT");
  return "committed";
}

async function backendPid(client: SmokeClient): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = result.rows[0]?.pid;
  if (typeof pid !== "number") throw new Error("pg_backend_pid returned no pid");
  return pid;
}

async function countRows(client: SmokeClient): Promise<Counts> {
  const out = {} as Counts;
  for (const table of TABLES) {
    const result = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.${table}`);
    out[table] = Number(result.rows[0]?.count ?? 0);
  }
  return out;
}

async function tableExistence(client: SmokeClient): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const table of TABLES) {
    const result = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS exists",
      ["public", table]
    );
    out[`public.${table}`] = Boolean(result.rows[0]?.exists);
  }
  return out;
}

async function v1Baseline(client: SmokeClient): Promise<Record<string, unknown>> {
  const exists = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS exists",
    ["public", "opensea_listings"]
  );
  if (!exists.rows[0]?.exists) return { exists: false };
  const count = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings");
  const pk = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema=$1 AND tc.table_name=$2 AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    ["public", "opensea_listings"]
  );
  const columns = await client.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    ["public", "opensea_listings"]
  );
  return { exists: true, rowCount: Number(count.rows[0]?.count ?? 0), pk: pk.rows.map((row) => row.column_name), columnCount: Number(columns.rows[0]?.count ?? 0) };
}

async function observeActivity(observer: SmokeClient, pid: number): Promise<Record<string, unknown>> {
  const result = await observer.query<{ state: string | null; wait_event_type: string | null; wait_event: string | null }>(
    "SELECT state, wait_event_type, wait_event FROM pg_stat_activity WHERE pid=$1",
    [pid]
  );
  return result.rows[0] ?? {};
}

async function idleInTransaction(observer: SmokeClient, pids: number[]): Promise<Array<Record<string, unknown>>> {
  if (pids.length === 0) return [];
  const result = await observer.query<{ pid: number; state: string }>(
    "SELECT pid, state FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state = 'idle in transaction'",
    [pids]
  );
  return result.rows;
}

function assertSmoke(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectBlocked<T>(observer: SmokeClient, pid: number, task: ReturnType<typeof tracked<T>>, label: string): Promise<Record<string, unknown>> {
  await sleep(300);
  assertSmoke(!task.isSettled(), `${label} completed before blocking could be observed`);
  const activity = await observeActivity(observer, pid);
  assertSmoke(activity.wait_event_type === "Lock", `${label} did not report Lock wait: ${JSON.stringify(activity)}`);
  return activity;
}

async function finishScenario(observer: SmokeClient, clients: SmokeClient[], pids: number[], report: ScenarioReport): Promise<void> {
  report.idleInTransaction = await idleInTransaction(observer, pids);
  assertSmoke((report.idleInTransaction as unknown[]).length === 0, `idle-in-transaction leak: ${JSON.stringify(report.idleInTransaction)}`);
  report.postCounts = await countRows(observer);
  assertSmoke(Object.values(report.postCounts as Counts).every((count) => count === 0), `persistent V2 counts are not zero: ${JSON.stringify(report.postCounts)}`);
  for (const client of clients) client.release();
}

async function scenarioSameNewOrder(pool: any, observer: SmokeClient): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const report: ScenarioReport = { backendPids: { a: pidA, b: pidB } };
  try {
    const listed = orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencyorder01", tokenId: "9100001", eventVersion: "1", priceRaw: "1000000000000000000" });
    const cancelled = orderEvent({ eventType: "item_cancelled", orderHash: listed.orderHash!, tokenId: "9100001", eventVersion: "2", rawId: "same-order-cancel" });
    await begin(a);
    const aResult = await applyNormalizedEventInTransaction(a, listed, NOW);
    report.aResult = aResult.result;
    await begin(b);
    const bTask = tracked(applyNormalizedEventInTransaction(b, cancelled, NOW));
    report.wait = await expectBlocked(observer, pidB, bTask, "same-new-order client B");
    report.rollbackA = await rollback(a);
    const bResult = await withTimeout(bTask.promise, 5000, "same-new-order client B completion");
    report.bResult = bResult.result;
    report.rollbackB = await rollback(b);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function scenarioSameNewNft(pool: any, observer: SmokeClient): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const report: ScenarioReport = { backendPids: { a: pidA, b: pidB } };
  try {
    await begin(a);
    report.aResult = (await applyNormalizedEventInTransaction(a, transferEvent("9100002", "1"), NOW)).result;
    await begin(b);
    const bTask = tracked(applyNormalizedEventInTransaction(b, transferEvent("9100002", "2"), NOW));
    report.wait = await expectBlocked(observer, pidB, bTask, "same-new-NFT client B");
    report.rollbackA = await rollback(a);
    const bResult = await withTimeout(bTask.promise, 5000, "same-new-NFT client B completion");
    report.bResult = bResult.result;
    const nftState = await getNftStateForUpdate(b, CHAIN, CONTRACT, "9100002");
    report.bLocalNftState = { owner: nftState?.currentOwnerAddress, tx: nftState?.lastTransferTransactionHash };
    report.rollbackB = await rollback(b);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function scenarioListingVsTransfer(pool: any, observer: SmokeClient, direction: "listing-holds" | "transfer-holds"): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const tokenId = direction === "listing-holds" ? "9100003" : "9100004";
  const report: ScenarioReport = { direction, backendPids: { a: pidA, b: pidB } };
  try {
    await begin(a);
    if (direction === "listing-holds") {
      report.aResult = (await applyNormalizedEventInTransaction(a, orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencylistingtransfer01", tokenId, eventVersion: "1", priceRaw: "1000000000000000000" }), NOW)).result;
      await begin(b);
      const bTask = tracked(applyNormalizedEventInTransaction(b, transferEvent(tokenId, "2"), NOW));
      report.wait = await expectBlocked(observer, pidB, bTask, "listing-vs-transfer transfer client");
      report.rollbackA = await rollback(a);
      report.bResult = (await withTimeout(bTask.promise, 5000, "listing-vs-transfer transfer completion")).result;
    } else {
      report.aResult = (await applyNormalizedEventInTransaction(a, transferEvent(tokenId, "1"), NOW)).result;
      await begin(b);
      const bTask = tracked(applyNormalizedEventInTransaction(b, orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencytransferlisting01", tokenId, eventVersion: "2", priceRaw: "1000000000000000000" }), NOW));
      report.wait = await expectBlocked(observer, pidB, bTask, "transfer-vs-listing listing client");
      report.rollbackA = await rollback(a);
      report.bResult = (await withTimeout(bTask.promise, 5000, "transfer-vs-listing listing completion")).result;
    }
    report.rollbackB = await rollback(b);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function scenarioDifferentNfts(pool: any, observer: SmokeClient): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const report: ScenarioReport = { backendPids: { a: pidA, b: pidB } };
  try {
    await begin(a);
    report.aResult = (await applyNormalizedEventInTransaction(a, orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencydifferentnfta", tokenId: "9100005", eventVersion: "1", priceRaw: "1000000000000000000" }), NOW)).result;
    await begin(b);
    const started = Date.now();
    const bResult = await withTimeout(applyNormalizedEventInTransaction(b, orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencydifferentnftb", tokenId: "9100006", eventVersion: "1", priceRaw: "1000000000000000000" }), NOW), 1000, "different-NFT client B");
    report.bResult = bResult.result;
    report.bElapsedMs = Date.now() - started;
    report.bActivityAfterCompletion = await observeActivity(observer, pidB);
    report.rollbackB = await rollback(b);
    report.rollbackA = await rollback(a);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function scenarioOrderHashCasing(pool: any, observer: SmokeClient): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const lower = "0xabcdef1234567890";
  const upper = "0xABCDEF1234567890";
  const report: ScenarioReport = { backendPids: { a: pidA, b: pidB }, sameDerivedLockExpected: true };
  try {
    await begin(a);
    await acquireOrderTransactionLock(a, lower);
    await begin(b);
    const bTask = tracked(acquireOrderTransactionLock(b, upper));
    report.wait = await expectBlocked(observer, pidB, bTask, "order-hash casing client B");
    report.rollbackA = await rollback(a);
    await withTimeout(bTask.promise, 5000, "order-hash casing client B completion");
    report.bAcquired = true;
    report.rollbackB = await rollback(b);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function scenarioDuplicate(pool: any, observer: SmokeClient): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const event = orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencyduplicate01", tokenId: "9100007", eventVersion: "1", priceRaw: "1000000000000000000" });
  const report: ScenarioReport = { backendPids: { a: pidA, b: pidB } };
  try {
    await begin(a);
    report.aResult = (await applyNormalizedEventInTransaction(a, event, NOW)).result;
    await begin(b);
    const bTask = tracked(applyNormalizedEventInTransaction(b, event, NOW));
    report.wait = await expectBlocked(observer, pidB, bTask, "duplicate client B");
    report.rollbackA = await rollback(a);
    const firstB = await withTimeout(bTask.promise, 5000, "duplicate client B first completion");
    report.bFirstResult = firstB.result;
    const secondB = await applyNormalizedEventInTransaction(b, event, NOW);
    report.bSecondResult = secondB.result;
    const journalCount = await b.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_events_v2 WHERE dedupe_key=$1", [firstB.dedupeKey]);
    report.bLocalJournalCountForDedupe = Number(journalCount.rows[0]?.count ?? 0);
    assertSmoke(secondB.result === "duplicate_ignored", "same-transaction duplicate did not return duplicate_ignored");
    assertSmoke(report.bLocalJournalCountForDedupe === 1, "same-transaction duplicate journal count is not 1");
    report.limitation = "Cross-transaction committed duplicate_ignored was not tested because business writes are rollback-only.";
    report.rollbackB = await rollback(b);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function scenarioDirectLockRelease(pool: any, observer: SmokeClient, release: "rollback" | "commit"): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const report: ScenarioReport = { release, backendPids: { a: pidA, b: pidB }, containsV2Writes: false };
  try {
    await begin(a);
    await acquireOrderTransactionLock(a, `0xconcurrencylockrelease${release}`);
    await begin(b);
    const bTask = tracked(acquireOrderTransactionLock(b, `0xconcurrencylockrelease${release}`));
    report.wait = await expectBlocked(observer, pidB, bTask, `lock release on ${release} client B`);
    report.releaseA = release === "commit" ? await commit(a) : await rollback(a);
    await withTimeout(bTask.promise, 5000, `lock release on ${release} client B completion`);
    report.bAcquired = true;
    report.rollbackB = await rollback(b);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function scenarioRuntimeLockOrder(pool: any, observer: SmokeClient): Promise<ScenarioReport> {
  const client = await pool.connect() as SmokeClient;
  const pid = await backendPid(client);
  const calls: string[] = [];
  const recordingClient: SmokeClient = {
    release: () => undefined,
    query: async <Row = unknown>(text: string, values: readonly unknown[] = []) => {
      calls.push(text);
      return client.query<Row>(text, values);
    }
  };
  const report: ScenarioReport = { backendPids: { client: pid } };
  try {
    await begin(client);
    report.result = (await applyNormalizedEventInTransaction(recordingClient, orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencylockorder01", tokenId: "9100008", eventVersion: "1", priceRaw: "1000000000000000000" }), NOW)).result;
    const nftLock = calls.findIndex((text) => /pg_advisory_xact_lock/.test(text));
    const orderLock = calls.findIndex((text, index) => index > nftLock && /pg_advisory_xact_lock/.test(text));
    const journal = calls.findIndex((text) => /INSERT INTO public\.opensea_listings_events_v2/.test(text));
    assertSmoke(nftLock > -1 && orderLock > nftLock && journal > orderLock, `unexpected lock order: ${JSON.stringify(calls)}`);
    report.sequence = ["NFT advisory lock", "ORDER advisory lock", "journal insert"];
    report.rollback = await rollback(client);
    await finishScenario(observer, [client], [pid], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollback = await rollback(client);
    client.release();
    throw error;
  }
}

async function scenarioDifferentOrderSameNft(pool: any, observer: SmokeClient): Promise<ScenarioReport> {
  const a = await pool.connect() as SmokeClient;
  const b = await pool.connect() as SmokeClient;
  const pidA = await backendPid(a);
  const pidB = await backendPid(b);
  const tokenId = "9100009";
  const report: ScenarioReport = { backendPids: { a: pidA, b: pidB } };
  try {
    await begin(a);
    report.aResult = (await applyNormalizedEventInTransaction(a, orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencysamenfta", tokenId, eventVersion: "1", priceRaw: "1000000000000000000" }), NOW)).result;
    await begin(b);
    const bTask = tracked(applyNormalizedEventInTransaction(b, orderEvent({ eventType: "item_listed", orderHash: "0xconcurrencysamenftb", tokenId, eventVersion: "2", priceRaw: "1000000000000000000" }), NOW));
    report.wait = await expectBlocked(observer, pidB, bTask, "different-order same-NFT client B");
    report.rollbackA = await rollback(a);
    report.bResult = (await withTimeout(bTask.promise, 5000, "different-order same-NFT client B completion")).result;
    report.rollbackB = await rollback(b);
    await finishScenario(observer, [a, b], [pidA, pidB], report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.rollbackA = await rollback(a);
    report.rollbackB = await rollback(b);
    a.release();
    b.release();
    throw error;
  }
}

async function run(): Promise<void> {
  const pool = createDatabasePool();
  const observer = await pool.connect() as SmokeClient;
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), scenarios: {} };
  try {
    const database = await observer.query<{ database: string }>("SELECT current_database() AS database");
    report.database = database.rows[0]?.database;
    assertSmoke(report.database === "server_otg", `unexpected database: ${String(report.database)}`);
    report.tableExistence = await tableExistence(observer);
    assertSmoke(Object.values(report.tableExistence as Record<string, boolean>).every(Boolean), `missing V2 table: ${JSON.stringify(report.tableExistence)}`);
    report.initialCounts = await countRows(observer);
    assertSmoke(Object.values(report.initialCounts as Counts).every((count) => count === 0), `initial V2 counts are not zero: ${JSON.stringify(report.initialCounts)}`);
    report.v1Before = await v1Baseline(observer);

    const scenarios = report.scenarios as Record<string, unknown>;
    scenarios.same_new_order = await scenarioSameNewOrder(pool, observer);
    scenarios.same_new_nft = await scenarioSameNewNft(pool, observer);
    scenarios.listing_holds_transfer_waits = await scenarioListingVsTransfer(pool, observer, "listing-holds");
    scenarios.transfer_holds_listing_waits = await scenarioListingVsTransfer(pool, observer, "transfer-holds");
    scenarios.different_nfts_non_blocking = await scenarioDifferentNfts(pool, observer);
    scenarios.order_hash_casing = await scenarioOrderHashCasing(pool, observer);
    scenarios.duplicate_serialization = await scenarioDuplicate(pool, observer);
    scenarios.rollback_lock_release = await scenarioDirectLockRelease(pool, observer, "rollback");
    scenarios.commit_lock_release = await scenarioDirectLockRelease(pool, observer, "commit");
    scenarios.runtime_lock_order = await scenarioRuntimeLockOrder(pool, observer);
    scenarios.different_order_same_nft = await scenarioDifferentOrderSameNft(pool, observer);

    report.finalCounts = await countRows(observer);
    assertSmoke(Object.values(report.finalCounts as Counts).every((count) => count === 0), `final V2 counts are not zero: ${JSON.stringify(report.finalCounts)}`);
    report.v1After = await v1Baseline(observer);
    report.observerIdleInTransaction = await idleInTransaction(observer, [await backendPid(observer)]);
  } finally {
    observer.release();
    await pool.end();
  }
  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
