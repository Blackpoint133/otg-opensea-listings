import { LogLevel } from "@opensea/stream-js";
import { LocalStorage } from "node-localstorage";
import { loadDatabaseConfig, createDatabasePool, closeDatabasePool } from "../db/pool.js";
import type { DbPool, DurableInboxPersistResult } from "../db/types.js";
import { persistRawEventToInbox } from "../db/durableInboxRepository.js";
import { getDurableInboxMetrics } from "../db/inboxRetryRepository.js";
import { prepareDurableInboxOnStartup } from "../worker/durableInboxWorker.js";
import { eventTypesForProfile } from "../eventTypes.js";
import { createStreamClient } from "../streamProbe.js";
import { redactString, serializeDiagnostic } from "../logger.js";
import { DurableInboxRuntimeController } from "./durableInboxRuntimeController.js";

export const PRODUCTION_COLLECTION = "off-the-grid";
export const PRODUCTION_DATABASE = "server_otg";
export const PRODUCTION_EVENT_TYPES = eventTypesForProfile("all");
export const DEFAULT_PRODUCTION_INGRESS_CAPACITY = 256;
export const DEFAULT_PRODUCTION_WORKER_POLL_MS = 1_000;
export const DEFAULT_PRODUCTION_DISCONNECT_TIMEOUT_MS = 5_000;
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
  /** Production adapters resolve only after socket OPEN and channel JOINED. */
  waitUntilReady?(timeoutMs?: number): Promise<void>;
  /** Marks SDK leave/close callbacks as expected operator shutdown. */
  beginExpectedShutdown?(): void;
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
  streamErrors: number;
  lastStreamEventAt: string | null;
}

export type ProductionTerminationReason = "OPERATOR_STOP" | "EXTERNAL_ABORT" | "INGRESS_OVERLOAD" | "INGRESS_PERSISTENCE_FAILURE" | "STREAM_ERROR" | "WORKER_ERROR";

export interface ProductionTermination {
  readonly reason: ProductionTerminationReason;
  readonly fatal: boolean;
  readonly fatalDiagnostic: string | null;
  readonly counters: Readonly<ProductionIngestionCounters>;
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
  streamDisconnectTimeoutMs?: number;
  streamReadyTimeoutMs?: number;
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

const MAX_RUNTIME_DIAGNOSTIC = 2_000;
export const DEFAULT_PRODUCTION_STREAM_READY_TIMEOUT_MS = 15_000;

/** Formats SDK/runtime failures without exposing raw payloads or secrets. */
export function formatProductionRuntimeDiagnostic(error: unknown): string {
  let text: string;
  try {
    if (typeof error === "string") text = redactString(error);
    else if (error === null) text = "null";
    else if (error === undefined) text = "undefined";
    else if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") text = String(error);
    else text = JSON.stringify(serializeDiagnostic(error));
  } catch {
    text = "<UNSERIALIZABLE_DIAGNOSTIC>";
  }
  return redactString(text).slice(0, MAX_RUNTIME_DIAGNOSTIC);
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

interface ProductionSdkSocketLike {
  onOpen(callback: () => void): unknown;
  onClose(callback: (event?: unknown) => void): unknown;
  onError(callback: (error: unknown) => void): unknown;
}

interface ProductionSdkChannelLike {
  joinPush?: { receive(status: string, callback: (response?: unknown) => void): unknown };
  onError?(callback: (reason?: unknown) => void): unknown;
  onClose?(callback: (reason?: unknown) => void): unknown;
}

interface ProductionSdkClientLike {
  readonly socket?: ProductionSdkSocketLike;
  onEvents(collection: string, events: readonly string[], callback: (event: unknown) => void): () => void;
  disconnect(callback?: () => void): void;
  getChannel?(topic: string, events?: readonly string[]): ProductionSdkChannelLike | undefined;
}

/**
 * Adapts the pinned stream-js/Phoenix object to a one-epoch production
 * contract. Private SDK fields are deliberately validated at this boundary;
 * an uninstrumentable client is never treated as ready.
 */
export function createProductionStreamAdapter(client: unknown, onFailure: (error: unknown) => void): ProductionStreamClient {
  const sdk = client as Partial<ProductionSdkClientLike> | null;
  const socket = sdk?.socket;
  if (!sdk || !socket || typeof sdk.onEvents !== "function" || typeof sdk.disconnect !== "function" || typeof socket.onOpen !== "function" || typeof socket.onClose !== "function" || typeof socket.onError !== "function" || typeof sdk.getChannel !== "function") {
    throw new Error("STREAM_LIFECYCLE_INSTRUMENTATION_UNAVAILABLE");
  }

  let expectedShutdown = false;
  let failed = false;
  let socketOpened = false;
  let channelJoined = false;
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const fail = (error: unknown): void => {
    if (expectedShutdown || failed) return;
    failed = true;
    rejectReady(error);
    onFailure(error);
  };
  const maybeReady = (): void => {
    if (!failed && socketOpened && channelJoined && !ready) {
      ready = true;
      resolveReady();
    }
  };

  socket.onOpen(() => {
    if (socketOpened) {
      fail({ code: "STREAM_CONTINUITY_LOST", reason: "second transport epoch opened" });
      return;
    }
    socketOpened = true;
    maybeReady();
  });
  socket.onClose((event) => {
    if (expectedShutdown) return;
    fail({ code: "STREAM_CONTINUITY_LOST", reason: "unexpected socket close", close: event ?? null });
  });
  socket.onError((error) => { if (!expectedShutdown) fail(error); });

  let channel: ProductionSdkChannelLike | undefined;
  let subscribed = false;
  const attachChannelLifecycle = (candidate: ProductionSdkChannelLike | undefined): void => {
    if (!candidate || subscribed) return;
    if (!candidate.joinPush || typeof candidate.joinPush.receive !== "function" || typeof candidate.onError !== "function" || typeof candidate.onClose !== "function") throw new Error("STREAM_LIFECYCLE_INSTRUMENTATION_UNAVAILABLE");
    channel = candidate;
    subscribed = true;
    candidate.joinPush.receive("ok", () => { channelJoined = true; maybeReady(); });
    candidate.joinPush.receive("error", (reason) => fail({ code: "STREAM_CHANNEL_JOIN_ERROR", reason: reason ?? null }));
    candidate.joinPush.receive("timeout", (reason) => fail({ code: "STREAM_CHANNEL_JOIN_TIMEOUT", reason: reason ?? null }));
    candidate.onError((reason) => fail({ code: "STREAM_CHANNEL_ERROR", reason: reason ?? null }));
    candidate.onClose((reason) => fail({ code: "STREAM_CHANNEL_CLOSE", reason: reason ?? null }));
  };

  return {
    onEvents(collection, events, callback) {
      const unsubscribe = sdk.onEvents!(collection, events, callback);
      attachChannelLifecycle(sdk.getChannel!( `collection:${collection}`, events));
      if (!channel) throw new Error("STREAM_LIFECYCLE_INSTRUMENTATION_UNAVAILABLE");
      return unsubscribe;
    },
    waitUntilReady(timeoutMs = DEFAULT_PRODUCTION_STREAM_READY_TIMEOUT_MS) {
      if (ready) return Promise.resolve();
      const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PRODUCTION_STREAM_READY_TIMEOUT_MS;
      const timeout = setTimeout(() => fail({ code: "STREAM_READINESS_TIMEOUT", timeoutMs: bounded }), bounded);
      return readyPromise.finally(() => clearTimeout(timeout));
    },
    beginExpectedShutdown() { expectedShutdown = true; },
    disconnect(callback) { expectedShutdown = true; sdk.disconnect!(callback); }
  };
}

function defaultStream(apiKey: string, onError: (error: unknown) => void): ProductionStreamClient {
  const storage = new LocalStorage("runtime/production_ingestion_local_storage");
  return createProductionStreamAdapter(createStreamClient(apiKey, storage, onError, LogLevel.INFO), onError);
}

function emptyCounters(): ProductionIngestionCounters {
  return { streamEventsObserved: 0, inboxInsertedPending: 0, inboxDuplicateExisting: 0, ingressErrors: 0, workerApplied: 0, workerReconciliationRequired: 0, workerFailed: 0, workerRuns: 0, workerIdle: 0, ingressQueueDepth: 0, ingressQueueHighWater: 0, ingressOverloadFatal: 0, streamErrors: 0, lastStreamEventAt: null };
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
  private termination: ProductionTermination | null = null;
  private readonly terminationPromise: Promise<ProductionTermination>;
  private resolveTermination!: (termination: ProductionTermination) => void;
  private terminationReason: ProductionTerminationReason | null = null;
  private terminationFatal = false;
  private fatalDiagnostic: string | null = null;
  private streamReady = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: ProductionIngestionOptions) {
    this.log = options.logger ?? ((message) => console.info(message));
    if (!options.confirmProductionIngestion) throw new Error("--confirm-production-ingestion is required");
    this.terminationPromise = new Promise<ProductionTermination>((resolve) => { this.resolveTermination = resolve; });
  }

  waitForTermination(): Promise<ProductionTermination> { return this.terminationPromise; }

  private failClosed(reason: Exclude<ProductionTerminationReason, "OPERATOR_STOP" | "EXTERNAL_ABORT">, error?: unknown): void {
    if (this.terminationFatal) return;
    this.terminationReason = reason;
    this.terminationFatal = true;
    this.stopping = true;
    this.streamReady = false;
    if (error !== undefined) {
      const diagnostic = formatProductionRuntimeDiagnostic(error);
      if (this.fatalDiagnostic === null) this.fatalDiagnostic = diagnostic;
      this.log(`${reason.toLowerCase()}:${diagnostic}`);
    }
    queueMicrotask(() => { void this.stop().catch(() => { /* cleanup remains best-effort and termination is resolved by stop */ }); });
  }

  private requestStop(reason: "OPERATOR_STOP" | "EXTERNAL_ABORT"): void {
    if (this.terminationReason === null) this.terminationReason = reason;
    this.stopping = true;
    this.wakeWorker();
    queueMicrotask(() => { void this.stop().catch(() => { /* cleanup path records terminal state */ }); });
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
      this.stream = (this.options.createStream ?? defaultStream)(apiKey, (error) => {
        this.counters.streamErrors += 1;
        this.failClosed("STREAM_ERROR", error);
      });
      this.unsubscribe = this.stream.onEvents(PRODUCTION_COLLECTION, [...PRODUCTION_EVENT_TYPES], (event) => this.acceptEvent(event));
      if (this.stream.waitUntilReady) await this.stream.waitUntilReady(this.options.streamReadyTimeoutMs ?? DEFAULT_PRODUCTION_STREAM_READY_TIMEOUT_MS);
      this.streamReady = true;
      if (this.terminationFatal) throw new Error("STREAM_ERROR_DURING_STARTUP");
      this.startWorkerPump();
      if (this.options.externalStopSignal) {
        if (this.options.externalStopSignal.aborted) this.requestStop("EXTERNAL_ABORT");
        else this.options.externalStopSignal.addEventListener("abort", () => this.requestStop("EXTERNAL_ABORT"), { once: true });
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private acceptEvent(event: unknown): void {
    if (this.stopping || !this.streamReady) return;
    this.counters.streamEventsObserved += 1;
    this.counters.lastStreamEventAt = this.options.now?.() ?? new Date().toISOString();
    const capacity = this.options.ingressCapacity ?? DEFAULT_PRODUCTION_INGRESS_CAPACITY;
    const depth = this.ingressQueue.length + (this.ingressActive ? 1 : 0);
    if (depth >= capacity) {
      this.counters.ingressOverloadFatal += 1;
      this.log("ingress_overload_fatal");
      this.failClosed("INGRESS_OVERLOAD");
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
        this.log(`ingress_error:${formatProductionRuntimeDiagnostic(error)}`);
        this.failClosed("INGRESS_PERSISTENCE_FAILURE", error);
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
        this.log(`worker_error:${formatProductionRuntimeDiagnostic(error)}`);
        this.workerPumpStopping = true;
        this.failClosed("WORKER_ERROR", error);
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
      if (this.terminationReason === null) this.terminationReason = "OPERATOR_STOP";
      this.stopping = true;
      this.streamReady = false;
      this.stream?.beginExpectedShutdown?.();
      try { this.unsubscribe?.(); } catch (error) { this.log(`unsubscribe_error:${formatProductionRuntimeDiagnostic(error)}`); }
      this.unsubscribe = null;
      if (this.stream) {
        const timeoutMs = this.options.streamDisconnectTimeoutMs ?? DEFAULT_PRODUCTION_DISCONNECT_TIMEOUT_MS;
        await Promise.race([
          new Promise<void>((resolve) => { try { this.stream!.disconnect(resolve); } catch { resolve(); } }),
          new Promise<void>((resolve) => setTimeout(() => { this.log("stream_disconnect_timeout"); resolve(); }, timeoutMs))
        ]);
      }
      if (this.ingressDrainPromise) await this.ingressDrainPromise;
      this.workerPumpStopping = true;
      this.wakeWorker();
      if (this.workerPumpPromise) await this.workerPumpPromise;
      try { if (this.controller) await this.controller.stop(); } catch (error) { this.log(`controller_stop_error:${formatProductionRuntimeDiagnostic(error)}`); }
      try { if (this.pool) await closeDatabasePool(this.pool); } catch (error) { this.log(`pool_close_error:${formatProductionRuntimeDiagnostic(error)}`); }
      this.stopped = true;
      const termination: ProductionTermination = Object.freeze({ reason: this.terminationReason!, fatal: this.terminationFatal, fatalDiagnostic: this.fatalDiagnostic, counters: Object.freeze({ ...this.counters }) });
      this.termination = termination;
      this.resolveTermination(termination);
    })();
    return this.stopPromise;
  }
}

export async function runProductionIngestion(options: ProductionIngestionOptions): Promise<ProductionIngestionCounters> {
  const runtime = new ProductionIngestionRuntime(options);
  await runtime.start();
  const onSignal = () => { void runtime.stop(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await runtime.waitForTermination();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return runtime.counters;
}
