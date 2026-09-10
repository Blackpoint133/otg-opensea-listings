import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DURABLE_CANARY_EVENT_TYPES,
  DURABLE_CANARY_RUNTIME_MODE,
  comparePreExistingRows,
  loadDurableCanaryConfig,
  runDurableCanary,
  type DurableCanaryEvidence,
  type DurableCanaryConfig,
  type DurableCanarySummary
} from "../src/canary/durableCanary.js";
import type { DbPool, DurableInboxPersistResult, QueryResult, TransactionClient } from "../src/db/types.js";
import type { DurableInboxRuntimeSummary } from "../src/runtime/durableInboxRuntimeController.js";
import type { DurableInboxWorkerOnceResult } from "../src/worker/durableInboxWorker.js";

const apiEnv = { OPENSEA_API_KEY: "test-key" };
const now = "2026-08-13T00:00:00.000Z";

class EvidencePool implements DbPool {
  ended = false;
  queries: string[] = [];
  constructor(
    private readonly database = "server_otg",
    private readonly signature = "e562b604e9264d0cd5bdbf4bf8ae65e6",
    private readonly eventIds = Array.from({ length: 25 }, (_, i) => String(i + 31)),
    private readonly throwOnPostEvidence = false
  ) {}
  async connect(): Promise<TransactionClient> { throw new Error("durable canary test should not acquire raw clients"); }
  async query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    this.queries.push(text);
    if (this.throwOnPostEvidence && /GROUP BY processing_status/.test(text) && this.queries.filter((query) => /GROUP BY processing_status/.test(query)).length > 1) {
      throw new Error("post evidence failed password=secret");
    }
    if (/current_database/.test(text)) return { rows: [{ database: this.database }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\)::int FROM public\.opensea_listings_v2/.test(text)) {
      return { rows: [{ orders: 0, nft_state: 25, journal: this.eventIds.length, attempt_ledger: 0, unfinalized: 0, pending_due: 0, pending_scheduled: 0, failed: 0, reconciliation_required: this.eventIds.length }] as Row[], rowCount: 1 };
    }
    if (/GROUP BY processing_status/.test(text)) return { rows: [{ processing_status: "reconciliation_required", attempt_count: 1, count: this.eventIds.length }] as Row[], rowCount: 1 };
    if (/SELECT event_id::text/.test(text)) {
      const requested = values?.[0] as string[] | undefined;
      const ids = requested ? this.eventIds.filter((id) => requested.includes(id)) : this.eventIds;
      return { rows: ids.map((event_id) => ({ event_id })) as Row[], rowCount: ids.length };
    }
    if (/md5\(string_agg/.test(text)) return { rows: [{ signature: this.signature }] as Row[], rowCount: 1 };
    if (/to_regclass/.test(text)) return { rows: [{ exists: true }] as Row[], rowCount: 1 };
    return { rows: [] as Row[], rowCount: 0 };
  }
  async end(): Promise<void> { this.ended = true; }
}

class FakeController {
  startCalls = 0;
  stopCalls = 0;
  runCalls = 0;
  constructor(
    private readonly outcomes: DurableInboxWorkerOnceResult[] = [worker("idle")],
    private readonly startState: DurableInboxRuntimeSummary["state"] = "READY",
    private readonly options: { stopThrows?: boolean; runHook?: () => Promise<DurableInboxWorkerOnceResult> } = {}
  ) {}
  async start(): Promise<DurableInboxRuntimeSummary> {
    this.startCalls += 1;
    if (this.startState === "FAILED") throw new Error("runtime_conflict:durable_inbox");
    return summary(this.startState);
  }
  async runOnce(): Promise<DurableInboxWorkerOnceResult> {
    this.runCalls += 1;
    if (this.options.runHook) return this.options.runHook();
    return this.outcomes.shift() ?? worker("idle");
  }
  async stop(): Promise<DurableInboxRuntimeSummary> {
    this.stopCalls += 1;
    if (this.options.stopThrows) throw new Error("controller stop failed password=secret");
    return summary("STOPPED");
  }
}

class EndFailPool extends EvidencePool {
  override async end(): Promise<void> {
    this.ended = true;
    throw new Error("pool end failed password=secret");
  }
}

function summary(state: DurableInboxRuntimeSummary["state"]): DurableInboxRuntimeSummary {
  return {
    state,
    runtimeMode: DURABLE_CANARY_RUNTIME_MODE,
    guardHeld: state === "READY",
    workerInFlight: false,
    startedAt: now,
    stoppingAt: state === "STOPPED" ? now : null,
    lastWorkerOutcome: null,
    readiness: null,
    metrics: null
  };
}

function worker(outcome: DurableInboxWorkerOnceResult["outcome"], applyOutcome?: DurableInboxWorkerOnceResult["applyResult"]): DurableInboxWorkerOnceResult {
  return { outcome, eventId: outcome === "idle" ? null : "56", applyResult: applyOutcome ?? null, retryResult: null };
}

function config(overrides: string[] = []): DurableCanaryConfig {
  return loadDurableCanaryConfig(["--confirm-live", "--confirm-durable", "--confirm-server-otg", ...overrides], apiEnv);
}

function event(type = "item_transferred"): unknown {
  return { event_type: type, version: "1786422067000000000", payload: { event_timestamp: now, item: { nft_id: "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/999" }, transaction: { hash: "0xabc", timestamp: "1786422067" } } };
}

function streamWith(events: unknown[], order: string[] = []) {
  return {
    onEvents: (_collection: string, eventTypes: readonly string[], callback: (event: unknown) => void) => {
      order.push("stream");
      assert.deepEqual(eventTypes, [...DURABLE_CANARY_EVENT_TYPES]);
      for (const candidate of events) callback(candidate);
      return () => { order.push("unsubscribe"); };
    },
    disconnect: (callback?: () => void) => { order.push("disconnect"); callback?.(); }
  };
}

async function runWith(events: unknown[], controller = new FakeController(), extra: Partial<Parameters<typeof runDurableCanary>[1]> = {}): Promise<{ summary: DurableCanarySummary; pool: EvidencePool; controller: FakeController; order: string[] }> {
  const pool = new EvidencePool();
  const order: string[] = [];
  const summaryResult = await runDurableCanary(config(["--max-events", String(Math.max(1, events.length))]), {
    createPool: () => pool,
    createController: () => { order.push("controller"); return controller as any; },
    createStream: () => streamWith(events, order),
    persistEvent: async (_pool, raw) => {
      order.push("txa");
      assert.deepEqual(raw, events[0]);
      return { outcome: "inserted_pending", eventId: "56", dedupeKey: "dedupe", eventType: "item_transferred", orderHash: null, nftId: "gunzilla/0x/1", processingStatus: "pending", attemptCount: 0 } satisfies DurableInboxPersistResult;
    },
    setTimer: () => "timer",
    clearTimer: () => {},
    now: () => now,
    ...extra
  });
  return { summary: summaryResult, pool, controller, order };
}

test("durable canary safety gates fail closed before stream or Tx A", () => {
  assert.throws(() => loadDurableCanaryConfig([], apiEnv), /--confirm-live/);
  assert.throws(() => loadDurableCanaryConfig(["--confirm-live", "--confirm-durable"], apiEnv), /--confirm-server-otg/);
  assert.throws(() => loadDurableCanaryConfig(["--confirm-live", "--confirm-durable", "--confirm-server-otg", "--database", "server_otg"], apiEnv), /hard pinned/);
  assert.throws(() => loadDurableCanaryConfig(["--confirm-live", "--confirm-durable", "--confirm-server-otg", "--unknown"], apiEnv), /Unknown durable canary argument/);
});

test("durable canary config is hard pinned and bounded", () => {
  const loaded = config([]);
  assert.equal(loaded.runtimeMode, "durable_inbox");
  assert.equal(loaded.expectedDatabase, "server_otg");
  assert.equal(loaded.collectionSlug, "off-the-grid");
  assert.equal(loaded.chain, "gunzilla");
  assert.equal(loaded.contractAddress, "0x9ed98e159be43a8d42b64053831fcae5e4d7d271");
  assert.equal(loaded.durationMinutes, 5);
  assert.equal(loaded.maxEvents, 25);
  assert.equal(loaded.queueCapacity, 100);
  assert.throws(() => config(["--duration-minutes", "0"]), /duration-minutes/);
  assert.throws(() => config(["--max-events", "0"]), /max-events/);
  assert.throws(() => config(["--queue-capacity", "0"]), /queue-capacity/);
});

test("startup verifies database and creates stream only after durable controller READY", async () => {
  const controller = new FakeController([worker("idle")]);
  const { summary, order } = await runWith([event()], controller);
  assert.equal(summary.result, "DURABLE_CANARY_COMPLETED");
  assert.ok(order.indexOf("stream") > order.indexOf("controller"));
  assert.ok(order.indexOf("txa") > order.indexOf("stream"));
  assert.equal(controller.startCalls, 1);
  assert.equal(summary.guardAcquired, true);
  assert.equal(summary.streamConnected, true);
});

test("startup fails closed on DB mismatch or runtime conflict before stream", async () => {
  let streamCreated = 0;
  const mismatch = await runDurableCanary(config(), {
    createPool: () => new EvidencePool("wrong_db"),
    createStream: () => { streamCreated += 1; throw new Error("stream must not start"); },
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  assert.equal(mismatch.result, "DURABLE_CANARY_FAILED");
  assert.equal(streamCreated, 0);

  const conflict = await runDurableCanary(config(), {
    createPool: () => new EvidencePool(),
    createController: () => new FakeController([], "FAILED") as any,
    createStream: () => { streamCreated += 1; throw new Error("stream must not start"); },
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  assert.equal(conflict.stopReason, "runtime_conflict");
  assert.equal(streamCreated, 0);
});

test("Tx A admission counts inserted duplicate and raw event remains unchanged", async () => {
  const raw = event();
  const before = JSON.stringify(raw);
  let calls = 0;
  const result = await runWith([raw, { ...event(), event_type: "item_listed" }], new FakeController([worker("processed", { outcome: "reconciliation_required", eventId: "56", eventType: "item_transferred", dedupeKey: "d", processingStatus: "reconciliation_required", attemptCount: 1, applyResult: "inserted_nft_transfer;suppressed_orders=0" }), worker("idle")]), {
    persistEvent: async () => {
      calls += 1;
      return { outcome: calls === 1 ? "inserted_pending" : "duplicate_existing", eventId: String(55 + calls), dedupeKey: `d${calls}`, eventType: "item_transferred", orderHash: null, nftId: null, processingStatus: calls === 1 ? "pending" : "reconciliation_required", attemptCount: calls === 1 ? 0 : 1 };
    }
  });
  assert.equal(JSON.stringify(raw), before);
  assert.equal(result.summary.counters.txAInsertedPending, 1);
  assert.equal(result.summary.counters.txADuplicateExisting, 1);
  assert.equal(result.summary.counters.reconciliationRequired, 1);
});

test("bounds stop on maxEvents duration and queue capacity without unlimited values", async () => {
  const max = await runWith([event()], new FakeController([worker("idle")]));
  assert.equal(max.summary.stopReason, "max_events_reached");

  const duration = await runDurableCanary(config(["--max-events", "2"]), {
    createPool: () => new EvidencePool(),
    createController: () => new FakeController([worker("idle")]) as any,
    createStream: () => streamWith([]),
    setTimer: (callback) => { queueMicrotask(callback); return "timer"; },
    clearTimer: () => {}
  });
  assert.equal(duration.stopReason, "duration_reached");

  let release!: () => void;
  const queueRun = runDurableCanary(config(["--max-events", "2", "--queue-capacity", "1"]), {
    createPool: () => new EvidencePool(),
    createController: () => new FakeController([worker("idle")]) as any,
    createStream: () => streamWith([event(), event("item_listed")]),
    persistEvent: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { outcome: "inserted_pending", eventId: "56", dedupeKey: "d", eventType: "item_transferred", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 };
    },
    setTimer: () => "timer",
    clearTimer: () => {}
  });
  for (let i = 0; i < 10 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  release();
  const queue = await queueRun;
  assert.equal(queue.stopReason, "queue_capacity_exceeded");
  assert.equal(queue.counters.queueSignalsDropped, 1);
  assert.equal(queue.counters.txAAdmissionAccepted, 1);
  assert.equal(queue.counters.streamEventsMatchedContract, 2);
});

test("maxEvents counts only events accepted for Tx A admission", async () => {
  const events = Array.from({ length: 26 }, (_, index) => event(index % 2 === 0 ? "item_transferred" : "item_listed"));
  let persistCalls = 0;
  const summary = await runDurableCanary(config(["--max-events", "25"]), {
    createPool: () => new EvidencePool(),
    createController: () => new FakeController([worker("idle")]) as any,
    createStream: () => streamWith(events),
    persistEvent: async () => {
      persistCalls += 1;
      return { outcome: "inserted_pending", eventId: String(55 + persistCalls), dedupeKey: `d${persistCalls}`, eventType: "item_transferred", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 };
    },
    setTimer: () => "timer",
    clearTimer: () => {},
    now: () => now
  });
  assert.equal(summary.counters.streamEventsObserved, 26);
  assert.equal(summary.counters.streamEventsMatchedContract, 26);
  assert.equal(summary.counters.txAAdmissionAccepted, 25);
  assert.equal(persistCalls, 25);
  assert.equal(summary.stopReason, "max_events_reached");
});

test("disconnect failure records cleanup error and still settles Tx A, drains, stops controller, and closes pool", async () => {
  const controller = new FakeController([worker("idle")]);
  const pool = new EvidencePool();
  const order: string[] = [];
  let callbackRef: ((event: unknown) => void) | null = null;
  let persistCalls = 0;
  const summaryResult = await runDurableCanary(config(["--max-events", "2"]), {
    createPool: () => pool,
    createController: () => controller as any,
    createStream: () => ({
      onEvents: (_collection, _events, callback) => {
        callbackRef = callback;
        callback(event());
        return () => order.push("unsubscribe");
      },
      disconnect: () => {
        order.push("disconnect");
        callbackRef?.(event("item_listed"));
        throw new Error("disconnect failed password=secret");
      }
    }),
    persistEvent: async () => {
      persistCalls += 1;
      return { outcome: "inserted_pending", eventId: "56", dedupeKey: "d", eventType: "item_transferred", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 };
    },
    setTimer: (callback) => { queueMicrotask(callback); return "timer"; },
    clearTimer: () => {},
    now: () => now
  });
  assert.equal(summaryResult.result, "DURABLE_CANARY_FAILED");
  assert.match(summaryResult.cleanupErrors.join("\n"), /disconnect/);
  assert.equal(persistCalls, 1);
  assert.equal(summaryResult.counters.txAAdmissionAccepted, 1);
  assert.equal(controller.stopCalls, 1);
  assert.equal(pool.ended, true);
});

test("unsubscribe post-evidence controller.stop and pool.end failures are accumulated without skipping later cleanup", async () => {
  const stopFailController = new FakeController([worker("idle")], "READY", { stopThrows: true });
  const poolEndFail = new EndFailPool("server_otg", "e562b604e9264d0cd5bdbf4bf8ae65e6", Array.from({ length: 25 }, (_, i) => String(i + 31)), true);
  const summaryResult = await runDurableCanary(config(["--max-events", "1"]), {
    createPool: () => poolEndFail,
    createController: () => stopFailController as any,
    createStream: () => ({
      onEvents: (_collection, _events, callback) => {
        callback(event());
        return () => { throw new Error("unsubscribe failed password=secret"); };
      },
      disconnect: (callback?: () => void) => callback?.()
    }),
    persistEvent: async () => ({ outcome: "inserted_pending", eventId: "56", dedupeKey: "d", eventType: "item_transferred", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }),
    setTimer: () => "timer",
    clearTimer: () => {},
    now: () => now
  });
  assert.equal(summaryResult.result, "DURABLE_CANARY_FAILED");
  assert.match(summaryResult.cleanupErrors.join("\n"), /unsubscribe/);
  assert.match(summaryResult.cleanupErrors.join("\n"), /post_evidence/);
  assert.match(summaryResult.cleanupErrors.join("\n"), /controller_stop/);
  assert.match(summaryResult.cleanupErrors.join("\n"), /pool_end/);
  assert.equal(stopFailController.stopCalls, 1);
  assert.equal(poolEndFail.ended, true);
});

test("active worker timeout path waits for worker settlement before controller stop", async () => {
  const order: string[] = [];
  const controller = new FakeController([], "READY", {
    runHook: async () => {
      order.push("run-start");
      await Promise.resolve();
      order.push("run-timeout-rollback-settled");
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    }
  });
  const summaryResult = await runDurableCanary(config(["--max-events", "1", "--max-drain-worker-runs", "1", "--drain-timeout-ms", "1"]), {
    createPool: () => new EvidencePool(),
    createController: () => controller as any,
    createStream: () => streamWith([]),
    setTimer: (callback) => { queueMicrotask(callback); return "timer"; },
    clearTimer: () => {},
    now: () => now
  });
  order.push(`stop-calls:${controller.stopCalls}`);
  assert.deepEqual(order.slice(0, 2), ["run-start", "run-timeout-rollback-settled"]);
  assert.equal(controller.stopCalls, 1);
  assert.equal(summaryResult.result, "DURABLE_CANARY_FAILED");
  assert.equal(summaryResult.counters.workerErrors, 1);
});

test("pre-existing preservation requires same ID count set and signature", () => {
  const baseEvidence = (ids: string[], signature: string | null): DurableCanaryEvidence => ({
    database: "server_otg",
    counts: { orders: 0, nftState: 0, journal: ids.length, attemptLedger: 0, unfinalized: 0 },
    lifecycle: [],
    pendingDue: 0,
    pendingScheduled: 0,
    failed: 0,
    reconciliationRequired: 0,
    eventIds: ids,
    signature,
    v1Exists: true
  });
  const missing = comparePreExistingRows(baseEvidence(["1", "2", "3"], "same"), baseEvidence(["1", "3"], "same"));
  assert.equal(missing.sameIdCount, false);
  assert.equal(missing.sameIdSet, false);
  assert.deepEqual(missing.missingEventIds, ["2"]);
  assert.equal(missing.preserved, false);
  const changed = comparePreExistingRows(baseEvidence(["1", "2", "3"], "before"), baseEvidence(["1", "2", "3"], "after"));
  assert.equal(changed.sameIdSet, true);
  assert.equal(changed.sameSignature, false);
  assert.equal(changed.preserved, false);
  const empty = comparePreExistingRows(baseEvidence([], null), baseEvidence([], null));
  assert.equal(empty.preserved, true);
});

test("drain handles due work scheduled retry idle and preservation without whole-table signature assumption", async () => {
  const controller = new FakeController([worker("retry_scheduled"), worker("idle")]);
  const { summary } = await runWith([event()], controller);
  assert.equal(summary.counters.workerRetryScheduled, 1);
  assert.equal(summary.drain.completed, true);
  assert.equal(summary.preExistingRowsPreserved, true);
  assert.equal(summary.preExistingRowsPreservation?.sameIdSet, true);
  assert.ok(summary.preRunEvidence?.eventIds.includes("31"));
  assert.equal(summary.preRunEvidence?.counts.journal, 25);
  assert.equal(summary.postRunEvidence?.signature, "e562b604e9264d0cd5bdbf4bf8ae65e6");
});

test("durable canary source excludes legacy atomic path and live execution from normal tests", () => {
  const durable = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "durableCanary.ts"), "utf8");
  const runner = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "runDurableCanary.ts"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.doesNotMatch(durable, /LiveEventWriter|applyNormalizedEvent|runLiveCanary|legacy_atomic/);
  assert.match(durable, /DurableInboxRuntimeController/);
  assert.match(durable, /persistRawEventToInbox/);
  assert.equal(pkg.scripts.canary, "node dist/canary/runLiveCanary.js");
  assert.equal(pkg.scripts["canary:durable"], "node dist/canary/runDurableCanary.js");
  assert.doesNotMatch(pkg.scripts.test, /canary:durable|runDurableCanary/);
  assert.match(runner, /loadDurableCanaryConfig/);
});
