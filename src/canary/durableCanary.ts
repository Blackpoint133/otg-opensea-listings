import { LocalStorage } from "node-localstorage";
import { LogLevel } from "@opensea/stream-js";
import { createDatabasePool, loadDatabaseConfig } from "../db/pool.js";
import { persistRawEventToInbox } from "../db/durableInboxRepository.js";
import type { DbPool, DurableInboxPersistResult, JournalProcessingStatus } from "../db/types.js";
import { eventTypesForProfile } from "../eventTypes.js";
import { redactString } from "../logger.js";
import { createStreamClient } from "../streamProbe.js";
import { DurableInboxRuntimeController, type DurableInboxRuntimeSummary } from "../runtime/durableInboxRuntimeController.js";
import type { DurableInboxWorkerOnceResult } from "../worker/durableInboxWorker.js";

export const DURABLE_CANARY_EXPECTED_DATABASE = "server_otg" as const;
export const DURABLE_CANARY_RUNTIME_MODE = "durable_inbox" as const;
export const DURABLE_CANARY_COLLECTION_SLUG = "off-the-grid" as const;
export const DURABLE_CANARY_CHAIN = "gunzilla" as const;
export const DURABLE_CANARY_CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" as const;
export const DURABLE_CANARY_EVENT_TYPES = eventTypesForProfile("all");

const DEFAULT_DURATION_MINUTES = 5;
const DEFAULT_MAX_EVENTS = 25;
const DEFAULT_QUEUE_CAPACITY = 100;
const DEFAULT_MAX_DRAIN_WORKER_RUNS = 100;
const DEFAULT_DRAIN_TIMEOUT_MS = 120_000;
const MAX_DURATION_MINUTES = 30;
const MAX_EVENTS = 250;
const MAX_QUEUE_CAPACITY = 1_000;
const STREAM_DISCONNECT_TIMEOUT_MS = 5_000;

export interface DurableCanaryConfig {
  apiKey: string;
  durationMinutes: number;
  durationMs: number;
  maxEvents: number;
  queueCapacity: number;
  maxDrainWorkerRuns: number;
  drainTimeoutMs: number;
  collectionSlug: typeof DURABLE_CANARY_COLLECTION_SLUG;
  chain: typeof DURABLE_CANARY_CHAIN;
  contractAddress: typeof DURABLE_CANARY_CONTRACT;
  expectedDatabase: typeof DURABLE_CANARY_EXPECTED_DATABASE;
  runtimeMode: typeof DURABLE_CANARY_RUNTIME_MODE;
  localStorageDir: string;
  confirmLive: true;
  confirmDurable: true;
  confirmServerOtg: true;
}

export type DurableCanaryStopReason =
  | "duration_reached"
  | "max_events_reached"
  | "queue_capacity_exceeded"
  | "runtime_not_ready"
  | "runtime_conflict"
  | "stream_error"
  | "operator_abort"
  | "startup_failure"
  | "txa_error"
  | "drain_incomplete";

export type DurableCanaryResult = "DURABLE_CANARY_FAILED" | "DURABLE_CANARY_COMPLETED" | "DURABLE_CANARY_DRAIN_INCOMPLETE";

export interface DurableCanaryCounters {
  streamEventsObserved: number;
  streamEventsMatchedContract: number;
  txAAdmissionAccepted: number;
  txAInsertedPending: number;
  txADuplicateExisting: number;
  txAErrors: number;
  workerRuns: number;
  workerProcessed: number;
  workerIdle: number;
  workerRetryScheduled: number;
  workerRetryExhausted: number;
  workerErrors: number;
  reconciliationRequired: number;
  queueSignalsAccepted: number;
  queueSignalsDropped: number;
  streamErrors: number;
}

export interface DurableCanaryEvidence {
  database: string;
  counts: {
    orders: number;
    nftState: number;
    journal: number;
    attemptLedger: number;
    unfinalized: number;
  };
  lifecycle: Array<{ processingStatus: JournalProcessingStatus; attemptCount: number; count: number }>;
  pendingDue: number;
  pendingScheduled: number;
  failed: number;
  reconciliationRequired: number;
  eventIds: string[];
  signature: string | null;
  v1Exists: boolean;
}

export interface DurableCanaryPreExistingRowsPreservation {
  expectedCount: number;
  actualCount: number;
  sameIdCount: boolean;
  sameIdSet: boolean;
  sameSignature: boolean;
  missingEventIds: string[];
  unexpectedEventIds: string[];
  preserved: boolean;
}

export interface DurableCanarySummary {
  result: DurableCanaryResult;
  stopReason: DurableCanaryStopReason | null;
  startedAt: string;
  stoppedAt: string | null;
  durationMs: number;
  runtimeMode: typeof DURABLE_CANARY_RUNTIME_MODE;
  guardAcquired: boolean;
  streamConnected: boolean;
  counters: DurableCanaryCounters;
  drain: {
    completed: boolean;
    workerRuns: number;
    timedOut: boolean;
    pendingDueAfterDrain: number | null;
    pendingScheduledAfterDrain: number | null;
  };
  controller: DurableInboxRuntimeSummary | null;
  preRunEvidence: DurableCanaryEvidence | null;
  postRunEvidence: DurableCanaryEvidence | null;
  preExistingRowsPreserved: boolean | null;
  preExistingRowsPreservation: DurableCanaryPreExistingRowsPreservation | null;
  sanitizedErrors: string[];
  cleanupErrors: string[];
  cleanup: {
    controllerStopAttempted: boolean;
    controllerStopped: boolean;
    poolEndAttempted: boolean;
    poolEnded: boolean;
  };
}

interface CanaryStreamClient {
  onEvents(collection: string, events: readonly string[], callback: (event: unknown) => void): () => void;
  disconnect(callback?: () => void): void;
}

export interface DurableCanaryDependencies {
  createPool?: () => DbPool;
  createController?: (pool: DbPool, config: DurableCanaryConfig) => DurableInboxRuntimeController;
  createStream?: (config: DurableCanaryConfig, onError: (error: unknown) => void) => CanaryStreamClient;
  persistEvent?: typeof persistRawEventToInbox;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => string;
  externalStopSignal?: AbortSignal;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number, max: number): number {
  const text = value === undefined ? String(fallback) : value;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  if (parsed > max) throw new Error(`${name} exceeds hard maximum ${max}`);
  return parsed;
}

function requireGate(value: boolean, name: string): true {
  if (!value) throw new Error(`${name} confirmation is required`);
  return true;
}

function sanitize(value: unknown): string {
  return redactString(value instanceof Error ? `${value.name}: ${value.message}` : String(value))
    .replace(/\b(password|token|secret|api[_-]?key)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>")
    .replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>");
}

export function loadDurableCanaryConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): DurableCanaryConfig {
  let durationText = env.OPENSEA_V2_DURABLE_CANARY_DURATION_MINUTES;
  let maxEventsText = env.OPENSEA_V2_DURABLE_CANARY_MAX_EVENTS;
  let queueCapacityText = env.OPENSEA_V2_DURABLE_CANARY_QUEUE_CAPACITY;
  let maxDrainRunsText = env.OPENSEA_V2_DURABLE_CANARY_MAX_DRAIN_WORKER_RUNS;
  let drainTimeoutText = env.OPENSEA_V2_DURABLE_CANARY_DRAIN_TIMEOUT_MS;
  let confirmLive = false;
  let confirmDurable = false;
  let confirmServerOtg = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm-live") confirmLive = true;
    else if (arg === "--confirm-durable") confirmDurable = true;
    else if (arg === "--confirm-server-otg") confirmServerOtg = true;
    else if (arg === "--duration-minutes") durationText = argv[++i];
    else if (arg === "--max-events") maxEventsText = argv[++i];
    else if (arg === "--queue-capacity") queueCapacityText = argv[++i];
    else if (arg === "--max-drain-worker-runs") maxDrainRunsText = argv[++i];
    else if (arg === "--drain-timeout-ms") drainTimeoutText = argv[++i];
    else if (arg === "--runtime-mode" || arg === "--database" || arg === "--collection" || arg === "--contract" || arg === "--chain") throw new Error(`${arg} is hard pinned for durable canary`);
    else throw new Error(`Unknown durable canary argument: ${arg}`);
  }

  const apiKey = env.OPENSEA_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENSEA_API_KEY is required");
  const durationMinutes = parsePositiveInteger(durationText, "duration-minutes", DEFAULT_DURATION_MINUTES, MAX_DURATION_MINUTES);
  const maxEvents = parsePositiveInteger(maxEventsText, "max-events", DEFAULT_MAX_EVENTS, MAX_EVENTS);
  const queueCapacity = parsePositiveInteger(queueCapacityText, "queue-capacity", DEFAULT_QUEUE_CAPACITY, MAX_QUEUE_CAPACITY);
  return {
    apiKey,
    durationMinutes,
    durationMs: durationMinutes * 60_000,
    maxEvents,
    queueCapacity,
    maxDrainWorkerRuns: parsePositiveInteger(maxDrainRunsText, "max-drain-worker-runs", DEFAULT_MAX_DRAIN_WORKER_RUNS, 10_000),
    drainTimeoutMs: parsePositiveInteger(drainTimeoutText, "drain-timeout-ms", DEFAULT_DRAIN_TIMEOUT_MS, 3_600_000),
    collectionSlug: DURABLE_CANARY_COLLECTION_SLUG,
    chain: DURABLE_CANARY_CHAIN,
    contractAddress: DURABLE_CANARY_CONTRACT,
    expectedDatabase: DURABLE_CANARY_EXPECTED_DATABASE,
    runtimeMode: DURABLE_CANARY_RUNTIME_MODE,
    localStorageDir: "runtime/durable_canary_local_storage",
    confirmLive: requireGate(confirmLive, "--confirm-live"),
    confirmDurable: requireGate(confirmDurable, "--confirm-durable"),
    confirmServerOtg: requireGate(confirmServerOtg, "--confirm-server-otg")
  };
}

function emptyCounters(): DurableCanaryCounters {
  return {
    streamEventsObserved: 0,
    streamEventsMatchedContract: 0,
    txAAdmissionAccepted: 0,
    txAInsertedPending: 0,
    txADuplicateExisting: 0,
    txAErrors: 0,
    workerRuns: 0,
    workerProcessed: 0,
    workerIdle: 0,
    workerRetryScheduled: 0,
    workerRetryExhausted: 0,
    workerErrors: 0,
    reconciliationRequired: 0,
    queueSignalsAccepted: 0,
    queueSignalsDropped: 0,
    streamErrors: 0
  };
}

function createDurableCanaryPool(config: DurableCanaryConfig): DbPool {
  const dbConfig = loadDatabaseConfig();
  const executionTimeoutMs = Math.max(1, Math.min(config.drainTimeoutMs, 300_000));
  return createDatabasePool({
    ...dbConfig,
    applicationName: "opensea_listings_v2_durable_canary",
    statementTimeoutMillis: executionTimeoutMs,
    lockTimeoutMillis: executionTimeoutMs,
    queryTimeoutMillis: executionTimeoutMs
  });
}

function defaultCreateStream(config: DurableCanaryConfig, onError: (error: unknown) => void): CanaryStreamClient {
  const storage = new LocalStorage(config.localStorageDir);
  return createStreamClient(config.apiKey, storage, onError, LogLevel.INFO) as unknown as CanaryStreamClient;
}

function defaultCreateController(pool: DbPool, _config: DurableCanaryConfig): DurableInboxRuntimeController {
  return new DurableInboxRuntimeController({ pool, runtimeMode: DURABLE_CANARY_RUNTIME_MODE });
}

function isContractedEvent(rawEvent: unknown): boolean {
  const eventType = (rawEvent as { event_type?: unknown } | null)?.event_type;
  return typeof eventType === "string" && (DURABLE_CANARY_EVENT_TYPES as readonly string[]).includes(eventType);
}

function countWorkerResult(counters: DurableCanaryCounters, result: DurableInboxWorkerOnceResult): void {
  counters.workerRuns += 1;
  if (result.outcome === "idle") counters.workerIdle += 1;
  else if (result.outcome === "processed") counters.workerProcessed += 1;
  else if (result.outcome === "retry_scheduled") counters.workerRetryScheduled += 1;
  else if (result.outcome === "retry_exhausted") counters.workerRetryExhausted += 1;
  if (result.applyResult?.outcome === "reconciliation_required") counters.reconciliationRequired += 1;
}

function countTxA(counters: DurableCanaryCounters, result: DurableInboxPersistResult): void {
  if (result.outcome === "inserted_pending") counters.txAInsertedPending += 1;
  else counters.txADuplicateExisting += 1;
}

export async function collectDurableCanaryEvidence(pool: DbPool, eventIds?: readonly string[]): Promise<DurableCanaryEvidence> {
  const database = (await pool.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database ?? "";
  const counts = (await pool.query<{
    orders: number;
    nft_state: number;
    journal: number;
    attempt_ledger: number;
    unfinalized: number;
    pending_due: number;
    pending_scheduled: number;
    failed: number;
    reconciliation_required: number;
  }>(
    `SELECT
      (SELECT COUNT(*)::int FROM public.opensea_listings_v2) AS orders,
      (SELECT COUNT(*)::int FROM public.opensea_listings_nft_state_v2) AS nft_state,
      (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2) AS journal,
      (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2_attempts) AS attempt_ledger,
      (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2 WHERE apply_result IS NULL) AS unfinalized,
      (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='pending' AND (next_retry_at IS NULL OR next_retry_at <= now())) AS pending_due,
      (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='pending' AND next_retry_at > now()) AS pending_scheduled,
      (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='failed') AS failed,
      (SELECT COUNT(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='reconciliation_required') AS reconciliation_required`
  )).rows[0];
  const lifecycle = (await pool.query<{ processing_status: JournalProcessingStatus; attempt_count: number; count: number }>(
    `SELECT processing_status, attempt_count, COUNT(*)::int AS count
     FROM public.opensea_listings_events_v2
     GROUP BY processing_status, attempt_count
     ORDER BY processing_status, attempt_count`
  )).rows.map((row) => ({ processingStatus: row.processing_status, attemptCount: row.attempt_count, count: row.count }));
  const ids = eventIds
    ? eventIds.length === 0
      ? []
      : (await pool.query<{ event_id: string }>(
        "SELECT event_id::text FROM public.opensea_listings_events_v2 WHERE event_id = ANY($1::bigint[]) ORDER BY event_id",
        [[...eventIds]]
      )).rows.map((row) => row.event_id)
    : (await pool.query<{ event_id: string }>("SELECT event_id::text FROM public.opensea_listings_events_v2 ORDER BY event_id")).rows.map((row) => row.event_id);
  const signature = ids.length === 0
    ? null
    : (await pool.query<{ signature: string }>(
      `SELECT md5(string_agg(event_id::text || '|' || dedupe_key || '|' || payload_hash || '|' || md5(raw_payload::text) || '|' || coalesce(apply_result,'') || '|' || coalesce(applied_at::text,''), E'\n' ORDER BY event_id)) AS signature
       FROM public.opensea_listings_events_v2
       WHERE event_id = ANY($1::bigint[])`,
      [ids]
    )).rows[0]?.signature ?? null;
  const v1Exists = Boolean((await pool.query<{ exists: boolean }>("SELECT to_regclass('public.opensea_listings') IS NOT NULL AS exists")).rows[0]?.exists);
  return {
    database,
    counts: {
      orders: counts?.orders ?? 0,
      nftState: counts?.nft_state ?? 0,
      journal: counts?.journal ?? 0,
      attemptLedger: counts?.attempt_ledger ?? 0,
      unfinalized: counts?.unfinalized ?? 0
    },
    lifecycle,
    pendingDue: counts?.pending_due ?? 0,
    pendingScheduled: counts?.pending_scheduled ?? 0,
    failed: counts?.failed ?? 0,
    reconciliationRequired: counts?.reconciliation_required ?? 0,
    eventIds: ids,
    signature,
    v1Exists
  };
}

export function comparePreExistingRows(
  preRunEvidence: DurableCanaryEvidence,
  postRunEvidence: DurableCanaryEvidence
): DurableCanaryPreExistingRowsPreservation {
  const expectedIds = [...preRunEvidence.eventIds].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  const actualIds = [...postRunEvidence.eventIds].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  const actualSet = new Set(actualIds);
  const expectedSet = new Set(expectedIds);
  const missingEventIds = expectedIds.filter((id) => !actualSet.has(id));
  const unexpectedEventIds = actualIds.filter((id) => !expectedSet.has(id));
  const sameIdCount = expectedIds.length === actualIds.length;
  const sameIdSet = missingEventIds.length === 0 && unexpectedEventIds.length === 0;
  const sameSignature = preRunEvidence.signature === postRunEvidence.signature;
  return {
    expectedCount: expectedIds.length,
    actualCount: actualIds.length,
    sameIdCount,
    sameIdSet,
    sameSignature,
    missingEventIds,
    unexpectedEventIds,
    preserved: sameIdCount && sameIdSet && sameSignature
  };
}

function classifySummary(summary: DurableCanarySummary): DurableCanaryResult {
  if (summary.stopReason === "drain_incomplete") return "DURABLE_CANARY_DRAIN_INCOMPLETE";
  if (summary.sanitizedErrors.length > 0 || summary.cleanupErrors.length > 0 || !summary.guardAcquired || !summary.streamConnected || summary.preExistingRowsPreserved === false) return "DURABLE_CANARY_FAILED";
  if (summary.counters.txAErrors > 0 || summary.counters.workerErrors > 0) return "DURABLE_CANARY_FAILED";
  return "DURABLE_CANARY_COMPLETED";
}

export async function runDurableCanary(config: DurableCanaryConfig, dependencies: DurableCanaryDependencies = {}): Promise<DurableCanarySummary> {
  const startedAtMs = Date.now();
  const startedAt = dependencies.now?.() ?? new Date(startedAtMs).toISOString();
  const counters = emptyCounters();
  const sanitizedErrors: string[] = [];
  const cleanupErrors: string[] = [];
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopReason: DurableCanaryStopReason | null = null;
  let stopping = false;
  let durationTimer: unknown;
  let pool: DbPool | null = null;
  let controller: DurableInboxRuntimeController | null = null;
  let stream: CanaryStreamClient | null = null;
  let unsubscribe: (() => void) | null = null;
  const txAInFlight = new Set<Promise<void>>();
  let streamConnected = false;
  let preRunEvidence: DurableCanaryEvidence | null = null;
  let postRunEvidence: DurableCanaryEvidence | null = null;
  let controllerSummary: DurableInboxRuntimeSummary | null = null;
  let controllerReady = false;
  let guardAcquired = false;
  let workerChain: Promise<void> = Promise.resolve();
  const drain = { completed: false, workerRuns: 0, timedOut: false, pendingDueAfterDrain: null as number | null, pendingScheduledAfterDrain: null as number | null };
  const cleanup = { controllerStopAttempted: false, controllerStopped: false, poolEndAttempted: false, poolEnded: false };

  const requestStop = (reason: DurableCanaryStopReason): void => {
    stopReason ??= reason;
    stopping = true;
  };

  const abortHandler = (): void => requestStop("operator_abort");
  if (dependencies.externalStopSignal) {
    if (dependencies.externalStopSignal.aborted) abortHandler();
    else dependencies.externalStopSignal.addEventListener("abort", abortHandler, { once: true });
  }

  const runWorkerOnce = async (): Promise<DurableInboxWorkerOnceResult | null> => {
    if (!controller) return null;
    try {
      const result = await controller.runOnce();
      countWorkerResult(counters, result);
      return result;
    } catch (error) {
      counters.workerErrors += 1;
      sanitizedErrors.push(`worker:${sanitize(error)}`);
      requestStop("startup_failure");
      return null;
    }
  };

  const scheduleWorkerOnce = (): Promise<void> => {
    workerChain = workerChain.then(async () => { await runWorkerOnce(); }, async () => { await runWorkerOnce(); });
    return workerChain;
  };

  const admitEvent = (event: unknown): void => {
    counters.streamEventsObserved += 1;
    if (!isContractedEvent(event)) return;
    counters.streamEventsMatchedContract += 1;
    if (stopping) return;
    if (counters.txAAdmissionAccepted >= config.maxEvents) {
      requestStop("max_events_reached");
      return;
    }
    if (txAInFlight.size >= config.queueCapacity) {
      counters.queueSignalsDropped += 1;
      requestStop("queue_capacity_exceeded");
      return;
    }
    counters.txAAdmissionAccepted += 1;
    counters.queueSignalsAccepted += 1;
    const receivedAt = dependencies.now?.() ?? new Date().toISOString();
    const task = (async () => {
      try {
        const result = await (dependencies.persistEvent ?? persistRawEventToInbox)(pool!, event, receivedAt);
        countTxA(counters, result);
        await scheduleWorkerOnce();
      } catch (error) {
        counters.txAErrors += 1;
        sanitizedErrors.push(`txa:${sanitize(error)}`);
        requestStop("txa_error");
      }
    })();
    txAInFlight.add(task);
    task.finally(() => txAInFlight.delete(task)).catch(() => {});
    if (counters.txAAdmissionAccepted >= config.maxEvents) requestStop("max_events_reached");
  };

  try {
    if (stopping) throw new Error("operator_abort");
    pool = dependencies.createPool ? dependencies.createPool() : createDurableCanaryPool(config);
    const database = (await pool.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database;
    if (database !== config.expectedDatabase) throw new Error(`durable canary expected database ${config.expectedDatabase}`);
    controller = (dependencies.createController ?? defaultCreateController)(pool, config);
    controllerSummary = await controller.start();
    if (controllerSummary.state !== "READY") {
      requestStop("runtime_not_ready");
      throw new Error(`durable controller not ready:${controllerSummary.state}`);
    }
    controllerReady = true;
    guardAcquired = true;
    if (stopping) throw new Error("operator_abort");
    preRunEvidence = await collectDurableCanaryEvidence(pool);
    if (preRunEvidence.database !== config.expectedDatabase) throw new Error(`durable canary evidence expected database ${config.expectedDatabase}`);
    if (stopping) throw new Error("operator_abort");
    durationTimer = setTimer(() => requestStop("duration_reached"), config.durationMs);
    stream = (dependencies.createStream ?? defaultCreateStream)(config, (error) => {
      counters.streamErrors += 1;
      sanitizedErrors.push(`stream:${sanitize(error)}`);
      requestStop("stream_error");
    });
    unsubscribe = stream.onEvents(config.collectionSlug, [...DURABLE_CANARY_EVENT_TYPES], admitEvent);
    streamConnected = true;
    while (!stopping) await new Promise((resolve) => setTimeout(resolve, 50));
  } catch (error) {
    if (!stopReason) {
      const text = sanitize(error);
      requestStop(text.includes("runtime_conflict") ? "runtime_conflict" : "startup_failure");
    }
    sanitizedErrors.push(`runtime:${sanitize(error)}`);
  } finally {
    stopping = true;
    try {
      if (dependencies.externalStopSignal) dependencies.externalStopSignal.removeEventListener("abort", abortHandler);
    } catch (error) {
      cleanupErrors.push(`abort_listener:${sanitize(error)}`);
    }
    try {
      if (durationTimer !== undefined) clearTimer(durationTimer);
    } catch (error) {
      cleanupErrors.push(`duration_timer:${sanitize(error)}`);
    }
    try {
      unsubscribe?.();
    } catch (error) {
      cleanupErrors.push(`unsubscribe:${sanitize(error)}`);
    }
    if (stream) {
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            try {
              stream?.disconnect(resolve);
            } catch (error) {
              reject(error);
            }
          }),
          new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("stream disconnect timeout")), STREAM_DISCONNECT_TIMEOUT_MS))
        ]);
      } catch (error) {
        cleanupErrors.push(`disconnect:${sanitize(error)}`);
      }
    }
    try {
      await Promise.allSettled([...txAInFlight]);
    } catch (error) {
      cleanupErrors.push(`txa_settle:${sanitize(error)}`);
    }
    try {
      await workerChain.catch((error) => {
        cleanupErrors.push(`worker_chain:${sanitize(error)}`);
      });
    } catch (error) {
      cleanupErrors.push(`worker_chain:${sanitize(error)}`);
    }
    try {
      const drainStarted = Date.now();
      while (pool && controller && controllerReady && drain.workerRuns < config.maxDrainWorkerRuns) {
        if (Date.now() - drainStarted >= config.drainTimeoutMs) {
          drain.timedOut = true;
          requestStop("drain_incomplete");
          break;
        }
        const result = await runWorkerOnce();
        if (!result) {
          requestStop("drain_incomplete");
          break;
        }
        drain.workerRuns += 1;
        if (result.outcome === "idle") {
          drain.completed = true;
          break;
        }
      }
      if (controllerReady && !drain.completed && !drain.timedOut) requestStop("drain_incomplete");
    } catch (error) {
      cleanupErrors.push(`drain:${sanitize(error)}`);
      requestStop("drain_incomplete");
    }
    try {
      if (pool) {
        const ids = preRunEvidence?.eventIds ?? undefined;
        postRunEvidence = await collectDurableCanaryEvidence(pool, ids);
        drain.pendingDueAfterDrain = postRunEvidence.pendingDue;
        drain.pendingScheduledAfterDrain = postRunEvidence.pendingScheduled;
      }
    } catch (error) {
      cleanupErrors.push(`post_evidence:${sanitize(error)}`);
    }
    try {
      cleanup.controllerStopAttempted = Boolean(controller);
      controllerSummary = controller ? await controller.stop() : controllerSummary;
      cleanup.controllerStopped = controllerSummary?.state === "STOPPED";
    } catch (error) {
      cleanupErrors.push(`controller_stop:${sanitize(error)}`);
    }
    try {
      cleanup.poolEndAttempted = Boolean(pool);
      if (pool) await pool.end();
      cleanup.poolEnded = Boolean(pool);
    } catch (error) {
      cleanupErrors.push(`pool_end:${sanitize(error)}`);
    }
  }

  const stoppedAtMs = Date.now();
  const preExistingRowsPreservation = preRunEvidence && postRunEvidence ? comparePreExistingRows(preRunEvidence, postRunEvidence) : null;
  const summary: DurableCanarySummary = {
    result: "DURABLE_CANARY_FAILED",
    stopReason,
    startedAt,
    stoppedAt: dependencies.now?.() ?? new Date(stoppedAtMs).toISOString(),
    durationMs: Math.max(0, stoppedAtMs - startedAtMs),
    runtimeMode: DURABLE_CANARY_RUNTIME_MODE,
    guardAcquired,
    streamConnected,
    counters,
    drain,
    controller: controllerSummary,
    preRunEvidence,
    postRunEvidence,
    preExistingRowsPreserved: preExistingRowsPreservation?.preserved ?? null,
    preExistingRowsPreservation,
    sanitizedErrors,
    cleanupErrors,
    cleanup
  };
  summary.result = classifySummary(summary);
  return summary;
}
