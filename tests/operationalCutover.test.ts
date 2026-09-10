import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { nftAdvisoryLockKey, orderAdvisoryLockKey } from "../src/db/advisoryLocks.js";
import type { DbPool, DurableInboxMetrics, QueryResult, TransactionClient } from "../src/db/types.js";
import { DurableInboxRuntimeController, evaluateDurableInboxReadiness } from "../src/runtime/durableInboxRuntimeController.js";
import { acquireV2RuntimeGuard, RuntimeGuardConflictError, V2_RUNTIME_GUARD_KEY, type V2RuntimeGuard, type V2RuntimeMode } from "../src/runtime/runtimeGuard.js";
import type { DurableInboxWorkerOnceResult } from "../src/worker/durableInboxWorker.js";

const now = "2026-08-12T12:00:00.000Z";

function metrics(overrides: Partial<DurableInboxMetrics> = {}): DurableInboxMetrics {
  return {
    pendingTotal: 0,
    pendingDue: 0,
    pendingScheduled: 0,
    processingTotal: 0,
    staleProcessing: 0,
    failedTotal: 0,
    reconciliationRequiredTotal: 25,
    appliedTotal: 0,
    ignoredOlderTotal: 0,
    oldestPendingReceivedAt: null,
    oldestDueAgeMs: null,
    maxAttemptCount: 1,
    ...overrides
  };
}

class GuardClient implements TransactionClient {
  calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  unlockResult = true;
  constructor(private readonly acquireResult = true) {}
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    if (/pg_try_advisory_lock/.test(text)) return { rows: [{ acquired: this.acquireResult }] as Row[], rowCount: 1 };
    if (/pg_advisory_unlock/.test(text)) return { rows: [{ unlocked: this.unlockResult }] as Row[], rowCount: 1 };
    return { rows: [] as Row[], rowCount: 0 };
  }
  release(): void { this.released = true; }
}

class GuardPool implements DbPool {
  constructor(public readonly client: GuardClient) {}
  async connect(): Promise<TransactionClient> { return this.client; }
  async query<Row = unknown>(): Promise<QueryResult<Row>> { throw new Error("guard pool query should not be used"); }
  async end(): Promise<void> {}
}

class FakeGuard implements V2RuntimeGuard {
  readonly lockKey = V2_RUNTIME_GUARD_KEY;
  held = true;
  releaseCount = 0;
  constructor(readonly runtimeMode: V2RuntimeMode) {}
  async release(): Promise<void> {
    this.releaseCount += 1;
    this.held = false;
  }
}

class ControllerPool implements DbPool {
  queries: Array<{ text: string; values: readonly unknown[] }> = [];
  async connect(): Promise<TransactionClient> { throw new Error("controller should use injected guard"); }
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (/current_database/.test(text)) return { rows: [{ database: "server_otg" }] as Row[], rowCount: 1 };
    if (/information_schema\.tables/.test(text)) return { rows: [{ exists: true }] as Row[], rowCount: 1 };
    return { rows: [] as Row[], rowCount: 0 };
  }
  async end(): Promise<void> {}
}

function workerResult(outcome: DurableInboxWorkerOnceResult["outcome"] = "idle"): DurableInboxWorkerOnceResult {
  return { outcome, eventId: null, applyResult: null, retryResult: null };
}

test("runtime guard uses deterministic dedicated session advisory lock and releases once", async () => {
  const client = new GuardClient(true);
  const guard = await acquireV2RuntimeGuard(new GuardPool(client), "durable_inbox");
  assert.equal(guard.runtimeMode, "durable_inbox");
  assert.equal(guard.lockKey, V2_RUNTIME_GUARD_KEY);
  assert.equal(guard.held, true);
  assert.equal(client.released, false);
  assert.match(client.calls[0].text, /pg_try_advisory_lock/);
  assert.equal(client.calls[0].values[0], V2_RUNTIME_GUARD_KEY);
  await guard.release();
  await guard.release();
  assert.equal(client.calls.filter((call) => /pg_advisory_unlock/.test(call.text)).length, 1);
  assert.equal(client.released, true);
});

test("runtime guard fails fast on mode conflict and releases acquisition client", async () => {
  const client = new GuardClient(false);
  await assert.rejects(() => acquireV2RuntimeGuard(new GuardPool(client), "legacy_atomic"), RuntimeGuardConflictError);
  assert.equal(client.calls.length, 1);
  assert.equal(client.released, true);
});

test("runtime guard cleanup releases client even when unlock fails", async () => {
  const client = new GuardClient(true);
  client.unlockResult = false;
  const guard = await acquireV2RuntimeGuard(new GuardPool(client), "durable_inbox");
  await assert.rejects(() => guard.release(), /runtime_guard_unlock_failed/);
  assert.equal(client.released, true);
});

test("runtime guard key is separate from entity advisory lock keys", () => {
  assert.notEqual(V2_RUNTIME_GUARD_KEY, nftAdvisoryLockKey({ chain: "gunzilla", contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", tokenId: "1" }));
  assert.notEqual(V2_RUNTIME_GUARD_KEY, orderAdvisoryLockKey("0xabc"));
});

test("durable runtime controller lifecycle reaches READY after preflight guard recovery and readiness", async () => {
  const pool = new ControllerPool();
  const guard = new FakeGuard("durable_inbox");
  let recovered = 0;
  const controller = new DurableInboxRuntimeController({
    pool,
    runtimeMode: "durable_inbox",
    now: () => now,
    acquireGuard: async (_pool, mode) => {
      assert.equal(mode, "durable_inbox");
      return guard;
    },
    startupRecovery: async () => { recovered += 1; },
    getMetrics: async () => metrics()
  });
  const summary = await controller.start();
  assert.equal(summary.state, "READY");
  assert.equal(summary.guardHeld, true);
  assert.equal(summary.runtimeMode, "durable_inbox");
  assert.equal(recovered, 1);
  assert.equal(summary.readiness?.ready, true);
});

test("controller fails closed and releases guard on startup recovery or readiness failure", async () => {
  const recoveryGuard = new FakeGuard("durable_inbox");
  const recoveryFail = new DurableInboxRuntimeController({
    pool: new ControllerPool(),
    runtimeMode: "durable_inbox",
    acquireGuard: async () => recoveryGuard,
    startupRecovery: async () => { throw new Error("startup recovery failed"); },
    getMetrics: async () => metrics()
  });
  await assert.rejects(() => recoveryFail.start(), /startup recovery failed/);
  assert.equal(recoveryGuard.releaseCount, 1);

  const readinessGuard = new FakeGuard("durable_inbox");
  const readinessFail = new DurableInboxRuntimeController({
    pool: new ControllerPool(),
    runtimeMode: "durable_inbox",
    acquireGuard: async () => readinessGuard,
    getMetrics: async () => metrics({ failedTotal: 1 })
  });
  await assert.rejects(() => readinessFail.start(), /runtime_not_ready/);
  assert.equal(readinessGuard.releaseCount, 1);
});

test("controller guard conflict prevents READY and worker processing", async () => {
  let workerCalls = 0;
  const controller = new DurableInboxRuntimeController({
    pool: new ControllerPool(),
    runtimeMode: "durable_inbox",
    acquireGuard: async () => { throw new RuntimeGuardConflictError("durable_inbox"); },
    getMetrics: async () => metrics(),
    runWorkerOnce: async () => { workerCalls += 1; return workerResult(); }
  });
  await assert.rejects(() => controller.start(), /runtime_conflict/);
  assert.equal(workerCalls, 0);
  assert.equal(controller.summary().state, "FAILED");
});

test("readiness thresholds return explicit reasons without mutation", () => {
  assert.equal(evaluateDurableInboxReadiness(metrics()).ready, true);
  assert.deepEqual(evaluateDurableInboxReadiness(metrics({ failedTotal: 1 })).reasons, ["failed_total:1>0"]);
  assert.deepEqual(evaluateDurableInboxReadiness(metrics({ pendingDue: 1001 })).reasons, ["pending_due:1001>1000"]);
  assert.deepEqual(evaluateDurableInboxReadiness(metrics({ oldestDueAgeMs: 3_600_001 })).reasons, ["oldest_due_age_ms:3600001>3600000"]);
  assert.deepEqual(evaluateDurableInboxReadiness(metrics({ staleProcessing: 1 })).reasons, ["stale_processing:1>0"]);
});

test("controller runOnce is READY-only, one in-flight at a time, and stop drains before guard release", async () => {
  const guard = new FakeGuard("durable_inbox");
  let releaseWorker!: () => void;
  const controller = new DurableInboxRuntimeController({
    pool: new ControllerPool(),
    runtimeMode: "durable_inbox",
    now: () => now,
    acquireGuard: async () => guard,
    getMetrics: async () => metrics(),
    runWorkerOnce: async () => {
      await new Promise<void>((resolve) => { releaseWorker = resolve; });
      return workerResult("processed");
    }
  });
  await assert.rejects(() => controller.runOnce(), /runtime_not_ready/);
  await controller.start();
  const run = controller.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.summary().workerInFlight, true);
  await assert.rejects(() => controller.runOnce(), /worker_in_flight/);
  const stop = controller.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.held, true);
  releaseWorker();
  const stopped = await stop;
  assert.equal((await run).outcome, "processed");
  assert.equal(stopped.state, "STOPPED");
  assert.equal(guard.releaseCount, 1);
  assert.equal(stopped.guardHeld, false);
  assert.equal(stopped.lastWorkerOutcome?.outcome, "processed");
});

test("controller start and stop are idempotent without duplicate guard acquisition or unlock", async () => {
  const guard = new FakeGuard("durable_inbox");
  let guardAcquires = 0;
  const controller = new DurableInboxRuntimeController({
    pool: new ControllerPool(),
    runtimeMode: "durable_inbox",
    acquireGuard: async () => { guardAcquires += 1; return guard; },
    getMetrics: async () => metrics()
  });
  assert.equal((await controller.start()).state, "READY");
  assert.equal((await controller.start()).state, "READY");
  assert.equal(guardAcquires, 1);
  assert.equal((await controller.stop()).state, "STOPPED");
  assert.equal((await controller.stop()).state, "STOPPED");
  assert.equal(guard.releaseCount, 1);
});

test("durable controller source has no stream loop background service or atomic writer invocation", () => {
  const controller = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "runtime", "durableInboxRuntimeController.ts"), "utf8");
  const guard = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "runtime", "runtimeGuard.ts"), "utf8");
  assert.match(controller, /runDurableInboxWorkerOnce/);
  assert.doesNotMatch(controller, /applyNormalizedEvent|LiveEventWriter|OpenSeaStreamClient|setInterval|while\s*\(/);
  assert.doesNotMatch(guard, /pg_advisory_xact_lock|pg_try_advisory_xact_lock/);
});
