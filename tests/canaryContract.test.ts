import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadCanaryConfig, parseCanaryEnabled, assertCanaryCanStart, type CanaryConfig } from "../src/canary/canaryConfig.js";
import { runLiveCanary } from "../src/canary/liveCanary.js";
import { runLiveCanaryCli, type SignalRegistrar } from "../src/canary/runLiveCanary.js";
import { SerializedEventSink } from "../src/canary/serializedEventSink.js";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import type { WriterResult } from "../src/writer/types.js";

const apiEnv = { OPENSEA_API_KEY: "test-key" };

class FakePool implements DbPool {
  ended = false;
  queries: Array<{ text: string; values: readonly unknown[] }> = [];
  runtimeLockAvailable = true;
  runtimeLockHeld = false;
  constructor(private readonly database = "server_otg", private readonly counts = { orders: "0", nfts: "0", events: "0", unfinalized: "0", active: "0", reconciliation: "0", v1Rows: "10" }) {}
  async connect(): Promise<TransactionClient> {
    const pool = this;
    return {
      async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
        pool.queries.push({ text, values });
        if (/pg_try_advisory_lock/.test(text)) {
          pool.runtimeLockHeld = pool.runtimeLockAvailable;
          return { rows: [{ acquired: pool.runtimeLockAvailable }] as Row[], rowCount: 1 };
        }
        if (/pg_advisory_unlock/.test(text)) {
          const unlocked = pool.runtimeLockHeld;
          pool.runtimeLockHeld = false;
          return { rows: [{ unlocked }] as Row[], rowCount: 1 };
        }
        return pool.query<Row>(text, values);
      },
      release(): void {}
    };
  }
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (/current_database/.test(text)) return { rows: [{ database: this.database }] as Row[], rowCount: 1 };
    if (/information_schema\.tables/.test(text)) return { rows: [{ exists: values[1] !== "opensea_nft_state_v2" && values[1] !== "opensea_listing_events_v2" }] as Row[], rowCount: 1 };
    if (/key_column_usage/.test(text) && values[1] === "opensea_listings") return { rows: [{ column_name: "order_hash" }] as Row[], rowCount: 1 };
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
    if (/information_schema\.columns/.test(text) && values[0] === "public" && values[1] === "opensea_listings") return { rows: [{ count: "33" }] as Row[], rowCount: 1 };
    if (/constraint_type='UNIQUE'/.test(text)) return { rows: [{ exists: true }] as Row[], rowCount: 1 };
    if (/constraint_type='PRIMARY KEY'/.test(text) && values[1] === "opensea_listings_v2") return { rows: [{ column_name: "order_hash" }] as Row[], rowCount: 1 };
    if (/constraint_type='PRIMARY KEY'/.test(text) && values[1] === "opensea_listings_nft_state_v2") return { rows: [{ column_name: "chain" }, { column_name: "contract_address" }, { column_name: "token_id" }] as Row[], rowCount: 3 };
    if (/pg_get_constraintdef/.test(text) && values[2] === "opensea_listings_events_v2_processing_status_check") return { rows: [{ definition: "CHECK (processing_status IN ('pending','processing','applied','reconciliation_required','failed','ignored_duplicate','ignored_older'))" }] as Row[], rowCount: 1 };
    if (/pg_get_constraintdef/.test(text) && values[2] === "opensea_listings_events_v2_attempt_count_check") return { rows: [{ definition: "CHECK (attempt_count >= 0)" }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::text AS count FROM public\.opensea_listings_v2 WHERE status='active'/.test(text)) return { rows: [{ count: this.counts.active }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::text AS count FROM public\.opensea_listings_v2 WHERE needs_reconciliation=true/.test(text)) return { rows: [{ count: this.counts.reconciliation }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::text AS count FROM public\.opensea_listings_v2/.test(text)) return { rows: [{ count: this.counts.orders }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::text AS count FROM public\.opensea_listings_nft_state_v2/.test(text)) return { rows: [{ count: this.counts.nfts }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::text AS count FROM public\.opensea_listings_events_v2 WHERE apply_result IS NULL/.test(text)) return { rows: [{ count: this.counts.unfinalized }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::text AS count FROM public\.opensea_listings_events_v2/.test(text)) return { rows: [{ count: this.counts.events }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::text AS count FROM public\.opensea_listings$/.test(text)) return { rows: [{ count: this.counts.v1Rows }] as Row[], rowCount: 1 };
    return { rows: [] as Row[], rowCount: 0 };
  }
  async end(): Promise<void> { this.ended = true; }
}

function config(overrides: Partial<CanaryConfig> = {}): CanaryConfig {
  return {
    canaryEnabled: true,
    durationMs: 60_000,
    maxEvents: 10,
    queueCapacity: 10,
    writerConcurrency: 1,
    collectionSlug: "off-the-grid",
    apiKey: "test-key",
    localStorageDir: "unused",
    liveWriterConfig: { liveWritesEnabled: true, explicitWriterMode: true, maxConcurrency: 1 },
    ...overrides
  };
}

class FakeSignals implements SignalRegistrar {
  handlers = new Map<NodeJS.Signals, () => void>();
  once(signal: NodeJS.Signals, listener: () => void): void { this.handlers.set(signal, listener); }
  off(signal: NodeJS.Signals, listener: () => void): void { if (this.handlers.get(signal) === listener) this.handlers.delete(signal); }
  emit(signal: NodeJS.Signals): void { this.handlers.get(signal)?.(); }
}

function writerResult(result: WriterResult["result"] = "applied"): WriterResult {
  return {
    eventType: "item_listed",
    dedupeKey: "dedupe",
    result,
    applyResult: result,
    orderHash: "0xabc",
    nftId: "ethereum/0xabc/1",
    stateChanged: result === "applied",
    reconciliationRequired: result === "journaled_reconciliation_required",
    journalEventId: result === "duplicate_ignored" ? null : "1",
    durationMs: 1
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("canary flag is disabled by default and strictly opt-in", () => {
  assert.equal(parseCanaryEnabled(undefined), false);
  assert.equal(parseCanaryEnabled(""), false);
  assert.equal(parseCanaryEnabled("false"), false);
  assert.equal(parseCanaryEnabled("0"), false);
  assert.equal(parseCanaryEnabled("maybe"), false);
  assert.equal(parseCanaryEnabled("true"), true);
  assert.equal(parseCanaryEnabled("1"), true);
});

test("triple gate allows startup only when all three safety signals are true", () => {
  for (const canaryEnabled of [false, true]) {
    for (const liveWritesEnabled of [false, true]) {
      for (const explicitWriterMode of [false, true]) {
        const candidate = config({ canaryEnabled, liveWriterConfig: { liveWritesEnabled, explicitWriterMode, maxConcurrency: 1 } });
        const allowed = canaryEnabled && liveWritesEnabled && explicitWriterMode;
        if (allowed) assert.doesNotThrow(() => assertCanaryCanStart(candidate));
        else assert.throws(() => assertCanaryCanStart(candidate));
      }
    }
  }
});

test("canary config validates bounded duration max events and queue capacity", () => {
  const loaded = loadCanaryConfig(["--duration-minutes", "5", "--max-events", "100", "--queue-capacity", "50"], { ...apiEnv, OPENSEA_V2_LIVE_WRITES_ENABLED: "true", OPENSEA_V2_CANARY_ENABLED: "true" }, true);
  assert.equal(loaded.durationMs, 300_000);
  assert.equal(loaded.maxEvents, 100);
  assert.equal(loaded.queueCapacity, 50);
  assert.equal(loadCanaryConfig([], { ...apiEnv, OPENSEA_V2_LIVE_WRITES_ENABLED: "true", OPENSEA_V2_CANARY_ENABLED: "true" }, true).maxEvents, 25);
  assert.equal("expectedDatabase" in loadCanaryConfig([], { ...apiEnv, OPENSEA_V2_LIVE_WRITES_ENABLED: "true", OPENSEA_V2_CANARY_ENABLED: "true", OPENSEA_V2_EXPECTED_DATABASE: "wrong_db" }, true), false);
  assert.throws(() => loadCanaryConfig(["--duration-minutes", "0"], apiEnv, true), /duration-minutes/);
  assert.throws(() => loadCanaryConfig(["--max-events", "1001"], apiEnv, true), /max-events/);
  assert.throws(() => loadCanaryConfig(["--queue-capacity", "0"], apiEnv, true), /queue-capacity/);
});

test("preflight enforces expected database before stream subscription", async () => {
  let streamCreated = false;
  const summary = await runLiveCanary(config(), {
    createPool: () => new FakePool("wrong_db"),
    createStream: () => { streamCreated = true; throw new Error("stream must not be created"); }
  });
  assert.equal(summary.outcome, "CANARY_FAILED");
  assert.equal(streamCreated, false);
});

test("server_otg cannot be overridden by env or normal config", async () => {
  const loaded = loadCanaryConfig([], { ...apiEnv, OPENSEA_V2_LIVE_WRITES_ENABLED: "true", OPENSEA_V2_CANARY_ENABLED: "true", OPENSEA_V2_EXPECTED_DATABASE: "wrong_db" }, true);
  assert.equal("expectedDatabase" in loaded, false);
  const summary = await runLiveCanary(config(), {
    createPool: () => new FakePool("wrong_db"),
    createStream: () => { throw new Error("stream must not start"); }
  });
  assert.equal(summary.outcome, "CANARY_FAILED");
  assert.equal(summary.preflightPassed, false);
});

test("startup order is preflight before stream subscription and event admission", async () => {
  const order: string[] = [];
  let shutdowns = 0;
  const summary = await runLiveCanary(config({ maxEvents: 1 }), {
    createPool: () => new FakePool(),
    runPreflight: async () => { order.push("preflight"); return { database: "server_otg", tables: {}, journalEventTimestampNullable: true, journalReceivedAtNotNull: true, journalDedupeKeyUnique: true, orderHashPrimaryKey: true, nftCompoundPrimaryKey: true, obsoleteTablesAbsent: true }; },
    createWriter: () => ({ handleEvent: async () => { order.push("writer"); return writerResult(); }, shutdown: async () => { shutdowns += 1; } } as any),
    createStream: () => ({
      onEvents: (_collection, _events, callback) => { order.push("subscribe"); console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); callback({ event_type: "item_listed" }); return () => { order.push("unsubscribe"); }; },
      disconnect: (callback?: () => void) => { order.push("disconnect"); callback?.(); }
    }),
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  assert.equal(order[0], "preflight");
  assert.ok(order.indexOf("subscribe") > order.indexOf("preflight"));
  assert.ok(order.indexOf("writer") > order.indexOf("subscribe"));
  assert.equal(summary.preflightPassed, true);
  assert.equal(summary.transport.channel_join_confirmed, true);
  assert.equal(summary.shutdownClean, true);
  assert.equal(shutdowns, 1);
});

test("first canary empty V2 baseline gate allows only 0/0/0 before stream creation", async () => {
  const allowedOrder: string[] = [];
  const allowed = await runLiveCanary(config({ maxEvents: 1 }), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => { allowedOrder.push("writer"); return writerResult(); }, shutdown: async () => {} } as any),
    createStream: () => ({
      onEvents: (_collection, _events, callback) => { allowedOrder.push("subscribe"); console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); callback({ event_type: "item_listed" }); return () => {}; },
      disconnect: (callback?: () => void) => callback?.()
    }),
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  assert.equal(allowed.outcome, "CANARY_PIPELINE_OBSERVED");
  assert.ok(allowedOrder.includes("subscribe"));
  assert.ok(allowedOrder.includes("writer"));

  const cases = [
    { name: "listings", counts: { orders: "1", nfts: "0", events: "0", unfinalized: "0", active: "0", reconciliation: "0", v1Rows: "10" }, diagnostic: "listings=1,nft_state=0,events=0" },
    { name: "nft_state", counts: { orders: "0", nfts: "1", events: "0", unfinalized: "0", active: "0", reconciliation: "0", v1Rows: "10" }, diagnostic: "listings=0,nft_state=1,events=0" },
    { name: "events", counts: { orders: "0", nfts: "0", events: "1", unfinalized: "0", active: "0", reconciliation: "0", v1Rows: "10" }, diagnostic: "listings=0,nft_state=0,events=1" },
    { name: "multiple", counts: { orders: "1", nfts: "2", events: "3", unfinalized: "0", active: "0", reconciliation: "0", v1Rows: "10" }, diagnostic: "listings=1,nft_state=2,events=3" }
  ];

  for (const testCase of cases) {
    let streamCreated = 0;
    let writerCreated = 0;
    let pools = 0;
    const summary = await runLiveCanary(config(), {
      createPool: () => { pools += 1; return new FakePool("server_otg", testCase.counts); },
      createWriter: () => { writerCreated += 1; throw new Error("writer must not be created"); },
      createStream: () => { streamCreated += 1; throw new Error("stream must not be created"); }
    });
    assert.equal(summary.outcome, "CANARY_FAILED", testCase.name);
    assert.equal(summary.stopReason, "first_canary_non_empty_v2", testCase.name);
    assert.equal(streamCreated, 0, testCase.name);
    assert.equal(writerCreated, 0, testCase.name);
    assert.ok(pools >= 2, testCase.name);
    assert.ok(summary.preRunVerification, testCase.name);
    assert.ok(summary.postRunVerification, testCase.name);
    assert.equal(summary.preRunVerification?.v2Counts.opensea_listings_v2, testCase.counts.orders, testCase.name);
    assert.equal(summary.preRunVerification?.v2Counts.opensea_listings_nft_state_v2, testCase.counts.nfts, testCase.name);
    assert.equal(summary.preRunVerification?.v2Counts.opensea_listings_events_v2, testCase.counts.events, testCase.name);
    assert.match(summary.sanitizedErrors.join(" "), new RegExp(`first_canary_non_empty_v2:${testCase.diagnostic}`), testCase.name);
  }
});

test("legacy atomic canary acquires runtime guard before writer and stream activity", async () => {
  const pool = new FakePool();
  pool.runtimeLockAvailable = false;
  let writerCreated = 0;
  let streamCreated = 0;
  const summary = await runLiveCanary(config(), {
    createPool: () => pool,
    createWriter: () => { writerCreated += 1; throw new Error("writer must not start"); },
    createStream: () => { streamCreated += 1; throw new Error("stream must not start"); }
  });
  assert.equal(summary.outcome, "CANARY_FAILED");
  assert.equal(writerCreated, 0);
  assert.equal(streamCreated, 0);
  assert.equal(pool.queries.some((query) => /pg_try_advisory_lock/.test(query.text)), true);
});

test("serialized sink enforces one writer call at a time", async () => {
  let releaseFirst!: () => void;
  let started = 0;
  let active = 0;
  const sink = new SerializedEventSink({
    queueCapacity: 10,
    maxEvents: 10,
    handleEvent: async () => {
      started += 1;
      active += 1;
      assert.equal(active, 1);
      if (started === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      active -= 1;
      return writerResult();
    }
  });
  assert.equal(sink.enqueue({ id: 1 }).accepted, true);
  assert.equal(sink.enqueue({ id: 2 }).accepted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  releaseFirst();
  await sink.drain();
  assert.equal(started, 2);
  assert.equal(sink.snapshot().maxConcurrentWriterCallsObserved, 1);
});

test("queue capacity overflow is visible, fatal, and does not silently drop as success", async () => {
  let release!: () => void;
  let calls = 0;
  let stopped: string | null = null;
  const sink = new SerializedEventSink({
    queueCapacity: 2,
    maxEvents: 10,
    handleEvent: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return writerResult();
    },
    onStopRequested: (reason) => { stopped = reason; }
  });
  assert.equal(sink.enqueue({ id: 1 }).accepted, true);
  assert.equal(sink.enqueue({ id: 2 }).accepted, true);
  assert.equal(sink.enqueue({ id: 3 }).accepted, true);
  const overflow = sink.enqueue({ id: 4 });
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, "queue_overflow");
  assert.equal(stopped, "queue_overflow");
  assert.equal(sink.snapshot().queueOverflowCount, 1);
  release();
  await sink.drain();
  assert.equal(calls, 1);
});

test("max event limit stops admission and drains accepted work", async () => {
  const sink = new SerializedEventSink({ queueCapacity: 10, maxEvents: 2, handleEvent: async () => writerResult() });
  assert.equal(sink.enqueue({ id: 1 }).accepted, true);
  assert.equal(sink.enqueue({ id: 2 }).accepted, true);
  assert.equal(sink.enqueue({ id: 3 }).accepted, false);
  await sink.drain();
  const snapshot = sink.snapshot();
  assert.equal(snapshot.eventsAccepted, 2);
  assert.equal(snapshot.eventsProcessed, 2);
  assert.equal(snapshot.stopReason, "max_events_reached");
});

test("duration limit requests normal controlled shutdown without real-time wait", async () => {
  let durationCallback!: () => void;
  let streamSubscribed = false;
  const summaryPromise = runLiveCanary(config(), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => writerResult(), shutdown: async () => {} } as any),
    createStream: () => ({ onEvents: () => { streamSubscribed = true; console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); return () => {}; }, disconnect: (callback?: () => void) => callback?.() }),
    setTimer: (callback, delay) => { if (delay === 60_000) durationCallback = callback; return `timer:${delay}`; },
    clearTimer: () => {}
  });
  await waitFor(() => typeof durationCallback === "function" && streamSubscribed);
  durationCallback();
  const summary = await summaryPromise;
  assert.equal(summary.sink.stopReason, "duration_reached");
  assert.equal(summary.outcome, "CANARY_INFRASTRUCTURE_PASS_NO_EVENTS");
  assert.equal(summary.configuredDurationMinutes, 1);
  assert.equal(summary.configuredMaxEvents, 10);
  assert.equal(summary.configuredQueueCapacity, 10);
  assert.equal(summary.configuredConcurrency, 1);
  assert.equal(summary.preRunVerification?.v1.exists, true);
  assert.deepEqual(summary.preRunVerification?.v1.primaryKey, ["order_hash"]);
  assert.equal(summary.postRunVerification?.v1.columnCount, "33");
  assert.equal(summary.shutdownClean, true);
});

test("readiness timeout without join is failed zero-event classification", async () => {
  const summaryPromise = runLiveCanary(config(), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => writerResult(), shutdown: async () => {} } as any),
    createStream: () => ({ onEvents: () => () => {}, disconnect: (callback?: () => void) => callback?.() }),
    setTimer: (callback, delay) => { if (delay === 1) queueMicrotask(callback); return { delay }; },
    clearTimer: () => {},
    readinessTimeoutMs: 1
  });
  const summary = await summaryPromise;
  assert.equal(summary.sink.stopReason, "stream_readiness_timeout");
  assert.equal(summary.outcome, "CANARY_FAILED");
});

test("join error is captured from SDK console and is fatal", async () => {
  const summary = await runLiveCanary(config(), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => writerResult(), shutdown: async () => {} } as any),
    createStream: () => ({
      onEvents: () => { console.error('[ERROR]: Failed to join channel "collection:off-the-grid"'); return () => {}; },
      disconnect: (callback?: () => void) => callback?.()
    }),
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  assert.equal(summary.transport.join_error_detected, true);
  assert.equal(summary.outcome, "CANARY_FAILED");
});

test("pipeline observed requires joined stream and processed writer event", async () => {
  const summary = await runLiveCanary(config({ maxEvents: 1 }), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => writerResult("journaled_reconciliation_required"), shutdown: async () => {} } as any),
    createStream: () => ({
      onEvents: (_collection, _events, callback) => { console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); callback({ event_type: "order_invalidate" }); return () => {}; },
      disconnect: (callback?: () => void) => callback?.()
    }),
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  assert.equal(summary.outcome, "CANARY_PIPELINE_OBSERVED");
  assert.equal(summary.sink.eventsProcessed, 1);
});

test("stream callback contains enqueue errors and requests controlled shutdown", async () => {
  const summary = await runLiveCanary(config(), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => writerResult(), shutdown: async () => {} } as any),
    createStream: () => ({
      onEvents: (_collection, _events, callback) => { console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); callback({ event_type: "item_listed" }); return () => {}; },
      disconnect: (callback?: () => void) => callback?.()
    }),
    setTimer: (callback, delay) => { if (delay === 60_000) queueMicrotask(callback); return `timer:${delay}`; },
    clearTimer: () => {}
  });
  assert.equal(summary.shutdownClean, true);
});

test("canary shutdown is wrapper-idempotent for simultaneous stop requests", async () => {
  let writerShutdowns = 0;
  let disconnects = 0;
  let timerCallback!: () => void;
  const summaryPromise = runLiveCanary(config({ maxEvents: 1 }), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => writerResult(), shutdown: async () => { writerShutdowns += 1; } } as any),
    createStream: () => ({
      onEvents: (_collection, _events, callback) => { console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); callback({ event_type: "item_listed" }); return () => {}; },
      disconnect: (callback?: () => void) => { disconnects += 1; callback?.(); }
    }),
    setTimer: (callback, delay) => { if (delay === 60_000) timerCallback = callback; return `timer:${delay}`; },
    clearTimer: () => {}
  });
  await waitFor(() => typeof timerCallback === "function");
  timerCallback();
  const summary = await summaryPromise;
  assert.equal(summary.shutdownClean, true);
  assert.equal(writerShutdowns, 1);
  assert.equal(disconnects, 1);
});

test("post-run verification runs after writer failure and verification failure makes outcome failed", async () => {
  let pools = 0;
  const summary = await runLiveCanary(config({ maxEvents: 2 }), {
    createPool: () => { pools += 1; return new FakePool("server_otg", pools === 2 ? { orders: "1", nfts: "0", events: "1", unfinalized: "1", active: "0", reconciliation: "0", v1Rows: "10" } : undefined as any); },
    createWriter: () => ({ handleEvent: async () => { throw new Error("postgres failed password=secret"); }, shutdown: async () => {} } as any),
    createStream: () => ({
      onEvents: (_collection, _events, callback) => { console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); callback({ event_type: "item_listed" }); return () => {}; },
      disconnect: (callback?: () => void) => callback?.()
    }),
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  assert.ok(summary.preRunVerification);
  assert.ok(summary.postRunVerification);
  assert.equal(summary.postRunVerification.unfinalizedJournalCount, "1");
  assert.equal(summary.outcome, "CANARY_FAILED");
  assert.match(summary.sanitizedErrors.join(" "), /writer_error|postgres/);
  assert.doesNotMatch(summary.sanitizedErrors.join(" "), /secret/);
});

test("default timer is cleared on early stop and cannot fire later", async () => {
  let stored: (() => void) | null = null;
  let cleared = false;
  const summaryPromise = runLiveCanary(config({ maxEvents: 1 }), {
    createPool: () => new FakePool(),
    createWriter: () => ({ handleEvent: async () => writerResult(), shutdown: async () => {} } as any),
    createStream: () => ({
      onEvents: (_collection, _events, callback) => { console.info('[INFO]: Successfully joined channel "collection:off-the-grid"'); callback({ event_type: "item_listed" }); return () => {}; },
      disconnect: (callback?: () => void) => callback?.()
    }),
    setTimer: (callback) => { stored = callback; return "timer"; },
    clearTimer: () => { cleared = true; stored = null; }
  });
  const summary = await summaryPromise;
  assert.equal(cleared, true);
  stored?.();
  assert.equal(summary.stopReason, "max_events_reached");
});

test("SIGINT and SIGTERM trigger controlled cleanup and handlers are removed", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as NodeJS.Signals[]) {
    const signals = new FakeSignals();
    let sawAbort = false;
    const run = runLiveCanaryCli({
      argv: [],
      env: { ...apiEnv, OPENSEA_V2_LIVE_WRITES_ENABLED: "true", OPENSEA_V2_CANARY_ENABLED: "true" },
      signals,
      stdout: { write: () => true } as any,
      stderr: { write: () => true } as any,
      runCanary: async (_config, abortSignal) => {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
        });
        return {
          startTime: "2026-08-10T00:00:00.000Z",
          endTime: "2026-08-10T00:00:01.000Z",
          durationMs: 1000,
          stopReason: signal === "SIGTERM" ? "signal_terminate" : "signal_interrupt",
          outcome: "CANARY_FAILED",
          configuredDurationMinutes: 5,
          configuredMaxEvents: 25,
          configuredQueueCapacity: 100,
          configuredConcurrency: 1,
          readinessTimeoutMs: 30000,
          preflightDatabase: "server_otg",
          preflightPassed: true,
          shutdownClean: true,
          transport: { subscription_registered: true, socket_activity_detected: false, channel_join_confirmed: false, join_error_detected: false, first_event_received: false, firstEventReceivedAt: null, stream_error_count: 0, last_stream_error: null },
          sink: { state: "stopped", eventsReceived: 0, eventsAccepted: 0, eventsProcessed: 0, eventsApplied: 0, duplicates: 0, reconciliationRequired: 0, unsupported: 0, normalizationFailed: 0, errors: 0, queueHighWaterMark: 0, queueOverflowCount: 0, maxConcurrentWriterCallsObserved: 0, lastErrorMessage: null, stopReason: signal === "SIGTERM" ? "signal_terminate" : "signal_interrupt" },
          preRunVerification: null,
          postRunVerification: null,
          delta: null,
          sanitizedErrors: []
        };
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    signals.emit(signal);
    const result = await run;
    assert.equal(result.exitCode, 1);
    assert.equal(sawAbort, true);
    assert.equal(signals.handlers.size, 0);
  }
});

test("CLI redacts secret-bearing startup errors", async () => {
  let stderr = "";
  const result = await runLiveCanaryCli({
    argv: [],
    env: { ...apiEnv, OPENSEA_V2_LIVE_WRITES_ENABLED: "true", OPENSEA_V2_CANARY_ENABLED: "true" },
    signals: new FakeSignals(),
    stdout: { write: () => true } as any,
    stderr: { write: (chunk: string) => { stderr += chunk; return true; } } as any,
    runCanary: async () => { throw new Error("postgres failed password=secret OPENSEA_API_KEY=abc token=def"); }
  });
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(stderr, /secret|abc|def/);
  assert.match(stderr, /<REDACTED>/);
});

test("existing probe and index remain diagnostic and do not import canary or writer", () => {
  const streamProbe = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "streamProbe.ts"), "utf8");
  const index = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.doesNotMatch(streamProbe, /runLiveCanary|SerializedEventSink|LiveEventWriter|applyNormalizedEvent|createDatabasePool/);
  assert.doesNotMatch(index, /runLiveCanary|SerializedEventSink|LiveEventWriter|applyNormalizedEvent|createDatabasePool/);
});

test("package canary script performs explicit fresh build and is not used by build or test", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.precanary, "npm run build");
  assert.equal(pkg.scripts.canary, "node dist/canary/runLiveCanary.js");
  assert.doesNotMatch(pkg.scripts.build, /canary/i);
  assert.doesNotMatch(pkg.scripts.test, /canary/i);
  assert.doesNotMatch(pkg.scripts.start, /canary/i);
});
