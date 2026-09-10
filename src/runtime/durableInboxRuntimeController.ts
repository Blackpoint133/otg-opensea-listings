import { getDurableInboxMetrics } from "../db/inboxRetryRepository.js";
import type { DbPool, DurableInboxMetrics } from "../db/types.js";
import { runDurableInboxWorkerOnce, type DurableInboxWorkerOnceResult } from "../worker/durableInboxWorker.js";
import { acquireV2RuntimeGuard, type V2RuntimeGuard, type V2RuntimeMode } from "./runtimeGuard.js";

export type DurableInboxRuntimeState = "STOPPED" | "STARTING" | "READY" | "DRAINING" | "FAILED";

export interface DurableInboxReadinessPolicy {
  maxFailed: number;
  maxPendingDue: number;
  maxOldestDueAgeMs: number;
  maxStaleProcessing: number;
}

export interface DurableInboxReadiness {
  ready: boolean;
  reasons: string[];
  metrics: DurableInboxMetrics;
}

export interface DurableInboxRuntimeSummary {
  state: DurableInboxRuntimeState;
  runtimeMode: V2RuntimeMode;
  guardHeld: boolean;
  workerInFlight: boolean;
  startedAt: string | null;
  stoppingAt: string | null;
  lastWorkerOutcome: DurableInboxWorkerOnceResult | null;
  readiness: DurableInboxReadiness | null;
  metrics: DurableInboxMetrics | null;
}

export interface DurableInboxRuntimeControllerOptions {
  pool: DbPool;
  runtimeMode: V2RuntimeMode;
  readinessPolicy?: DurableInboxReadinessPolicy;
  drainTimeoutMs?: number;
  now?: () => string;
  acquireGuard?: typeof acquireV2RuntimeGuard;
  preflight?: (pool: DbPool) => Promise<void>;
  startupRecovery?: (pool: DbPool, now: string) => Promise<void>;
  getMetrics?: typeof getDurableInboxMetrics;
  runWorkerOnce?: typeof runDurableInboxWorkerOnce;
}

export const DEFAULT_DURABLE_INBOX_READINESS_POLICY: DurableInboxReadinessPolicy = {
  maxFailed: 0,
  maxPendingDue: 1000,
  maxOldestDueAgeMs: 3_600_000,
  maxStaleProcessing: 0
};

function validateReadinessPolicy(policy: DurableInboxReadinessPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_readiness_policy:${name}`);
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("drain_timeout")), ms);
  });
}

async function defaultPreflight(pool: DbPool): Promise<void> {
  const database = await pool.query<{ database: string }>("SELECT current_database() AS database");
  if (!database.rows[0]?.database) throw new Error("runtime_preflight_failed:database");
  const tables = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='opensea_listings_events_v2'
     ) AS exists`
  );
  if (!Boolean(tables.rows[0]?.exists)) throw new Error("runtime_preflight_failed:journal_table");
}

export function evaluateDurableInboxReadiness(metrics: DurableInboxMetrics, policy: DurableInboxReadinessPolicy = DEFAULT_DURABLE_INBOX_READINESS_POLICY): DurableInboxReadiness {
  validateReadinessPolicy(policy);
  const reasons: string[] = [];
  if (metrics.failedTotal > policy.maxFailed) reasons.push(`failed_total:${metrics.failedTotal}>${policy.maxFailed}`);
  if (metrics.pendingDue > policy.maxPendingDue) reasons.push(`pending_due:${metrics.pendingDue}>${policy.maxPendingDue}`);
  if (metrics.oldestDueAgeMs !== null && metrics.oldestDueAgeMs > policy.maxOldestDueAgeMs) reasons.push(`oldest_due_age_ms:${metrics.oldestDueAgeMs}>${policy.maxOldestDueAgeMs}`);
  if (metrics.staleProcessing > policy.maxStaleProcessing) reasons.push(`stale_processing:${metrics.staleProcessing}>${policy.maxStaleProcessing}`);
  return { ready: reasons.length === 0, reasons, metrics };
}

export class DurableInboxRuntimeController {
  private state: DurableInboxRuntimeState = "STOPPED";
  private guard: V2RuntimeGuard | null = null;
  private startedAt: string | null = null;
  private stoppingAt: string | null = null;
  private readiness: DurableInboxReadiness | null = null;
  private lastWorkerOutcome: DurableInboxWorkerOnceResult | null = null;
  private inFlightWorker: Promise<DurableInboxWorkerOnceResult> | null = null;
  private stopPromise: Promise<DurableInboxRuntimeSummary> | null = null;

  constructor(private readonly options: DurableInboxRuntimeControllerOptions) {
    if (options.runtimeMode !== "durable_inbox") throw new Error("durable runtime controller requires durable_inbox mode");
    validateReadinessPolicy(options.readinessPolicy ?? DEFAULT_DURABLE_INBOX_READINESS_POLICY);
    if (options.drainTimeoutMs !== undefined && (!Number.isSafeInteger(options.drainTimeoutMs) || options.drainTimeoutMs < 1)) throw new Error("invalid_drain_timeout_ms");
  }

  async start(): Promise<DurableInboxRuntimeSummary> {
    if (this.state === "READY") return this.summary();
    if (this.state === "STARTING") throw new Error("runtime_start_in_progress");
    if (this.state === "DRAINING") throw new Error("runtime_stop_in_progress");
    this.state = "STARTING";
    this.startedAt = this.options.now?.() ?? new Date().toISOString();
    try {
      await (this.options.preflight ?? defaultPreflight)(this.options.pool);
      this.guard = await (this.options.acquireGuard ?? acquireV2RuntimeGuard)(this.options.pool, "durable_inbox");
      await this.options.startupRecovery?.(this.options.pool, this.options.now?.() ?? new Date().toISOString());
      const metrics = await (this.options.getMetrics ?? getDurableInboxMetrics)(this.options.pool, this.options.now?.() ?? new Date().toISOString());
      this.readiness = evaluateDurableInboxReadiness(metrics, this.options.readinessPolicy ?? DEFAULT_DURABLE_INBOX_READINESS_POLICY);
      if (!this.readiness.ready) throw new Error(`runtime_not_ready:${this.readiness.reasons.join(",")}`);
      this.state = "READY";
      return this.summary();
    } catch (error) {
      this.state = "FAILED";
      await this.releaseGuardBestEffort();
      throw error;
    }
  }

  async runOnce(): Promise<DurableInboxWorkerOnceResult> {
    if (this.state !== "READY") throw new Error(`runtime_not_ready:${this.state}`);
    if (this.inFlightWorker) throw new Error("worker_in_flight");
    const run = (this.options.runWorkerOnce ?? runDurableInboxWorkerOnce)(this.options.pool, this.options.now?.() ?? new Date().toISOString());
    this.inFlightWorker = run;
    try {
      const result = await run;
      this.lastWorkerOutcome = result;
      return result;
    } finally {
      if (this.inFlightWorker === run) this.inFlightWorker = null;
    }
  }

  async stop(): Promise<DurableInboxRuntimeSummary> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "STOPPED") return this.summary();
    this.stopPromise = (async () => {
      this.state = "DRAINING";
      this.stoppingAt = this.options.now?.() ?? new Date().toISOString();
      const inFlight = this.inFlightWorker;
      if (inFlight) {
        if (this.options.drainTimeoutMs) await Promise.race([inFlight, timeout(this.options.drainTimeoutMs)]);
        else await inFlight;
      }
      await this.releaseGuardBestEffort();
      this.state = "STOPPED";
      return this.summary();
    })();
    return this.stopPromise;
  }

  summary(): DurableInboxRuntimeSummary {
    return {
      state: this.state,
      runtimeMode: this.options.runtimeMode,
      guardHeld: Boolean(this.guard?.held),
      workerInFlight: Boolean(this.inFlightWorker),
      startedAt: this.startedAt,
      stoppingAt: this.stoppingAt,
      lastWorkerOutcome: this.lastWorkerOutcome,
      readiness: this.readiness,
      metrics: this.readiness?.metrics ?? null
    };
  }

  private async releaseGuardBestEffort(): Promise<void> {
    const current = this.guard;
    this.guard = null;
    if (current?.held) await current.release();
  }
}
