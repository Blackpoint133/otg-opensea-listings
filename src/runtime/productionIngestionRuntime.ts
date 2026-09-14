import { LogLevel } from "@opensea/stream-js";
import { LocalStorage } from "node-localstorage";
import { loadDatabaseConfig, createDatabasePool, closeDatabasePool } from "../db/pool.js";
import type { DbPool, DurableInboxPersistResult } from "../db/types.js";
import { persistRawEventToInbox } from "../db/durableInboxRepository.js";
import { getDurableInboxMetrics } from "../db/inboxRetryRepository.js";
import { prepareDurableInboxOnStartup } from "../worker/durableInboxWorker.js";
import { eventTypesForProfile } from "../eventTypes.js";
import { createStreamClient } from "../streamProbe.js";
import { DurableInboxRuntimeController } from "./durableInboxRuntimeController.js";

export const PRODUCTION_COLLECTION = "off-the-grid";
export const PRODUCTION_DATABASE = "server_otg";
export const PRODUCTION_EVENT_TYPES = eventTypesForProfile("all");
export const DEFAULT_PRODUCTION_INGRESS_CAPACITY = 256;
export const DEFAULT_PRODUCTION_WORKER_POLL_MS = 1_000;
const REQUIRED_TABLES = [
  "opensea_listings_events_v2",
  "opensea_listings_v2",
  "opensea_listings_nft_state_v2",
  "targeted_verifier_attempts",
  "targeted_verifier_generation_publications",
  "targeted_verifier_shadow_decisions"
] as const;

export function assertProductionProfile(profile: string | undefined): void {
  if (profile !== undefined && profile !== "all") throw new Error("production ingestion profile is hard-pinned to all");
}

export interface ProductionStreamClient {
  onEvents(collection: string, events: readonly string[], callback: (event: unknown) => void): () => void;
  disconnect(callback?: () => void): void;
}

export interface ProductionIngestionCounters {
  streamEventsObserved: number;
  inboxInsertedPending: number;
  inboxDuplicateExisting: number;
  ingressErrors: number;
  workerApplied: number;
  workerReconciliationRequired: number;
  workerFailed: number;
  workerRuns: number;
  workerIdle: number;
  ingressQueueDepth: number;
  ingressQueueHighWater: number;
  ingressOverloadFatal: number;
  lastStreamEventAt: string | null;
}

export interface ProductionIngestionDependencies {
  createPool?: () => DbPool;
  createStream?: (apiKey: string, onError: (error: unknown) => void) => ProductionStreamClient;
  createController?: (pool: DbPool) => DurableInboxRuntimeController;
  persistEvent?: typeof persistRawEventToInbox;
  now?: () => string;
  apiKey?: string;
  logger?: (message: string) => void;
}

export interface ProductionIngestionOptions extends ProductionIngestionDependencies {
  confirmProductionIngestion: boolean;
  externalStopSignal?: AbortSignal;
  ingressCapacity?: number;
  workerPollMs?: number;
}

export interface ProductionControllerTestHooks {
  acquireGuard?: ConstructorParameters<typeof DurableInboxRuntimeController>[0]["acquireGuard"];
  preflight?: ConstructorParameters<typeof DurableInboxRuntimeController>[0]["preflight"];
  startupRecovery?: ConstructorParameters<typeof DurableInboxRuntimeController>[0]["startupRecovery"];
  getMetrics?: typeof getDurableInboxMetrics;
  runWorkerOnce?: ConstructorParameters<typeof DurableInboxRuntimeController>[0]["runWorkerOnce"];
}

export function createProductionInboxController(pool: DbPool, hooks: ProductionControllerTestHooks = {}): DurableInboxRuntimeController {
  return new DurableInboxRuntimeController({
    pool,
    runtimeMode: "durable_inbox",
    // Pending work is drainable work. Failed rows and unrecovered stale rows remain fatal.
    readinessPolicy: {
      maxFailed: 0,
      maxPendingDue: Number.MAX_SAFE_INTEGER,
      maxOldestDueAgeMs: Number.MAX_SAFE_INTEGER,
      maxStaleProcessing: 0
    },
    startupRecovery: hooks.startupRecovery ?? (async (targetPool, now) => { await prepareDurableInboxOnStartup(targetPool, now); }),
    acquireGuard: hooks.acquireGuard,
    preflight: hooks.preflight,
    getMetrics: hooks.getMetrics,
    runWorkerOnce: hooks.runWorkerOnce
  });
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/\b(password|token|secret|api[_-]?key|DATABASE_URL)\s*[=:]\s*[^,\s]+/gi, "$1=<REDACTED>");
}

export function productionDatabasePreflight(pool: DbPool): Promise<void> {
  return (async () => {
    const identity = (await pool.query<{ database: string; schema: string }>("SELECT current_database() AS database, current_schema() AS schema")).rows[0];
    if (!identity || identity.database !== PRODUCTION_DATABASE || identity.schema !== "public") throw new Error("PRODUCTION_DATABASE_IDENTITY_MISMATCH");
    const rows = await pool.query<{ table_name: string; present: boolean }>(
      `SELECT table_name, to_regclass('public.' || table_name) IS NOT NULL AS present
       FROM unnest($1::text[]) AS table_name`, [REQUIRED_TABLES]
    );
    const missing = REQUIRED_TABLES.filter((name) => !rows.rows.find((row) => row.table_name === name && row.present));
    if (missing.length > 0) throw new Error(`PRODUCTION_SCHEMA_PREREQUISITE_MISSING:${missing.join(",")}`);
  })();
}

function defaultStream(apiKey: string, onError: (error: unknown) => void): ProductionStreamClient {
  const storage = new LocalStorage("runtime/production_ingestion_local_storage");
  return createStreamClient(apiKey, storage, onError, LogLevel.INFO) as unknown as ProductionStreamClient;
}

function emptyCounters(): ProductionIngestionCounters {
  return { streamEventsObserved: 0, inboxInsertedPending: 0, inboxDuplicateExisting: 0, ingressErrors: 0, workerApplied: 0, workerReconciliationRequired: 0, workerFailed: 0, workerRuns: 0, workerIdle: 0, ingressQueueDepth: 0, ingressQueueHighWater: 0, ingressOverloadFatal: 0, lastStreamEventAt: null };
}

interface IngressItem { event: unknown; receivedAt: string; }

export class ProductionIngestionRuntime {
  readonly counters = emptyCounters();
  private pool: DbPool | null = null;
  private controller: DurableInboxRuntimeController | null = null;
  private stream: ProductionStreamClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private ingressQueue: IngressItem[] = [];
  private ingressActive = false;
  private ingressDrainPromise: Promise<void> | null = null;
  private workerPumpPromise: Promise<void> | null = null;
  private workerPumpStopping = false;
  private workerWake: (() => void) | null = null;
  private stopping = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;
  private readonly log: (message: string) => void;

  constructor(private readonly options: ProductionIngestionOptions) {
    this.log = options.logger ?? ((message) => console.info(message));
    if (!options.confirmProductionIngestion) throw new Error("--confirm-production-ingestion is required");
  }

  async start(): Promise<void> {
    if (this.pool) return;
    const apiKey = (this.options.apiKey ?? process.env.OPENSEA_API_KEY)?.trim();
    if (!apiKey) throw new Error("OPENSEA_API_KEY is required");
    this.pool = this.options.createPool?.() ?? createDatabasePool({ ...loadDatabaseConfig(), applicationName: "opensea_listings_v2_production_ingestion" });
    try {
      await productionDatabasePreflight(this.pool);
      this.controller = (this.options.createController ?? createProductionInboxController)(this.pool);
      await this.controller.start();
      this.stream = (this.options.createStream ?? defaultStream)(apiKey, (error) => this.log(`stream_error:${safeError(error)}`));
      this.unsubscribe = this.stream.onEvents(PRODUCTION_COLLECTION, [...PRODUCTION_EVENT_TYPES], (event) => this.acceptEvent(event));
      this.startWorkerPump();
      if (this.options.externalStopSignal) {
        if (this.options.externalStopSignal.aborted) await this.stop();
        else this.options.externalStopSignal.addEventListener("abort", () => { void this.stop(); }, { once: true });
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private acceptEvent(event: unknown): void {
    if (this.stopping) return;
    this.counters.streamEventsObserved += 1;
    this.counters.lastStreamEventAt = this.options.now?.() ?? new Date().toISOString();
    const capacity = this.options.ingressCapacity ?? DEFAULT_PRODUCTION_INGRESS_CAPACITY;
    const depth = this.ingressQueue.length + (this.ingressActive ? 1 : 0);
    if (depth >= capacity) {
      this.counters.ingressOverloadFatal += 1;
      this.log("ingress_overload_fatal");
      this.stopping = true;
      void this.stop();
      return;
    }
    this.ingressQueue.push({ event, receivedAt: this.counters.lastStreamEventAt });
    this.counters.ingressQueueDepth = this.ingressQueue.length + (this.ingressActive ? 1 : 0);
    this.counters.ingressQueueHighWater = Math.max(this.counters.ingressQueueHighWater, this.counters.ingressQueueDepth);
    this.startIngressDrain();
  }

  private startIngressDrain(): void {
    if (this.ingressDrainPromise) return;
    this.ingressDrainPromise = this.drainIngress().finally(() => { this.ingressDrainPromise = null; });
  }

  private async drainIngress(): Promise<void> {
    while (this.ingressQueue.length > 0) {
      const item = this.ingressQueue.shift()!;
      this.ingressActive = true;
      this.counters.ingressQueueDepth = this.ingressQueue.length + 1;
      try {
        const result: DurableInboxPersistResult = await (this.options.persistEvent ?? persistRawEventToInbox)(this.pool!, item.event, item.receivedAt);
        if (result.outcome === "inserted_pending") {
          this.counters.inboxInsertedPending += 1;
          this.wakeWorker();
        } else this.counters.inboxDuplicateExisting += 1;
      } catch (error) {
        this.counters.ingressErrors += 1;
        this.log(`ingress_error:${safeError(error)}`);
      } finally {
        this.ingressActive = false;
        this.counters.ingressQueueDepth = this.ingressQueue.length;
      }
    }
  }

  private startWorkerPump(): void {
    if (this.workerPumpPromise) return;
    this.workerPumpStopping = false;
    this.workerPumpPromise = this.workerPump().finally(() => { this.workerPumpPromise = null; });
  }

  private async workerPump(): Promise<void> {
    while (!this.workerPumpStopping) {
      try {
        const worker = await this.controller!.runOnce();
        this.counters.workerRuns += 1;
        if (worker.outcome === "idle") {
          this.counters.workerIdle += 1;
          await this.waitForWorkerWake();
        } else {
          if (worker.applyResult?.outcome === "applied") this.counters.workerApplied += 1;
          if (worker.applyResult?.outcome === "reconciliation_required") this.counters.workerReconciliationRequired += 1;
          if (worker.outcome === "non_retryable_failed" || worker.outcome === "retry_exhausted") this.counters.workerFailed += 1;
        }
      } catch (error) {
        this.counters.workerFailed += 1;
        this.log(`worker_error:${safeError(error)}`);
        this.workerPumpStopping = true;
        queueMicrotask(() => { void this.stop(); });
      }
    }
  }

  private wakeWorker(): void {
    const wake = this.workerWake;
    this.workerWake = null;
    wake?.();
  }

  private async waitForWorkerWake(): Promise<void> {
    if (this.workerPumpStopping) return;
    const pollMs = this.options.workerPollMs ?? DEFAULT_PRODUCTION_WORKER_POLL_MS;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.workerWake = null; resolve(); } }, pollMs);
      this.workerWake = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.stopped) return;
      this.stopping = true;
      try { this.unsubscribe?.(); } catch (error) { this.log(`unsubscribe_error:${safeError(error)}`); }
      this.unsubscribe = null;
      if (this.stream) await new Promise<void>((resolve) => { try { this.stream!.disconnect(resolve); } catch { resolve(); } });
      if (this.ingressDrainPromise) await this.ingressDrainPromise;
      this.workerPumpStopping = true;
      this.wakeWorker();
      if (this.workerPumpPromise) await this.workerPumpPromise;
      if (this.controller) await this.controller.stop();
      if (this.pool) await closeDatabasePool(this.pool);
      this.stopped = true;
    })();
    return this.stopPromise;
  }
}

export async function runProductionIngestion(options: ProductionIngestionOptions): Promise<ProductionIngestionCounters> {
  const runtime = new ProductionIngestionRuntime(options);
  await runtime.start();
  await new Promise<void>((resolve) => {
    const onSignal = () => { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); void runtime.stop().finally(resolve); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  return runtime.counters;
}
