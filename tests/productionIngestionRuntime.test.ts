import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eventTypesForProfile } from "../src/eventTypes.js";
import { assertProductionProfile, createProductionInboxController, PRODUCTION_EVENT_TYPES, ProductionIngestionRuntime, productionDatabasePreflight } from "../src/runtime/productionIngestionRuntime.js";
import { DEFAULT_DURABLE_INBOX_READINESS_POLICY, evaluateDurableInboxReadiness } from "../src/runtime/durableInboxRuntimeController.js";

function pool(database = "server_otg") {
  const queries: string[] = [];
  return {
    queries,
    async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
      queries.push(sql);
      if (/current_database/.test(sql)) return { rows: [{ database, schema: "public" } as T], rowCount: 1 };
      if (/unnest/.test(sql)) return { rows: [
        "opensea_listings_events_v2", "opensea_listings_v2", "opensea_listings_nft_state_v2",
        "targeted_verifier_attempts", "targeted_verifier_generation_publications", "targeted_verifier_shadow_decisions"
      ].map((table_name) => ({ table_name, present: true } as T)), rowCount: 6 };
      return { rows: [], rowCount: 0 };
    },
    async connect() { throw new Error("not used"); },
    async end() {}
  } as any;
}

function controller(log: string[]) {
  let runs = 0;
  return {
    async start() { log.push("controller:start"); return { state: "READY" }; },
    async runOnce() { runs += 1; log.push("worker"); return runs === 1 ? { outcome: "processed", applyResult: { outcome: "applied" } } : { outcome: "idle", applyResult: null }; },
    async stop() { log.push("controller:stop"); }
  } as any;
}

function stream(events: unknown[], log: string[]) {
  let callback: ((event: unknown) => void) | null = null;
  return {
    client: {
      onEvents(collection: string, types: readonly string[], cb: (event: unknown) => void) { assert.equal(collection, "off-the-grid"); assert.deepEqual(types, [...eventTypesForProfile("all")]); callback = cb; log.push("subscribe"); return () => log.push("unsubscribe"); },
      disconnect(cb?: () => void) { log.push("disconnect"); cb?.(); }
    } as any,
    emit(event: unknown) { callback?.(event); events.push(event); }
  };
}

test("production profile is exactly all six accepted event types", () => {
  assert.deepEqual(PRODUCTION_EVENT_TYPES, eventTypesForProfile("all"));
  assert.equal(PRODUCTION_EVENT_TYPES.length, 6);
});

test("production profile rejects orders-only and transfers-only", () => {
  assert.doesNotThrow(() => assertProductionProfile("all"));
  assert.throws(() => assertProductionProfile("orders"), /hard-pinned/);
  assert.throws(() => assertProductionProfile("transfers"), /hard-pinned/);
});

test("production controller permits a 30-day pending backlog without weakening the generic policy", async () => {
  let recovery = 0;
  let runs = 0;
  const metrics = { pendingTotal: 13, pendingDue: 13, pendingScheduled: 0, processingTotal: 0, staleProcessing: 0, failedTotal: 0, reconciliationRequiredTotal: 0, appliedTotal: 0, ignoredOlderTotal: 0, oldestPendingReceivedAt: "2026-08-15T00:00:00.000Z", oldestDueAgeMs: 30 * 24 * 60 * 60 * 1000, maxAttemptCount: 0 };
  const guard = { held: true, release: async () => { guard.held = false; } };
  const controller = createProductionInboxController(pool(), {
    preflight: async () => {},
    startupRecovery: async () => { recovery += 1; },
    acquireGuard: async () => guard,
    getMetrics: async () => metrics,
    runWorkerOnce: async () => ({ outcome: ++runs <= 13 ? "processed" : "idle", eventId: null, applyResult: null, retryResult: null }) as any
  });
  const summary = await controller.start();
  assert.equal(summary.state, "READY");
  assert.equal(recovery, 1);
  assert.equal(evaluateDurableInboxReadiness(metrics).ready, false);
  await controller.stop();
});

test("production preflight rejects wrong database before stream", async () => {
  await assert.rejects(() => productionDatabasePreflight(pool("wrong_db")), /IDENTITY_MISMATCH/);
});

test("production preflight rejects missing migration-008 prerequisites", async () => {
  const p = pool();
  p.query = async (sql: string) => /current_database/.test(sql)
    ? { rows: [{ database: "server_otg", schema: "public" }], rowCount: 1 }
    : { rows: [{ table_name: "opensea_listings_events_v2", present: true }], rowCount: 1 };
  await assert.rejects(() => productionDatabasePreflight(p), /PREREQUISITE_MISSING/);
});

test("runtime requires explicit production confirmation", () => {
  assert.throws(() => new ProductionIngestionRuntime({ confirmProductionIngestion: false }), /is required/);
});

test("stream events cross the durable inbox boundary and are serialized", async () => {
  const log: string[] = [];
  const emitted: unknown[] = [];
  const s = stream(emitted, log);
  const persisted: unknown[] = [];
  const runtime = new ProductionIngestionRuntime({
    confirmProductionIngestion: true,
    apiKey: "test-key",
    createPool: () => pool(),
    createController: () => controller(log),
    createStream: (_key, _error) => s.client,
    persistEvent: async (_pool, event) => { persisted.push(event); await new Promise((resolve) => setTimeout(resolve, 2)); return { outcome: "inserted_pending", eventId: String(persisted.length), dedupeKey: "d", eventType: "item_listed", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }; },
    now: () => "2026-01-01T00:00:00.000Z",
    logger: () => {}
  });
  await runtime.start();
  (s as any).emit({ event_type: "item_listed" });
  (s as any).emit({ event_type: "item_transferred" });
  await runtime.stop();
  assert.equal(persisted.length, 2);
  assert.equal(runtime.counters.inboxInsertedPending, 2);
  assert.equal(runtime.counters.workerApplied, 1);
  assert.ok(log.includes("disconnect"));
  assert.ok(log.includes("controller:stop"));
});

test("duplicate_existing is accepted idempotently", async () => {
  const s = stream([], []);
  const runtime = new ProductionIngestionRuntime({
    confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]), createStream: () => s.client,
    persistEvent: async () => ({ outcome: "duplicate_existing", eventId: "1", dedupeKey: "d", eventType: "item_sold", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }), logger: () => {}
  });
  await runtime.start(); (s as any).emit({ event_type: "item_sold" }); await runtime.stop();
  assert.equal(runtime.counters.inboxDuplicateExisting, 1);
});

test("ingress rejection is contained and does not become an unhandled rejection", async () => {
  const s = stream([], []);
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]), createStream: () => s.client, persistEvent: async () => { throw new Error("rejected"); }, logger: () => {} });
  await runtime.start(); (s as any).emit({ event_type: "item_cancelled" }); await runtime.stop();
  assert.equal(runtime.counters.ingressErrors, 1);
});

test("runtime source does not import Active Listings or exact-order transports", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../src/runtime/productionIngestionRuntime.ts"), "utf8");
  assert.doesNotMatch(source, /activeListings|openSeaExactOrder|restEvents|ActiveListingsClient/i);
  assert.doesNotMatch(source, /applyOrderEvent|applyTransferEvent|listingRepository|nftStateRepository/);
});

test("worker pump drains startup backlog without Stream events", async () => {
  const log: string[] = [];
  const s = stream([], log);
  let calls = 0;
  const fakeController = {
    async start() { return { state: "READY" }; },
    async runOnce() { calls += 1; return calls <= 13 ? { outcome: "processed", applyResult: { outcome: "reconciliation_required" } } : { outcome: "idle", applyResult: null }; },
    async stop() {}
  } as any;
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => fakeController, createStream: () => s.client, workerPollMs: 10000, logger: () => {} });
  await runtime.start();
  for (let i = 0; i < 100 && calls < 14; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  await runtime.stop();
  assert.equal(calls, 14);
  assert.equal(runtime.counters.workerReconciliationRequired, 13);
});

test("inserted pending wakes an idle worker without per-event runOnce coupling", async () => {
  const s = stream([], []);
  let calls = 0;
  const fakeController = { async start() { return { state: "READY" }; }, async runOnce() { calls += 1; return { outcome: "idle", applyResult: null }; }, async stop() {} } as any;
  let persisted = false;
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => fakeController, createStream: () => s.client, workerPollMs: 10000, persistEvent: async () => { persisted = true; return { outcome: "inserted_pending", eventId: "1", dedupeKey: "d", eventType: "item_listed", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }; }, logger: () => {} });
  await runtime.start();
  const before = calls;
  (s as any).emit({ event_type: "item_listed" });
  for (let i = 0; i < 100 && calls <= before; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  await runtime.stop();
  assert.equal(persisted, true);
  assert.ok(calls > before);
});

test("bounded ingress fails closed on overload and drains admitted events", async () => {
  const log: string[] = [];
  const s = stream([], log);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let persisted = 0;
  const fakeController = { async start() { return { state: "READY" }; }, async runOnce() { return { outcome: "idle", applyResult: null }; }, async stop() {} } as any;
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", ingressCapacity: 2, createPool: () => pool(), createController: () => fakeController, createStream: () => s.client, persistEvent: async () => { persisted += 1; await gate; return { outcome: "inserted_pending", eventId: String(persisted), dedupeKey: String(persisted), eventType: "item_listed", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }; }, logger: () => {} });
  await runtime.start();
  (s as any).emit({ event_type: "item_listed" });
  (s as any).emit({ event_type: "item_listed" });
  (s as any).emit({ event_type: "item_listed" });
  assert.equal(runtime.counters.ingressOverloadFatal, 1);
  release();
  await runtime.stop();
  assert.equal(persisted, 2);
  assert.ok(log.includes("disconnect"));
});

test("production runtime reuses the accepted durable controller", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../src/runtime/productionIngestionRuntime.ts"), "utf8");
  assert.match(source, /DurableInboxRuntimeController/);
  assert.match(source, /controller!\.runOnce/);
});
