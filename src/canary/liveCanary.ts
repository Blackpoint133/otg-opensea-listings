import { LocalStorage } from "node-localstorage";
import { LogLevel } from "@opensea/stream-js";
import { createDatabasePool } from "../db/pool.js";
import type { DbPool } from "../db/types.js";
import { applySdkConsoleMessage, ConnectionErrorTracker, createInitialProbeState, createStreamClient } from "../streamProbe.js";
import { eventTypesForProfile } from "../eventTypes.js";
import { installConsoleCapture, redactString } from "../logger.js";
import { acquireV2RuntimeGuard, type V2RuntimeGuard } from "../runtime/runtimeGuard.js";
import { LiveEventWriter } from "../writer/liveEventWriter.js";
import { runWriterPreflight, type WriterPreflightResult } from "../writer/preflight.js";
import type { WriterResult } from "../writer/types.js";
import { assertCanaryCanStart, CANARY_EXPECTED_DATABASE, type CanaryConfig } from "./canaryConfig.js";
import { SerializedEventSink, type SinkSnapshot, type SinkStopReason } from "./serializedEventSink.js";

export type CanaryOutcome = "CANARY_FAILED" | "CANARY_INFRASTRUCTURE_PASS_NO_EVENTS" | "CANARY_PIPELINE_OBSERVED";
export const REQUIRE_EMPTY_V2_FOR_FIRST_CANARY = true as const;

export interface CanaryTransportState {
  subscription_registered: boolean;
  socket_activity_detected: boolean;
  channel_join_confirmed: boolean;
  join_error_detected: boolean;
  first_event_received: boolean;
  firstEventReceivedAt: string | null;
  stream_error_count: number;
  last_stream_error: string | null;
}

export interface CanaryVerification {
  database: string;
  v2Counts: {
    opensea_listings_v2: string;
    opensea_listings_nft_state_v2: string;
    opensea_listings_events_v2: string;
  };
  unfinalizedJournalCount: string;
  activeOrderCount: string;
  reconciliationOrderCount: string;
  v1: {
    exists: boolean;
    primaryKey: string[];
    columnCount: string;
    rowCount: string | null;
  };
}

export interface CanaryDelta {
  orderRows: number | null;
  nftRows: number | null;
  journalRows: number | null;
  unfinalizedJournalRows: number | null;
  activeOrders: number | null;
  reconciliationOrders: number | null;
}

export interface CanarySummary {
  startTime: string;
  endTime: string | null;
  durationMs: number;
  stopReason: string | null;
  outcome: CanaryOutcome;
  configuredDurationMinutes: number;
  configuredMaxEvents: number;
  configuredQueueCapacity: number;
  configuredConcurrency: 1;
  readinessTimeoutMs: number;
  preflightDatabase: string | null;
  preflightPassed: boolean;
  shutdownClean: boolean;
  transport: CanaryTransportState;
  sink: SinkSnapshot;
  preRunVerification: CanaryVerification | null;
  postRunVerification: CanaryVerification | null;
  delta: CanaryDelta | null;
  sanitizedErrors: string[];
}

interface CanaryStreamClient {
  onEvents(collection: string, events: readonly unknown[], callback: (event: unknown) => void): () => void;
  disconnect(callback?: () => void): void;
}

type CanaryStartupStopReason = "preflight_failed" | "first_canary_non_empty_v2";

export interface CanaryDependencies {
  createPool?: () => DbPool;
  createWriter?: (pool: DbPool, config: CanaryConfig) => LiveEventWriter;
  runPreflight?: (pool: DbPool, config: CanaryConfig) => Promise<WriterPreflightResult>;
  createStream?: (config: CanaryConfig, onError: (error: unknown) => void) => CanaryStreamClient;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  externalStopSignal?: AbortSignal;
  now?: () => string;
  readinessTimeoutMs?: number;
  acquireRuntimeGuard?: (pool: DbPool) => Promise<V2RuntimeGuard>;
}

function defaultCreateStream(config: CanaryConfig, onError: (error: unknown) => void): CanaryStreamClient {
  const storage = new LocalStorage(config.localStorageDir);
  return createStreamClient(config.apiKey, storage, onError, LogLevel.INFO) as unknown as CanaryStreamClient;
}

function emptyTransportState(): CanaryTransportState {
  return {
    subscription_registered: false,
    socket_activity_detected: false,
    channel_join_confirmed: false,
    join_error_detected: false,
    first_event_received: false,
    firstEventReceivedAt: null,
    stream_error_count: 0,
    last_stream_error: null
  };
}

function sanitize(value: unknown): string {
  return redactString(value instanceof Error ? value.message : String(value))
    .replace(/\b(password|token|secret|api[_-]?key)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>")
    .replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>");
}

function isJoinErrorMessage(message: string, collectionSlug: string): boolean {
  return new RegExp(`Failed to join channel ["']?collection:${collectionSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(message);
}

function countDelta(after: string, before: string): number | null {
  const aa = Number(after);
  const bb = Number(before);
  return Number.isFinite(aa) && Number.isFinite(bb) ? aa - bb : null;
}

function computeDelta(pre: CanaryVerification | null, post: CanaryVerification | null): CanaryDelta | null {
  if (!pre || !post) return null;
  return {
    orderRows: countDelta(post.v2Counts.opensea_listings_v2, pre.v2Counts.opensea_listings_v2),
    nftRows: countDelta(post.v2Counts.opensea_listings_nft_state_v2, pre.v2Counts.opensea_listings_nft_state_v2),
    journalRows: countDelta(post.v2Counts.opensea_listings_events_v2, pre.v2Counts.opensea_listings_events_v2),
    unfinalizedJournalRows: countDelta(post.unfinalizedJournalCount, pre.unfinalizedJournalCount),
    activeOrders: countDelta(post.activeOrderCount, pre.activeOrderCount),
    reconciliationOrders: countDelta(post.reconciliationOrderCount, pre.reconciliationOrderCount)
  };
}

function isEmptyV2Baseline(verification: CanaryVerification): boolean {
  return verification.v2Counts.opensea_listings_v2 === "0"
    && verification.v2Counts.opensea_listings_nft_state_v2 === "0"
    && verification.v2Counts.opensea_listings_events_v2 === "0";
}

function formatNonEmptyV2Baseline(verification: CanaryVerification): string {
  return `first_canary_non_empty_v2:listings=${verification.v2Counts.opensea_listings_v2},nft_state=${verification.v2Counts.opensea_listings_nft_state_v2},events=${verification.v2Counts.opensea_listings_events_v2}`;
}

export async function collectCanaryVerification(pool: DbPool): Promise<CanaryVerification> {
  const database = await pool.query<{ database: string }>("SELECT current_database() AS database");
  const orderCount = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_v2");
  const nftCount = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_nft_state_v2");
  const journalCount = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_events_v2");
  const unfinalized = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_events_v2 WHERE apply_result IS NULL");
  const active = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_v2 WHERE status='active' AND is_active=true");
  const reconciliation = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings_v2 WHERE needs_reconciliation=true");
  const v1Exists = await pool.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS exists", ["public", "opensea_listings"]);
  const v1Pk = await pool.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema=$1 AND tc.table_name=$2 AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    ["public", "opensea_listings"]
  );
  const v1Columns = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", ["public", "opensea_listings"]);
  let v1RowCount: string | null = null;
  if (v1Exists.rows[0]?.exists) {
    const rows = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM public.opensea_listings");
    v1RowCount = rows.rows[0]?.count ?? null;
  }
  return {
    database: database.rows[0]?.database ?? "",
    v2Counts: {
      opensea_listings_v2: orderCount.rows[0]?.count ?? "",
      opensea_listings_nft_state_v2: nftCount.rows[0]?.count ?? "",
      opensea_listings_events_v2: journalCount.rows[0]?.count ?? ""
    },
    unfinalizedJournalCount: unfinalized.rows[0]?.count ?? "",
    activeOrderCount: active.rows[0]?.count ?? "",
    reconciliationOrderCount: reconciliation.rows[0]?.count ?? "",
    v1: {
      exists: Boolean(v1Exists.rows[0]?.exists),
      primaryKey: v1Pk.rows.map((row) => row.column_name),
      columnCount: v1Columns.rows[0]?.count ?? "",
      rowCount: v1RowCount
    }
  };
}

function classifyOutcome(summary: Omit<CanarySummary, "outcome">): CanaryOutcome {
  if (!summary.preflightPassed || !summary.shutdownClean || summary.sanitizedErrors.length > 0) return "CANARY_FAILED";
  if (!summary.transport.channel_join_confirmed || summary.transport.join_error_detected) return "CANARY_FAILED";
  if (!summary.postRunVerification || summary.postRunVerification.unfinalizedJournalCount !== "0") return "CANARY_FAILED";
  if (summary.sink.state === "failed" || summary.stopReason === "queue_overflow" || summary.stopReason === "writer_error" || summary.stopReason === "stream_error" || summary.stopReason === "stream_join_error" || summary.stopReason === "stream_readiness_timeout") return "CANARY_FAILED";
  if (summary.sink.eventsAccepted > 0 && summary.sink.eventsProcessed > 0) return "CANARY_PIPELINE_OBSERVED";
  return "CANARY_INFRASTRUCTURE_PASS_NO_EVENTS";
}

export async function runLiveCanary(config: CanaryConfig, dependencies: CanaryDependencies = {}): Promise<CanarySummary> {
  assertCanaryCanStart(config);
  const startedAt = Date.now();
  const startTime = dependencies.now?.() ?? new Date(startedAt).toISOString();
  const readinessTimeoutMs = dependencies.readinessTimeoutMs ?? 30_000;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const transport = emptyTransportState();
  const probeState = createInitialProbeState();
  const tracker = new ConnectionErrorTracker(1, readinessTimeoutMs);
  const sanitizedErrors: string[] = [];
  let preflightDatabase: string | null = null;
  let preflightPassed = false;
  let stopReason: string | null = null;
  let shutdownClean = false;
  let shutdownPromise: Promise<void> | null = null;
  let durationTimer: unknown;
  let readinessTimer: unknown;
  let pool: DbPool | null = null;
  let writer: LiveEventWriter | null = null;
  let sink: SerializedEventSink | null = null;
  let stream: CanaryStreamClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let consoleCapture: ReturnType<typeof installConsoleCapture> | null = null;
  let runtimeGuard: V2RuntimeGuard | null = null;
  let preRunVerification: CanaryVerification | null = null;
  let postRunVerification: CanaryVerification | null = null;
  let externalAbortHandler: (() => void) | null = null;

  const requestShutdown = (reason: SinkStopReason | CanaryStartupStopReason, fatal: boolean): Promise<void> => {
    stopReason = stopReason ?? reason;
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (durationTimer !== undefined) clearTimer(durationTimer);
      if (readinessTimer !== undefined) clearTimer(readinessTimer);
      try { unsubscribe?.(); } catch (error) { sanitizedErrors.push(`unsubscribe:${sanitize(error)}`); }
      if (stream) {
        await Promise.race([
          new Promise<void>((resolve) => stream?.disconnect(resolve)),
          new Promise<void>((resolve) => setTimeout(resolve, 5000))
        ]);
      }
      if (sink) {
        const sinkReason: SinkStopReason = reason === "preflight_failed" || reason === "first_canary_non_empty_v2" ? "stream_error" : reason;
        if (sink.state === "accepting") sink.requestStop(sinkReason, fatal);
        await sink.drain();
      }
      if (runtimeGuard) {
        await runtimeGuard.release();
        runtimeGuard = null;
      }
      if (writer) await writer.shutdown();
      else if (pool) await pool.end();
      consoleCapture?.restore();
      shutdownClean = true;
    })();
    return shutdownPromise;
  };

  const recordStreamError = (reason: SinkStopReason, error: unknown): void => {
    transport.stream_error_count += 1;
    transport.last_stream_error = sanitize(error);
    sanitizedErrors.push(`${reason}:${transport.last_stream_error}`);
    sink?.requestStop(reason, true);
  };

  try {
    if (config.liveWriterConfig.explicitWriterMode !== true || config.liveWriterConfig.liveWritesEnabled !== true || !config.canaryEnabled) throw new Error("canary gates not enabled");
    pool = (dependencies.createPool ?? createDatabasePool)();
    const preflight = await (dependencies.runPreflight ?? ((candidatePool, candidateConfig) => runWriterPreflight(candidatePool, candidateConfig.liveWriterConfig, { expectedDatabase: CANARY_EXPECTED_DATABASE })))(pool, config);
    preflightDatabase = preflight.database;
    if (preflight.database !== CANARY_EXPECTED_DATABASE) throw new Error(`canary expected database ${CANARY_EXPECTED_DATABASE}`);
    preflightPassed = true;
    preRunVerification = await collectCanaryVerification(pool);
    if (preRunVerification.database !== CANARY_EXPECTED_DATABASE) throw new Error(`canary baseline expected database ${CANARY_EXPECTED_DATABASE}`);

    if (REQUIRE_EMPTY_V2_FOR_FIRST_CANARY && !isEmptyV2Baseline(preRunVerification)) {
      sanitizedErrors.push(formatNonEmptyV2Baseline(preRunVerification));
      await requestShutdown("first_canary_non_empty_v2", true);
    } else {
      runtimeGuard = await (dependencies.acquireRuntimeGuard ?? ((candidatePool) => acquireV2RuntimeGuard(candidatePool, "legacy_atomic")))(pool);
      writer = dependencies.createWriter?.(pool, config) ?? new LiveEventWriter({ pool, config: config.liveWriterConfig });
      sink = new SerializedEventSink({
        queueCapacity: config.queueCapacity,
        maxEvents: config.maxEvents,
        handleEvent: (event: unknown): Promise<WriterResult> => writer!.handleEvent(event),
        onStopRequested: (reason, fatal) => { void requestShutdown(reason, fatal); }
      });

      externalAbortHandler = () => {
        const reason = dependencies.externalStopSignal?.reason === "SIGTERM" ? "signal_terminate" : "signal_interrupt";
        sink?.requestStop(reason, false);
      };
      if (dependencies.externalStopSignal) {
        if (dependencies.externalStopSignal.aborted) externalAbortHandler();
        else dependencies.externalStopSignal.addEventListener("abort", externalAbortHandler, { once: true });
      }

      consoleCapture = installConsoleCapture((level, args) => {
        const message = args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ");
        applySdkConsoleMessage(probeState, message, config.collectionSlug, tracker);
        transport.socket_activity_detected = probeState.socket_activity_detected;
        transport.channel_join_confirmed = probeState.channel_join_confirmed;
        if (isJoinErrorMessage(message, config.collectionSlug)) {
          transport.join_error_detected = true;
          recordStreamError("stream_join_error", message);
        } else if (level === "error") {
          transport.stream_error_count += 1;
          transport.last_stream_error = sanitize(message);
        }
      });

      durationTimer = setTimer(() => { sink?.requestStop("duration_reached", false); }, config.durationMs);
      readinessTimer = setTimer(() => {
        if (!transport.channel_join_confirmed) sink?.requestStop("stream_readiness_timeout", true);
      }, readinessTimeoutMs);

      stream = (dependencies.createStream ?? defaultCreateStream)(config, (error) => {
        recordStreamError("stream_error", error);
      });
      unsubscribe = stream.onEvents(config.collectionSlug, [...eventTypesForProfile("all")], (event: unknown) => {
        try {
          if (!transport.first_event_received) {
            transport.first_event_received = true;
            transport.firstEventReceivedAt = dependencies.now?.() ?? new Date().toISOString();
          }
          const result = sink!.enqueue(event);
          if (!result.accepted && result.reason === "queue_overflow") void requestShutdown("queue_overflow", true);
        } catch (error) {
          recordStreamError("stream_error", error);
        }
      });
      transport.subscription_registered = true;

      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (shutdownPromise) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
      await shutdownPromise;
    }
  } catch (error) {
    sanitizedErrors.push(`runtime:${sanitize(error)}`);
    await requestShutdown("preflight_failed", true);
  } finally {
    if (dependencies.externalStopSignal && externalAbortHandler) dependencies.externalStopSignal.removeEventListener("abort", externalAbortHandler);
    let verificationPool: DbPool | null = null;
    try {
      verificationPool = (dependencies.createPool ?? createDatabasePool)();
      postRunVerification = await collectCanaryVerification(verificationPool);
      if (postRunVerification.database !== CANARY_EXPECTED_DATABASE) sanitizedErrors.push(`verification:expected database ${CANARY_EXPECTED_DATABASE}`);
    } catch (error) {
      sanitizedErrors.push(`verification:${sanitize(error)}`);
    } finally {
      if (verificationPool) await verificationPool.end();
    }
  }

  const end = Date.now();
  const sinkSnapshot = sink?.snapshot() ?? new SerializedEventSink({ queueCapacity: 1, maxEvents: 1, handleEvent: async () => { throw new Error("unused"); } }).snapshot();
  if (sinkSnapshot.lastErrorMessage) sanitizedErrors.push(`writer_error:${sanitize(sinkSnapshot.lastErrorMessage)}`);
  const withoutOutcome: Omit<CanarySummary, "outcome"> = {
    startTime,
    endTime: dependencies.now?.() ?? new Date(end).toISOString(),
    durationMs: Math.max(0, end - startedAt),
    stopReason,
    configuredDurationMinutes: config.durationMs / 60_000,
    configuredMaxEvents: config.maxEvents,
    configuredQueueCapacity: config.queueCapacity,
    configuredConcurrency: config.writerConcurrency,
    readinessTimeoutMs,
    preflightDatabase,
    preflightPassed,
    shutdownClean,
    transport,
    sink: sinkSnapshot,
    preRunVerification,
    postRunVerification,
    delta: computeDelta(preRunVerification, postRunVerification),
    sanitizedErrors
  };
  return { ...withoutOutcome, outcome: classifyOutcome(withoutOutcome) };
}
