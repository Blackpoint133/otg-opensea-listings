import { LogLevel } from "@opensea/stream-js";
import { LocalStorage } from "node-localstorage";
import { loadDatabaseConfig, createDatabasePool, closeDatabasePool } from "../db/pool.js";
import type { DbPool, DurableInboxPersistResult } from "../db/types.js";
import { persistRawEventToInbox } from "../db/durableInboxRepository.js";
import { eventTypesForProfile } from "../eventTypes.js";
import { createStreamClient } from "../streamProbe.js";
import { DurableInboxRuntimeController } from "./durableInboxRuntimeController.js";

export const PRODUCTION_COLLECTION = "off-the-grid";
export const PRODUCTION_DATABASE = "server_otg";
export const PRODUCTION_EVENT_TYPES = eventTypesForProfile("all");
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
  return { streamEventsObserved: 0, inboxInsertedPending: 0, inboxDuplicateExisting: 0, ingressErrors: 0, workerApplied: 0, workerReconciliationRequired: 0, workerFailed: 0, lastStreamEventAt: null };
}

export class ProductionIngestionRuntime {
  readonly counters = emptyCounters();
  private pool: DbPool | null = null;
  private controller: DurableInboxRuntimeController | null = null;
  private stream: ProductionStreamClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private ingressChain: Promise<void> = Promise.resolve();
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
      this.controller = (this.options.createController ?? ((pool) => new DurableInboxRuntimeController({ pool, runtimeMode: "durable_inbox" })))(this.pool);
      await this.controller.start();
      await this.runWorkerOnce();
      this.stream = (this.options.createStream ?? defaultStream)(apiKey, (error) => this.log(`stream_error:${safeError(error)}`));
      this.unsubscribe = this.stream.onEvents(PRODUCTION_COLLECTION, [...PRODUCTION_EVENT_TYPES], (event) => this.acceptEvent(event));
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
    const receivedAt = this.counters.lastStreamEventAt;
    this.ingressChain = this.ingressChain.then(async () => {
      try {
        const result: DurableInboxPersistResult = await (this.options.persistEvent ?? persistRawEventToInbox)(this.pool!, event, receivedAt!);
        if (result.outcome === "inserted_pending") this.counters.inboxInsertedPending += 1;
        else this.counters.inboxDuplicateExisting += 1;
        await this.runWorkerOnce();
      } catch (error) {
        this.counters.ingressErrors += 1;
        this.log(`ingress_error:${safeError(error)}`);
      }
    });
    this.ingressChain.catch(() => { /* the chain body is defensive; retain a settled chain */ });
  }

  private async runWorkerOnce(): Promise<void> {
    const worker = await this.controller?.runOnce();
    if (worker?.applyResult?.outcome === "applied") this.counters.workerApplied += 1;
    if (worker?.applyResult?.outcome === "reconciliation_required") this.counters.workerReconciliationRequired += 1;
    if (worker?.outcome === "non_retryable_failed" || worker?.outcome === "retry_exhausted") this.counters.workerFailed += 1;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.stopped) return;
      this.stopping = true;
      try { this.unsubscribe?.(); } catch (error) { this.log(`unsubscribe_error:${safeError(error)}`); }
      this.unsubscribe = null;
      if (this.stream) await new Promise<void>((resolve) => { try { this.stream!.disconnect(resolve); } catch { resolve(); } });
      await this.ingressChain;
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
