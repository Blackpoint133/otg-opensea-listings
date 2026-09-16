import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eventTypesForProfile } from "../src/eventTypes.js";
import { assertProductionProfile, createProductionInboxController, formatProductionRuntimeDiagnostic, PRODUCTION_EVENT_TYPES, ProductionIngestionRuntime, productionDatabasePreflight } from "../src/runtime/productionIngestionRuntime.js";
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
  let errorCallback: ((error: unknown) => void) | null = null;
  return {
    client: {
      onEvents(collection: string, types: readonly string[], cb: (event: unknown) => void) { assert.equal(collection, "off-the-grid"); assert.deepEqual(types, [...eventTypesForProfile("all")]); callback = cb; log.push("subscribe"); return () => log.push("unsubscribe"); },
      disconnect(cb?: () => void) { log.push("disconnect"); cb?.(); }
    } as any,
    emit(event: unknown) { callback?.(event); events.push(event); },
    error(error: unknown) { errorCallback?.(error); },
    setErrorCallback(cb: (error: unknown) => void) { errorCallback = cb; }
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
    createStream: (_key, error) => { s.setErrorCallback(error); return s.client; },
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
    confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]), createStream: (_key, error) => { s.setErrorCallback(error); return s.client; },
    persistEvent: async () => ({ outcome: "duplicate_existing", eventId: "1", dedupeKey: "d", eventType: "item_sold", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }), logger: () => {}
  });
  await runtime.start(); (s as any).emit({ event_type: "item_sold" }); await runtime.stop();
  assert.equal(runtime.counters.inboxDuplicateExisting, 1);
});

test("ingress rejection is contained and does not become an unhandled rejection", async () => {
  const s = stream([], []);
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]), createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, persistEvent: async () => { throw new Error("rejected"); }, logger: () => {} });
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
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => fakeController, createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, workerPollMs: 10000, logger: () => {} });
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
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => fakeController, createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, workerPollMs: 10000, persistEvent: async () => { persisted = true; return { outcome: "inserted_pending", eventId: "1", dedupeKey: "d", eventType: "item_listed", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }; }, logger: () => {} });
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
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", ingressCapacity: 2, createPool: () => pool(), createController: () => fakeController, createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, persistEvent: async () => { persisted += 1; await gate; return { outcome: "inserted_pending", eventId: String(persisted), dedupeKey: String(persisted), eventType: "item_listed", orderHash: null, nftId: null, processingStatus: "pending", attemptCount: 0 }; }, logger: () => {} });
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

test("persistence failure is fatal and rejects subsequent callbacks", async () => {
  const s = stream([], []);
  let calls = 0;
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]), createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, persistEvent: async () => { calls += 1; throw new Error("persist down"); }, logger: () => {} });
  await runtime.start();
  const termination = runtime.waitForTermination();
  (s as any).emit({ event_type: "item_listed" });
  for (let i = 0; i < 100 && runtime.counters.ingressErrors === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  (s as any).emit({ event_type: "item_sold" });
  const result = await termination;
  assert.equal(result.reason, "INGRESS_PERSISTENCE_FAILURE");
  assert.equal(result.fatal, true);
  assert.equal(calls, 1);
});

test("Stream error is fatal and later callbacks are ignored", async () => {
  const log: string[] = [];
  const s = stream([], log);
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller(log), createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, logger: () => {} });
  await runtime.start();
  const termination = runtime.waitForTermination();
  s.error(new Error("socket gap"));
  (s as any).emit({ event_type: "item_listed" });
  const result = await termination;
  assert.equal(result.reason, "STREAM_ERROR");
  assert.equal(result.fatal, true);
  assert.equal(runtime.counters.streamErrors, 1);
  assert.ok(log.includes("disconnect"));
});

test("synchronous Stream setup error cannot leave a healthy runtime", async () => {
  const s = stream([], []);
  let streams = 0;
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]), createStream: (_key, error) => { streams += 1; error(new Error("setup failure")); s.setErrorCallback(error); return s.client; }, logger: () => {} });
  await assert.rejects(() => runtime.start(), /STREAM_ERROR_DURING_STARTUP/);
  const result = await runtime.waitForTermination();
  assert.equal(streams, 1);
  assert.equal(result.reason, "STREAM_ERROR");
  assert.equal(result.fatal, true);
});

test("worker failure reaches fatal runtime termination", async () => {
  const s = stream([], []);
  const fakeController = { async start() { return { state: "READY" }; }, async runOnce() { throw new Error("worker failure"); }, async stop() {} } as any;
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => fakeController, createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, logger: () => {} });
  await runtime.start();
  const result = await runtime.waitForTermination();
  assert.equal(result.reason, "WORKER_ERROR");
  assert.equal(result.fatal, true);
});

test("disconnect timeout cannot block cleanup or termination", async () => {
  const s = stream([], []);
  const log: string[] = [];
  (s.client as any).disconnect = () => { log.push("disconnect_stuck"); };
  let controllerStopped = false;
  const fakeController = { async start() { return { state: "READY" }; }, async runOnce() { return { outcome: "idle", applyResult: null }; }, async stop() { controllerStopped = true; } } as any;
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", streamDisconnectTimeoutMs: 5, createPool: () => pool(), createController: () => fakeController, createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, logger: (message) => log.push(message) });
  await runtime.start();
  const started = Date.now();
  const termination = runtime.waitForTermination();
  await runtime.stop();
  const result = await termination;
  assert.equal(result.fatal, false);
  assert.equal(controllerStopped, true);
  assert.ok(Date.now() - started < 500);
  assert.ok(log.includes("stream_disconnect_timeout"));
});

test("operator stop is non-fatal and entrypoint awaits runtime termination", async () => {
  const script = await readFile(path.resolve(import.meta.dirname, "../scripts/runProductionIngestion.ts"), "utf8");
  assert.match(script, /waitForTermination/);
  assert.match(script, /termination\.fatal/);
  const s = stream([], []);
  const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]), createStream: (_key, error) => { s.setErrorCallback(error); return s.client; }, logger: () => {} });
  await runtime.start();
  const termination = runtime.waitForTermination();
  await runtime.stop();
  assert.equal((await termination).fatal, false);
});

test("production runtime reuses the accepted durable controller", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../src/runtime/productionIngestionRuntime.ts"), "utf8");
  assert.match(source, /DurableInboxRuntimeController/);
  assert.match(source, /controller!\.runOnce/);
});

test("plain SDK objects retain bounded structured diagnostics and first fatal wins", async () => {
  const logs: string[] = [];
  const s = stream([], logs);
  (s.client as any).disconnect = () => { logs.push("disconnect_stuck"); };
  const runtime = new ProductionIngestionRuntime({
    confirmProductionIngestion: true,
    apiKey: "test-key",
    streamDisconnectTimeoutMs: 5,
    createPool: () => pool(),
    createController: () => controller(logs),
    createStream: (_key, error) => { s.setErrorCallback(error); return s.client; },
    logger: (message) => logs.push(message)
  });
  await runtime.start();
  const termination = runtime.waitForTermination();
  s.error({ code: "ECONNRESET", errno: -4077, syscall: "read", hostname: "stream-api.opensea.io", reason: "socket closed", payload: { token: "STREAM_SECRET_SENTINEL", status: 503 } });
  s.error({ code: "SECOND_FATAL", reason: "must not replace first fatal" });
  const result = await termination;
  assert.equal(result.reason, "STREAM_ERROR");
  assert.equal(result.fatal, true);
  assert.match(result.fatalDiagnostic ?? "", /ECONNRESET/);
  assert.match(result.fatalDiagnostic ?? "", /read/);
  assert.match(result.fatalDiagnostic ?? "", /stream-api\.opensea\.io/);
  assert.match(result.fatalDiagnostic ?? "", /socket closed/);
  assert.doesNotMatch(result.fatalDiagnostic ?? "", /SECOND_FATAL/);
  assert.doesNotMatch(result.fatalDiagnostic ?? "", /STREAM_SECRET_SENTINEL/);
  assert.notEqual(result.fatalDiagnostic, "[object Object]");
  assert.ok(logs.some((line) => line.startsWith("stream_error:") && line.includes("ECONNRESET")));
  assert.ok(logs.every((line) => !line.includes("STREAM_SECRET_SENTINEL")));
  assert.ok(logs.includes("stream_disconnect_timeout"));
  assert.equal((result.fatalDiagnostic ?? "").includes("stream_disconnect_timeout"), false);
});

test("structured diagnostics retain nested SDK material and redact nested secrets", () => {
  const diagnostic = formatProductionRuntimeDiagnostic({
    event: "phx_error",
    payload: { status: 503, reason: "upstream unavailable", token: "NESTED_TOKEN_SENTINEL" },
    response: { status: 401, statusText: "Unauthorized", apiKey: "NESTED_API_KEY_SENTINEL" },
    credentials: { authorization: "NESTED_AUTH_SENTINEL", cookie: "NESTED_COOKIE_SENTINEL", password: "NESTED_PASSWORD_SENTINEL", DATABASE_URL: "NESTED_DB_SENTINEL" }
  });
  assert.match(diagnostic, /phx_error/);
  assert.match(diagnostic, /503/);
  assert.match(diagnostic, /upstream unavailable/);
  assert.match(diagnostic, /401/);
  assert.match(diagnostic, /Unauthorized/);
  for (const secret of ["NESTED_TOKEN_SENTINEL", "NESTED_API_KEY_SENTINEL", "NESTED_AUTH_SENTINEL", "NESTED_COOKIE_SENTINEL", "NESTED_PASSWORD_SENTINEL", "NESTED_DB_SENTINEL"]) assert.doesNotMatch(diagnostic, new RegExp(secret));
  assert.ok(diagnostic.length <= 2_000);
});

test("diagnostic formatter is safe for errors, strings, circular values, getters, and large input", () => {
  assert.match(formatProductionRuntimeDiagnostic(new Error("socket gap")), /Error/);
  assert.match(formatProductionRuntimeDiagnostic(new Error("socket gap")), /socket gap/);
  assert.match(formatProductionRuntimeDiagnostic("socket closed"), /socket closed/);
  const circular: Record<string, unknown> = { code: "EPIPE" };
  circular.self = circular;
  assert.doesNotThrow(() => formatProductionRuntimeDiagnostic(circular));
  assert.match(formatProductionRuntimeDiagnostic(circular), /EPIPE/);
  const getter: Record<string, unknown> = {};
  Object.defineProperty(getter, "message", { enumerable: true, get() { throw new Error("getter must not escape"); } });
  assert.doesNotThrow(() => formatProductionRuntimeDiagnostic(getter));
  const large = formatProductionRuntimeDiagnostic({ payload: "X".repeat(20_000), items: Array.from({ length: 100 }, () => "Y") });
  assert.ok(large.length <= 2_000);
});

test("ingress and worker fatal paths preserve their first diagnostic", async () => {
  const ingressStream = stream([], []);
  const ingress = new ProductionIngestionRuntime({
    confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(), createController: () => controller([]),
    createStream: (_key, error) => { ingressStream.setErrorCallback(error); return ingressStream.client; },
    persistEvent: async () => { throw { code: "EWRITE", reason: "durable inbox unavailable" }; }, logger: () => {}
  });
  await ingress.start();
  const ingressTermination = ingress.waitForTermination();
  ingressStream.emit({ event_type: "item_listed" });
  const ingressResult = await ingressTermination;
  assert.equal(ingressResult.reason, "INGRESS_PERSISTENCE_FAILURE");
  assert.match(ingressResult.fatalDiagnostic ?? "", /EWRITE/);

  const workerStream = stream([], []);
  const worker = new ProductionIngestionRuntime({
    confirmProductionIngestion: true, apiKey: "test-key", createPool: () => pool(),
    createController: () => ({ async start() { return { state: "READY" }; }, async runOnce() { throw { code: "EWORKER", reason: "worker unavailable" }; }, async stop() {} } as any),
    createStream: (_key, error) => { workerStream.setErrorCallback(error); return workerStream.client; }, logger: () => {}
  });
  await worker.start();
  const workerResult = await worker.waitForTermination();
  assert.equal(workerResult.reason, "WORKER_ERROR");
  assert.match(workerResult.fatalDiagnostic ?? "", /EWORKER/);
});
