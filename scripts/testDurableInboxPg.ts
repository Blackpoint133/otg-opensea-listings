import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyNormalizedEvent } from "../src/db/eventApplicationService.js";
import { persistRawEventToInbox } from "../src/db/durableInboxRepository.js";
import { applyPendingInboxEvent } from "../src/db/pendingInboxApplicationService.js";
import { loadDatabaseConfig } from "../src/db/pool.js";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import { normalizeTransferEvent } from "../src/state/normalizers.js";
import { runWriterPreflight } from "../src/writer/preflight.js";

const { Pool } = pg;

const DISPOSABLE_DB = "server_otg_opensea_v2_durable_inbox_test";
const PRODUCTION_DB = "server_otg";
const MAINTENANCE_DB = "postgres";
const NOW = "2026-08-12T00:00:00.000Z";
const RECEIVED_AT = "2026-08-12T00:00:01.000Z";
const CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271";
const SIGNATURE_SQL = `
SELECT md5(string_agg(
  event_id::text || '|' ||
  dedupe_key || '|' ||
  payload_hash || '|' ||
  md5(raw_payload::text) || '|' ||
  coalesce(apply_result,'') || '|' ||
  coalesce(applied_at::text,''),
  E'\\n' ORDER BY event_id
)) AS signature
FROM public.opensea_listings_events_v2`;

interface PgClientLike {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

interface PgPoolLike extends DbPool {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

interface Counts {
  orders: number;
  nft_state: number;
  journal: number;
  unfinalized: number;
}

const integrationResults: string[] = [];

function record(name: string): void {
  integrationResults.push(name);
  console.log(`PASS ${name}`);
}

function quoteIdent(value: string): string {
  if (value !== DISPOSABLE_DB && value !== MAINTENANCE_DB && value !== PRODUCTION_DB) throw new Error("unexpected database identifier");
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function poolFor(database: string, withTimeouts = false): PgPoolLike {
  if (![DISPOSABLE_DB, PRODUCTION_DB, MAINTENANCE_DB].includes(database)) throw new Error(`refusing pool for unexpected database ${database}`);
  const config = loadDatabaseConfig({ ...process.env, POSTGRES_DB: database });
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    application_name: `opensea_v2_pg_integration_${database}`,
    ...(withTimeouts ? { options: "-c lock_timeout=2000 -c statement_timeout=15000" } : {})
  }) as unknown as PgPoolLike;
}

async function currentDatabase(client: PgClientLike): Promise<string> {
  return (await client.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database ?? "";
}

async function assertDatabase(client: PgClientLike, expected: string): Promise<void> {
  const actual = await currentDatabase(client);
  assert.equal(actual, expected, `expected database ${expected}, got ${actual}`);
}

async function counts(pool: PgPoolLike): Promise<Counts> {
  await assertDatabase(pool, DISPOSABLE_DB);
  return (await pool.query<Counts>(
    `SELECT
       (SELECT COUNT(*)::int FROM public.opensea_listings_v2) AS orders,
       (SELECT COUNT(*)::int FROM public.opensea_listings_nft_state_v2) AS nft_state,
       (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2) AS journal,
       (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2 WHERE apply_result IS NULL) AS unfinalized`
  )).rows[0]!;
}

async function productionEvidence(): Promise<{ counts: Counts; lifecycle: unknown[]; identity: unknown; signature: string | null; v1Exists: boolean }> {
  const pool = poolFor(PRODUCTION_DB);
  try {
    await assertDatabase(pool, PRODUCTION_DB);
    const result = (await pool.query<Counts>(
      `SELECT
         (SELECT COUNT(*)::int FROM public.opensea_listings_v2) AS orders,
         (SELECT COUNT(*)::int FROM public.opensea_listings_nft_state_v2) AS nft_state,
         (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2) AS journal,
         (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2 WHERE apply_result IS NULL) AS unfinalized`
    )).rows[0]!;
    const lifecycle = (await pool.query("SELECT processing_status, attempt_count, COUNT(*)::int AS count FROM public.opensea_listings_events_v2 GROUP BY processing_status, attempt_count ORDER BY processing_status, attempt_count")).rows;
    const identity = (await pool.query("SELECT COUNT(*)::int AS row_count, MIN(event_id)::text AS min_event_id, MAX(event_id)::text AS max_event_id, COUNT(DISTINCT event_id)::int AS distinct_event_id, COUNT(DISTINCT dedupe_key)::int AS distinct_dedupe_key, COUNT(DISTINCT payload_hash)::int AS distinct_payload_hash FROM public.opensea_listings_events_v2")).rows[0]!;
    const signature = (await pool.query<{ signature: string | null }>(SIGNATURE_SQL)).rows[0]?.signature ?? null;
    const v1Exists = Boolean((await pool.query<{ exists: boolean }>("SELECT to_regclass('public.opensea_listings') IS NOT NULL AS exists")).rows[0]?.exists);
    return { counts: result, lifecycle, identity, signature, v1Exists };
  } finally {
    await pool.end();
  }
}

async function databaseExists(pool: PgPoolLike, database: string): Promise<boolean> {
  return Boolean((await pool.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=$1) AS exists", [database])).rows[0]?.exists);
}

async function disposableV2Tables(pool: PgPoolLike): Promise<string[]> {
  await assertDatabase(pool, DISPOSABLE_DB);
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [["opensea_listings_v2", "opensea_listings_nft_state_v2", "opensea_listings_events_v2"]]
  );
  return result.rows.map((row) => row.table_name);
}

async function disposableHasAnyRows(pool: PgPoolLike): Promise<boolean> {
  await assertDatabase(pool, DISPOSABLE_DB);
  const result = await pool.query<{ total: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM public.opensea_listings_v2) +
       (SELECT COUNT(*) FROM public.opensea_listings_nft_state_v2) +
       (SELECT COUNT(*) FROM public.opensea_listings_events_v2)
     )::text AS total`
  );
  return result.rows[0]?.total !== "0";
}

async function inspectDisposableDatabase(pool: PgPoolLike): Promise<"empty_database" | "schema_absent" | "schema_present_empty"> {
  const tables = await disposableV2Tables(pool);
  if (tables.length === 0) return "schema_absent";
  const expected = ["opensea_listings_events_v2", "opensea_listings_nft_state_v2", "opensea_listings_v2"];
  if (tables.join(",") !== expected.join(",")) throw new Error(`disposable DB has unexpected partial V2 schema: ${tables.join(",")}`);
  if (await disposableHasAnyRows(pool)) throw new Error("disposable DB has pre-existing V2 rows; refusing to reuse");
  return "schema_present_empty";
}

async function dropDisposableIfExists(pool: PgPoolLike): Promise<{ dropped: boolean; error: string | null }> {
  await assertDatabase(pool, MAINTENANCE_DB);
  if (!(await databaseExists(pool, DISPOSABLE_DB))) return { dropped: false, error: null };
  try {
    await pool.query(`DROP DATABASE ${quoteIdent(DISPOSABLE_DB)}`);
    return { dropped: true, error: null };
  } catch (error) {
    return { dropped: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function prepareDisposableDatabase(): Promise<{ preExisting: boolean; created: boolean }> {
  const pool = poolFor(MAINTENANCE_DB);
  try {
    await assertDatabase(pool, MAINTENANCE_DB);
    const existed = await databaseExists(pool, DISPOSABLE_DB);
    if (existed) {
      const info = await pool.query("SELECT datname, datallowconn FROM pg_database WHERE datname=$1", [DISPOSABLE_DB]);
      assert.equal(info.rows.length, 1);
      return { preExisting: true, created: false };
    }
    try {
      await pool.query(`CREATE DATABASE ${quoteIdent(DISPOSABLE_DB)}`);
      return { preExisting: false, created: true };
    } catch (error) {
      if (await databaseExists(pool, DISPOSABLE_DB)) return { preExisting: true, created: false };
      throw new Error(`disposable DB does not exist and CREATE DATABASE failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await pool.end();
  }
}

async function dropDisposableDatabase(): Promise<{ dropped: boolean; error: string | null }> {
  const pool = poolFor(MAINTENANCE_DB);
  try {
    return await dropDisposableIfExists(pool);
  } finally {
    await pool.end();
  }
}

async function applySchema(pool: PgPoolLike): Promise<void> {
  await assertDatabase(pool, DISPOSABLE_DB);
  const state = await inspectDisposableDatabase(pool);
  if (state === "schema_present_empty") throw new Error("disposable DB already has empty V2 schema; refusing to reuse without manual recreation");
  const root = path.resolve(import.meta.dirname, "..");
  for (const file of ["sql/001_create_v2_schema.sql", "sql/002_add_journal_processing_lifecycle.sql"]) {
    await assertDatabase(pool, DISPOSABLE_DB);
    await pool.query(fs.readFileSync(path.join(root, file), "utf8"));
  }
  await runWriterPreflight(pool, { liveWritesEnabled: true, explicitWriterMode: true, maxConcurrency: 1 }, { expectedDatabase: DISPOSABLE_DB });
}

function syntheticTransfer(tokenId: string, txHashSuffix: string, eventTimestamp: string, txTimestamp: string, version: string, to: string): any {
  return {
    event_type: "item_transferred",
    version,
    sent_at: eventTimestamp,
    payload: {
      chain: "gunzilla",
      collection: { slug: "off-the-grid" },
      event_timestamp: eventTimestamp,
      from_account: { address: "0x0000000000000000000000000000000000000000" },
      item: {
        nft_id: `gunzilla/${CONTRACT}/${tokenId}`,
        permalink: `https://opensea.io/item/gunzilla/${CONTRACT}/${tokenId}`,
        chain: { name: "gunzilla" },
        metadata: { name: `#${tokenId}`, image_url: null }
      },
      quantity: 1,
      to_account: { address: to },
      transaction: {
        hash: `0x${txHashSuffix.padStart(64, "0").slice(0, 64)}`,
        timestamp: txTimestamp
      }
    }
  };
}

async function journalByEventId(pool: PgPoolLike, eventId: string): Promise<any> {
  await assertDatabase(pool, DISPOSABLE_DB);
  return (await pool.query("SELECT event_id::text, processing_status, attempt_count, processing_started_at::text, last_attempt_at::text, next_retry_at::text, last_error_code, last_error_message, apply_result, applied_at::text, raw_payload, dedupe_key, payload_hash FROM public.opensea_listings_events_v2 WHERE event_id=$1", [eventId])).rows[0];
}

async function journalCountForDedupe(pool: PgPoolLike, dedupeKey: string): Promise<number> {
  await assertDatabase(pool, DISPOSABLE_DB);
  return Number((await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_events_v2 WHERE dedupe_key=$1", [dedupeKey])).rows[0]?.count ?? "0");
}

function expectCounts(actual: Counts, expected: Counts): void {
  assert.deepEqual(actual, expected);
}

async function run(): Promise<{ cleanup: string; beforeProduction: Awaited<ReturnType<typeof productionEvidence>>; afterProduction: Awaited<ReturnType<typeof productionEvidence>>; preExistingDisposable: boolean; createdDisposable: boolean; mixedDiagnostic: string }> {
  const beforeProduction = await productionEvidence();
  assert.deepEqual(beforeProduction.counts, { orders: 0, nft_state: 25, journal: 25, unfinalized: 0 });
  assert.equal(beforeProduction.v1Exists, true);
  record("server_otg preflight preservation SELECT");

  let cleanup = "not_started";
  let preExistingDisposable = false;
  let createdDisposable = false;
  let mixedDiagnostic = "not_executed";
  const prepared = await prepareDisposableDatabase();
  preExistingDisposable = prepared.preExisting;
  createdDisposable = prepared.created;
  const pool = poolFor(DISPOSABLE_DB, true);
  try {
    await assertDatabase(pool, DISPOSABLE_DB);
    await applySchema(pool);
    expectCounts(await counts(pool), { orders: 0, nft_state: 0, journal: 0, unfinalized: 0 });
    record("disposable DB schema bootstrap");

    const raw1 = syntheticTransfer("990000000001", "1", "2026-08-11T04:21:07.000000Z", "1786422067", "1786422067000", "0x1111111111111111111111111111111111111111");
    const txA = await persistRawEventToInbox(pool, raw1, RECEIVED_AT);
    assert.equal(txA.outcome, "inserted_pending");
    let row = await journalByEventId(pool, txA.eventId);
    assert.equal(row.processing_status, "pending");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.apply_result, null);
    assert.equal(row.applied_at, null);
    assert.equal(row.processing_started_at, null);
    assert.equal(row.last_attempt_at, null);
    assert.equal(row.next_retry_at, null);
    assert.equal(row.last_error_code, null);
    assert.equal(row.last_error_message, null);
    assert.equal(row.raw_payload.payload.transaction.timestamp, "1786422067");
    expectCounts(await counts(pool), { orders: 0, nft_state: 0, journal: 1, unfinalized: 1 });
    record("Tx A real commit pending row");

    await assert.rejects(
      () => applyPendingInboxEvent(pool, txA.eventId, NOW, { beforeStateApplication: () => { throw new Error("injected infrastructure failure after claim"); } }),
      /injected infrastructure failure/
    );
    row = await journalByEventId(pool, txA.eventId);
    assert.equal(row.processing_status, "pending");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.processing_started_at, null);
    assert.equal(row.last_attempt_at, null);
    assert.equal(row.apply_result, null);
    assert.equal(row.applied_at, null);
    expectCounts(await counts(pool), { orders: 0, nft_state: 0, journal: 1, unfinalized: 1 });
    record("Tx B infrastructure rollback preserves pending");

    const txB = await applyPendingInboxEvent(pool, txA.eventId, NOW);
    assert.equal(txB.outcome, "reconciliation_required");
    row = await journalByEventId(pool, txA.eventId);
    assert.equal(row.processing_status, "reconciliation_required");
    assert.equal(row.attempt_count, 1);
    assert.equal(row.processing_started_at, null);
    assert.equal(row.next_retry_at, null);
    assert.equal(row.last_error_code, null);
    assert.equal(row.last_error_message, null);
    assert.equal(row.apply_result, "inserted_nft_transfer;suppressed_orders=0");
    assert.ok(row.applied_at);
    const nft = (await pool.query<any>("SELECT chain, contract_address, token_id, nft_id, current_owner_address, last_transfer_transaction_hash, last_transfer_at::text, last_nft_event_timestamp::text FROM public.opensea_listings_nft_state_v2 WHERE token_id=$1", ["990000000001"])).rows[0];
    assert.equal(nft.chain, "gunzilla");
    assert.equal(nft.contract_address, CONTRACT);
    assert.equal(nft.current_owner_address, "0x1111111111111111111111111111111111111111");
    assert.equal(nft.last_transfer_transaction_hash, raw1.payload.transaction.hash);
    assert.equal(new Date(nft.last_transfer_at).toISOString(), "2026-08-11T04:21:07.000Z");
    assert.equal(new Date(nft.last_nft_event_timestamp).toISOString(), "2026-08-11T04:21:07.000Z");
    expectCounts(await counts(pool), { orders: 0, nft_state: 1, journal: 1, unfinalized: 0 });
    record("Tx B real success finalizes and updates NFT state");

    const duplicate = await persistRawEventToInbox(pool, raw1, RECEIVED_AT);
    assert.equal(duplicate.outcome, "duplicate_existing");
    assert.equal(duplicate.eventId, txA.eventId);
    assert.equal(await journalCountForDedupe(pool, txA.dedupeKey), 1);
    expectCounts(await counts(pool), { orders: 0, nft_state: 1, journal: 1, unfinalized: 0 });
    record("Tx A duplicate after finalization");

    const raw2 = syntheticTransfer("990000000002", "2", "2026-08-11T04:22:07.000000Z", "1786422127", "1786422127000", "0x2222222222222222222222222222222222222222");
    const concurrentTxA = await Promise.all([persistRawEventToInbox(pool, raw2, RECEIVED_AT), persistRawEventToInbox(pool, raw2, RECEIVED_AT)]);
    assert.deepEqual(concurrentTxA.map((r) => r.outcome).sort(), ["duplicate_existing", "inserted_pending"]);
    const pending2 = concurrentTxA.find((r) => r.outcome === "inserted_pending") ?? concurrentTxA[0];
    assert.equal(await journalCountForDedupe(pool, pending2.dedupeKey), 1);
    record("concurrent Tx A duplicate");

    const concurrentTxB = await Promise.all([applyPendingInboxEvent(pool, pending2.eventId, NOW), applyPendingInboxEvent(pool, pending2.eventId, NOW)]);
    assert.deepEqual(concurrentTxB.map((r) => r.outcome).sort(), ["already_finalized", "reconciliation_required"]);
    row = await journalByEventId(pool, pending2.eventId);
    assert.equal(row.processing_status, "reconciliation_required");
    assert.equal(row.attempt_count, 1);
    record("concurrent same-event Tx B");

    const sameNftOlder = syntheticTransfer("990000000003", "3", "2026-08-11T04:20:00.000000Z", "1786422000", "1786422000000", "0x3333333333333333333333333333333333333333");
    const sameNftNewer = syntheticTransfer("990000000003", "4", "2026-08-11T04:25:00.000000Z", "1786422300", "1786422300000", "0x4444444444444444444444444444444444444444");
    const [sameA, sameB] = await Promise.all([persistRawEventToInbox(pool, sameNftOlder, RECEIVED_AT), persistRawEventToInbox(pool, sameNftNewer, RECEIVED_AT)]);
    assert.equal(sameA.outcome, "inserted_pending");
    assert.equal(sameB.outcome, "inserted_pending");
    const sameResults = await Promise.all([applyPendingInboxEvent(pool, sameA.eventId, NOW), applyPendingInboxEvent(pool, sameB.eventId, NOW)]);
    assert.equal(sameResults.length, 2);
    const nftSame = (await pool.query<any>("SELECT current_owner_address, last_transfer_transaction_hash, last_nft_event_timestamp::text FROM public.opensea_listings_nft_state_v2 WHERE token_id=$1", ["990000000003"])).rows[0];
    assert.equal(nftSame.current_owner_address, "0x4444444444444444444444444444444444444444");
    assert.equal(nftSame.last_transfer_transaction_hash, sameNftNewer.payload.transaction.hash);
    assert.equal(new Date(nftSame.last_nft_event_timestamp).toISOString(), "2026-08-11T04:25:00.000Z");
    record("same NFT different-event Tx B serialization");

    const mixedRaw = syntheticTransfer("990000000004", "5", "2026-08-11T04:26:00.000000Z", "1786422360", "1786422360000", "0x5555555555555555555555555555555555555555");
    const mixedInbox = await persistRawEventToInbox(pool, mixedRaw, RECEIVED_AT);
    let releaseHook!: () => void;
    let hookEntered!: () => void;
    const hookEnteredPromise = new Promise<void>((resolve) => { hookEntered = resolve; });
    const releaseHookPromise = new Promise<void>((resolve) => { releaseHook = resolve; });
    const mixedTxB = applyPendingInboxEvent(pool, mixedInbox.eventId, NOW, {
      beforeStateApplication: async () => {
        hookEntered();
        await releaseHookPromise;
      }
    });
    await hookEnteredPromise;
    const normalizedMixed = normalizeTransferEvent(mixedRaw, RECEIVED_AT);
    assert.ok(normalizedMixed);
    const atomic = applyNormalizedEvent(pool, normalizedMixed, NOW);
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseHook();
    const mixed = await Promise.allSettled([mixedTxB, atomic]);
    mixedDiagnostic = mixed.map((result) => result.status === "fulfilled" ? `fulfilled:${(result.value as any).result ?? (result.value as any).outcome}` : `rejected:${String(result.reason?.message ?? result.reason)}`).join(" | ");
    assert.ok(mixed.every((result) => result.status === "fulfilled" || /lock|deadlock|timeout/i.test(String(result.reason?.message ?? result.reason))));
    record("mixed atomic/TxB bounded diagnostic");

    return { cleanup, beforeProduction, afterProduction: beforeProduction, preExistingDisposable, createdDisposable, mixedDiagnostic };
  } finally {
    await pool.end();
    const cleanupResult = await dropDisposableDatabase();
    cleanup = cleanupResult.dropped ? "dropped" : cleanupResult.error ? `failed:${cleanupResult.error}` : "not_found";
    const afterProduction = await productionEvidence();
    assert.deepEqual(afterProduction.counts, beforeProduction.counts);
    assert.deepEqual(afterProduction.lifecycle, beforeProduction.lifecycle);
    assert.deepEqual(afterProduction.identity, beforeProduction.identity);
    assert.equal(afterProduction.signature, beforeProduction.signature);
    assert.equal(afterProduction.v1Exists, true);
    record("server_otg after preservation SELECT");
    (globalThis as any).__integrationAfterProduction = afterProduction;
    (globalThis as any).__integrationCleanup = cleanup;
  }
}

async function main(): Promise<void> {
  try {
    const summary = await run();
    const afterProduction = (globalThis as any).__integrationAfterProduction ?? summary.afterProduction;
    const cleanup = (globalThis as any).__integrationCleanup ?? summary.cleanup;
    console.log(JSON.stringify({
      result: "PASS",
      disposableDatabase: DISPOSABLE_DB,
      preExistingDisposable: summary.preExistingDisposable,
      createdDisposable: summary.createdDisposable,
      tests: integrationResults,
      testCount: integrationResults.length,
      mixedDiagnostic: summary.mixedDiagnostic,
      cleanup,
      serverOtgBefore: summary.beforeProduction,
      serverOtgAfter: afterProduction,
      preservationSignatureSql: SIGNATURE_SQL.trim()
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      result: "FAIL",
      message: error instanceof Error ? error.message : String(error),
      tests: integrationResults,
      testCount: integrationResults.length
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
