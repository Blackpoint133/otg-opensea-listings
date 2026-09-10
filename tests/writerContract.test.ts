import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { stringifyJsonb } from "../src/db/jsonb.js";
import { journalInputFromOrderEvent, insertJournalEvent } from "../src/db/eventJournalRepository.js";
import { upsertOrderState } from "../src/db/listingRepository.js";
import { normalizeOrderEvent, normalizeTransferEvent, normalizeUnknownRevalidate } from "../src/state/normalizers.js";
import { reduceOrderState } from "../src/state/orderReducer.js";
import { LiveEventWriter, normalizeWriterEvent } from "../src/writer/liveEventWriter.js";
import { assertLiveWriterCanStart, loadLiveWriterConfig, parseLiveWritesEnabled } from "../src/writer/writerConfig.js";
import { runWriterPreflight } from "../src/writer/preflight.js";
import type { DbPool, EventApplicationResult, QueryResult, TransactionClient } from "../src/db/types.js";
import type { NormalizedEventForApplication } from "../src/db/types.js";

const root = path.resolve(import.meta.dirname, "fixtures");
const real = (name: string): any => JSON.parse(fs.readFileSync(path.join(root, "real", name), "utf8"));
const synthetic = (): any => JSON.parse(fs.readFileSync(path.join(root, "synthetic_order_revalidate_unknown_shape.json"), "utf8"));
const receivedAt = "2026-08-10T00:00:00.000Z";
const now = "2026-08-10T00:00:00.000Z";

class FakePool implements DbPool {
  ended = false;
  queries: Array<{ text: string; values: readonly unknown[] }> = [];
  constructor(private readonly preflight = false) {}
  async connect(): Promise<TransactionClient> { throw new Error("connect should not be called by writer tests"); }
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (!this.preflight) throw new Error("pool.query should not be called");
    if (/current_database/.test(text)) return { rows: [{ database: "server_otg" }] as Row[], rowCount: 1 };
    if (/information_schema\.tables/.test(text)) {
      const table = values[1];
      return { rows: [{ exists: table !== "opensea_nft_state_v2" && table !== "opensea_listing_events_v2" }] as Row[], rowCount: 1 };
    }
    if (/information_schema\.columns/.test(text) && Array.isArray(values[2])) return { rows: [
      { column_name: "processing_status", data_type: "text", is_nullable: "NO" },
      { column_name: "attempt_count", data_type: "integer", is_nullable: "NO" },
      { column_name: "processing_started_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "last_attempt_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "next_retry_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "last_error_code", data_type: "text", is_nullable: "YES" },
      { column_name: "last_error_message", data_type: "text", is_nullable: "YES" }
    ] as Row[], rowCount: 7 };
    if (/information_schema\.columns/.test(text) && values[2] === "event_timestamp") return { rows: [{ is_nullable: "YES" }] as Row[], rowCount: 1 };
    if (/information_schema\.columns/.test(text) && values[2] === "received_at") return { rows: [{ is_nullable: "NO" }] as Row[], rowCount: 1 };
    if (/information_schema\.columns/.test(text) && values[2] === "processing_status") return { rows: [{ is_nullable: "NO" }] as Row[], rowCount: 1 };
    if (/information_schema\.columns/.test(text) && values[2] === "attempt_count") return { rows: [{ is_nullable: "NO" }] as Row[], rowCount: 1 };
    if (/constraint_type='UNIQUE'/.test(text)) return { rows: [{ exists: true }] as Row[], rowCount: 1 };
    if (/constraint_type='PRIMARY KEY'/.test(text) && values[1] === "opensea_listings_v2") return { rows: [{ column_name: "order_hash" }] as Row[], rowCount: 1 };
    if (/constraint_type='PRIMARY KEY'/.test(text) && values[1] === "opensea_listings_nft_state_v2") return { rows: [{ column_name: "chain" }, { column_name: "contract_address" }, { column_name: "token_id" }] as Row[], rowCount: 3 };
    if (/pg_get_constraintdef/.test(text) && values[2] === "opensea_listings_events_v2_processing_status_check") return { rows: [{ definition: "CHECK (processing_status IN ('pending','processing','applied','reconciliation_required','failed','ignored_duplicate','ignored_older'))" }] as Row[], rowCount: 1 };
    if (/pg_get_constraintdef/.test(text) && values[2] === "opensea_listings_events_v2_attempt_count_check") return { rows: [{ definition: "CHECK (attempt_count >= 0)" }] as Row[], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
  async end(): Promise<void> { this.ended = true; }
}

class FakeClient implements TransactionClient {
  calls: Array<{ text: string; values: readonly unknown[] }> = [];
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    if (/INSERT INTO public\.opensea_listings_events_v2/.test(text)) return { rows: [{ event_id: "1" }] as Row[], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
  release(): void {}
}

function config(enabled = true, explicit = true) {
  return { liveWritesEnabled: enabled, explicitWriterMode: explicit, maxConcurrency: 1 };
}

function resultFor(event: NormalizedEventForApplication): EventApplicationResult {
  return {
    dedupeKey: `dedupe:${event.eventType}`,
    eventType: event.eventType,
    orderHash: "orderHash" in event ? event.orderHash : null,
    nftId: event.nft?.nftId ?? null,
    result: "applied",
    applyResult: "applied",
    reconciliationRequired: false,
    stateChanged: true,
    journalEventId: "1"
  };
}

test("live writer flag is disabled by default and strictly opt-in", () => {
  assert.equal(parseLiveWritesEnabled(undefined), false);
  assert.equal(parseLiveWritesEnabled(""), false);
  assert.equal(parseLiveWritesEnabled("false"), false);
  assert.equal(parseLiveWritesEnabled("0"), false);
  assert.equal(parseLiveWritesEnabled("maybe"), false);
  assert.equal(parseLiveWritesEnabled("true"), true);
  assert.equal(parseLiveWritesEnabled("1"), true);
  assert.equal(loadLiveWriterConfig({}, false).liveWritesEnabled, false);
});

test("double opt-in is required before writer construction or preflight", async () => {
  assert.throws(() => assertLiveWriterCanStart(config(false, true)), /enabled/);
  assert.throws(() => assertLiveWriterCanStart(config(true, false)), /explicit mode/);
  assert.doesNotThrow(() => assertLiveWriterCanStart(config(true, true)));
  assert.throws(() => new LiveEventWriter({ pool: new FakePool(), config: config(false, true) }), /enabled/);
  await assert.rejects(() => runWriterPreflight(new FakePool(true), config(true, false)), /explicit mode/);
});

test("importing and constructing writer with fake pool does not connect to DB", () => {
  const pool = new FakePool();
  const writer = new LiveEventWriter({ pool, config: config(true, true), applyEvent: async (_pool, event) => resultFor(event) });
  assert.equal(pool.ended, false);
  assert.equal(pool.queries.length, 0);
  assert.ok(writer);
});

test("existing probe and index source do not instantiate repository writer", () => {
  const streamProbe = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "streamProbe.ts"), "utf8");
  const index = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.doesNotMatch(streamProbe, /applyNormalizedEvent|createDatabasePool|LiveEventWriter/);
  assert.doesNotMatch(index, /applyNormalizedEvent|createDatabasePool|LiveEventWriter/);
});

test("writer routes every contracted event family through normalizer and repository applicator", async () => {
  const fixtures = [
    real("item_listed_ordinary.json"),
    real("item_cancelled_1.json"),
    real("item_sold_1.json"),
    real("item_transferred_zero_source.json"),
    real("order_invalidate_1.json"),
    synthetic()
  ];
  const seen: NormalizedEventForApplication[] = [];
  const writer = new LiveEventWriter({
    pool: new FakePool(),
    config: config(true, true),
    applyEvent: async (_pool, event) => { seen.push(event); return resultFor(event); },
    now: () => now
  });
  for (const raw of fixtures) {
    const output = await writer.handleEvent(raw, receivedAt);
    assert.equal(output.result, "applied");
  }
  assert.deepEqual(seen.map((event) => event.eventType), ["item_listed", "item_cancelled", "item_sold", "item_transferred", "order_invalidate", "order_revalidate"]);
  assert.equal(seen[0].rawPayload, fixtures[0]);
});

test("unsupported event is ignored and does not call repository", async () => {
  let calls = 0;
  const writer = new LiveEventWriter({ pool: new FakePool(), config: config(true, true), applyEvent: async (_pool, event) => { calls += 1; return resultFor(event); } });
  const output = await writer.handleEvent({ event_type: "item_received_offer", payload: {} }, receivedAt);
  assert.equal(output.result, "ignored_unsupported_type");
  assert.equal(calls, 0);
});

test("normalization failure is explicit and does not call repository", async () => {
  let calls = 0;
  const writer = new LiveEventWriter({
    pool: new FakePool(),
    config: config(true, true),
    normalizeEvent: () => null,
    applyEvent: async (_pool, event) => { calls += 1; return resultFor(event); }
  });
  const output = await writer.handleEvent(real("item_listed_ordinary.json"), receivedAt);
  assert.equal(output.result, "normalization_failed");
  assert.equal(calls, 0);
});

test("repository duplicate and reconciliation results are propagated", async () => {
  const duplicateWriter = new LiveEventWriter({
    pool: new FakePool(),
    config: config(true, true),
    applyEvent: async (_pool, event) => ({ ...resultFor(event), result: "duplicate_ignored", applyResult: "duplicate_ignored", stateChanged: false, journalEventId: null })
  });
  assert.equal((await duplicateWriter.handleEvent(real("item_listed_ordinary.json"), receivedAt)).result, "duplicate_ignored");
  const reconciliationWriter = new LiveEventWriter({
    pool: new FakePool(),
    config: config(true, true),
    applyEvent: async (_pool, event) => ({ ...resultFor(event), result: "journaled_reconciliation_required", reconciliationRequired: true })
  });
  const output = await reconciliationWriter.handleEvent(real("order_invalidate_1.json"), receivedAt);
  assert.equal(output.result, "journaled_reconciliation_required");
  assert.equal(output.reconciliationRequired, true);
});

test("repository failure is surfaced with sanitized writer result and no retry", async () => {
  let calls = 0;
  const writer = new LiveEventWriter({
    pool: new FakePool(),
    config: config(true, true),
    applyEvent: async () => { calls += 1; throw new Error("postgres failed password=secret token=abc"); }
  });
  await assert.rejects(async () => writer.handleEvent(real("item_listed_ordinary.json"), receivedAt), (error: any) => {
    assert.equal(calls, 1);
    assert.equal(error.writerResult.result, "failed");
    assert.doesNotMatch(error.writerResult.errorMessage, /secret|abc/);
    return true;
  });
});

test("shutdown waits for in-flight work and closes pool", async () => {
  const pool = new FakePool();
  let release!: () => void;
  const writer = new LiveEventWriter({
    pool,
    config: config(true, true),
    applyEvent: async (_pool, event) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return resultFor(event);
    }
  });
  const pending = writer.handleEvent(real("item_listed_ordinary.json"), receivedAt);
  const closed = writer.shutdown();
  release();
  await pending;
  await closed;
  assert.equal(pool.ended, true);
  await assert.rejects(() => writer.handleEvent(real("item_listed_ordinary.json"), receivedAt), /closed/);
});

test("BigInt-safe JSONB serialization preserves ordinary JSON semantics and BigInt text", () => {
  const ordinary = real("item_listed_ordinary.json");
  assert.deepEqual(JSON.parse(stringifyJsonb(ordinary)), ordinary);
  const value = { a: 1n, nested: { b: 9007199254740993n }, array: [2n] };
  const before = structuredClone(value);
  const parsed = JSON.parse(stringifyJsonb(value));
  assert.deepEqual(parsed, { a: "1", nested: { b: "9007199254740993" }, array: ["2"] });
  assert.deepEqual(value, before);
});

test("repository journal and raw_last_event use BigInt-safe serializer", async () => {
  const raw = real("item_listed_ordinary.json");
  raw.version = 9007199254740993n;
  const event = normalizeOrderEvent(raw, receivedAt)!;
  const input = journalInputFromOrderEvent(event);
  const client = new FakeClient();
  await insertJournalEvent(client, input);
  assert.equal(JSON.parse(client.calls[0].values[12] as string).version, "9007199254740993");
  const state = reduceOrderState(null, event, now).state!;
  await upsertOrderState(client, state);
  const upsert = client.calls.find((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text))!;
  assert.equal(JSON.parse(upsert.values[32] as string).version, "9007199254740993");
});

test("preflight checks schema contract and does not require zero rows", async () => {
  const pool = new FakePool(true);
  const result = await runWriterPreflight(pool, config(true, true));
  assert.equal(result.database, "server_otg");
  assert.equal(result.journalEventTimestampNullable, true);
  assert.equal(result.journalReceivedAtNotNull, true);
  assert.equal(result.journalDedupeKeyUnique, true);
  assert.equal(result.journalLifecycleColumnsPresent, true);
  assert.equal(result.journalProcessingStatusNotNull, true);
  assert.equal(result.journalAttemptCountNotNull, true);
  assert.equal(result.journalProcessingStatusCheck, true);
  assert.equal(result.journalAttemptCountCheck, true);
  assert.equal(result.orderHashPrimaryKey, true);
  assert.equal(result.nftCompoundPrimaryKey, true);
  assert.equal(result.obsoleteTablesAbsent, true);
  assert.equal(pool.queries.some((query) => /COUNT\(\*\)/.test(query.text)), false);
});

test("normalizeWriterEvent preserves defensive routing behavior", () => {
  assert.equal(normalizeWriterEvent({ event_type: "unknown" }, receivedAt), null);
  assert.equal(normalizeWriterEvent(real("item_transferred_zero_source.json"), receivedAt)?.eventType, "item_transferred");
  assert.equal(normalizeWriterEvent(synthetic(), receivedAt)?.eventType, "order_revalidate");
});
