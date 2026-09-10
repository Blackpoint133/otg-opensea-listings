import fs from "node:fs";
import path from "node:path";
import { LocalStorage } from "node-localstorage";
import { OpenSeaStreamClient, LogLevel } from "@opensea/stream-js";
import WebSocket from "ws";
import { eventTypesForProfile, summarizeEvent, type CaptureProfile } from "./eventTypes.js";
import type { ProbeConfig } from "./config.js";
import { installConsoleCapture, ProbeLogger, serializeDiagnostic } from "./logger.js";

export interface ProbeState {
  subscription_registered: boolean;
  socket_activity_detected: boolean;
  channel_join_confirmed: boolean;
  first_event_received: boolean;
  last_event_received_at: string | null;
  connection_error_count: number;
  consecutive_connection_error_count: number;
  last_connection_error_at: string | null;
}

export interface ConnectionErrorResult {
  fatal: boolean;
  consecutive: number;
  inWindow: number;
}

export class ConnectionErrorTracker {
  private readonly timestamps: number[] = [];
  private consecutive = 0;
  constructor(private readonly maxConsecutive: number, private readonly windowMs: number) {}
  record(now = Date.now()): ConnectionErrorResult {
    while (this.timestamps[0] !== undefined && now - this.timestamps[0] > this.windowMs) this.timestamps.shift();
    this.timestamps.push(now);
    this.consecutive += 1;
    return { fatal: this.consecutive >= this.maxConsecutive && this.timestamps.length >= this.maxConsecutive, consecutive: this.consecutive, inWindow: this.timestamps.length };
  }
  markHealthy(): void { this.timestamps.length = 0; this.consecutive = 0; }
  get consecutiveCount(): number { return this.consecutive; }
}

export interface CaptureSnapshot {
  total_observed_events: number;
  total_stored_events: number;
  observed_by_type: Record<string, number>;
  stored_by_type: Record<string, number>;
  skipped_due_to_type_cap: Record<string, number>;
}

export interface CaptureDecision {
  store: boolean;
  skipped_due_to_type_cap: boolean;
  global_limit_reached: boolean;
  observed_count_for_type: number;
}

export class CaptureCounters {
  private readonly observed = new Map<string, number>();
  private readonly stored = new Map<string, number>();
  private readonly skipped = new Map<string, number>();
  totalObserved = 0;
  totalStored = 0;
  constructor(private readonly maxEvents: number, private readonly perTypeMaxEvents: number) {}
  observe(eventType: string): CaptureDecision {
    this.totalObserved += 1;
    const observedCount = (this.observed.get(eventType) ?? 0) + 1;
    this.observed.set(eventType, observedCount);
    if (this.perTypeMaxEvents > 0 && (this.stored.get(eventType) ?? 0) >= this.perTypeMaxEvents) {
      this.skipped.set(eventType, (this.skipped.get(eventType) ?? 0) + 1);
      return { store: false, skipped_due_to_type_cap: true, global_limit_reached: false, observed_count_for_type: observedCount };
    }
    if (this.maxEvents > 0 && this.totalStored >= this.maxEvents) return { store: false, skipped_due_to_type_cap: false, global_limit_reached: true, observed_count_for_type: observedCount };
    this.totalStored += 1;
    this.stored.set(eventType, (this.stored.get(eventType) ?? 0) + 1);
    return { store: true, skipped_due_to_type_cap: false, global_limit_reached: false, observed_count_for_type: observedCount };
  }
  snapshot(): CaptureSnapshot {
    return { total_observed_events: this.totalObserved, total_stored_events: this.totalStored, observed_by_type: Object.fromEntries(this.observed), stored_by_type: Object.fromEntries(this.stored), skipped_due_to_type_cap: Object.fromEntries(this.skipped) };
  }
}

export function shouldLogEvent(observedCountForType: number, sampleEvery: number): boolean {
  return observedCountForType === 1 || sampleEvery <= 1 || observedCountForType % sampleEvery === 0;
}

export function createEventWrapper(event: unknown, receivedAtUtc: string, storedSequenceNumber: number, observedSequenceNumber: number, collectionSlug: string, profile: CaptureProfile): Record<string, unknown> {
  const eventType = (event as { event_type?: unknown } | null)?.event_type ?? "unknown";
  return { received_at_utc: receivedAtUtc, sequence_number: storedSequenceNumber, observed_sequence_number: observedSequenceNumber, event_type: eventType, sdk_version: "0.4.0", collection_slug: collectionSlug, capture_profile: profile, full_event: event };
}

export function createInitialProbeState(): ProbeState {
  return { subscription_registered: false, socket_activity_detected: false, channel_join_confirmed: false, first_event_received: false, last_event_received_at: null, connection_error_count: 0, consecutive_connection_error_count: 0, last_connection_error_at: null };
}

export function applySdkConsoleMessage(state: ProbeState, message: string, collectionSlug: string, tracker: ConnectionErrorTracker): void {
  if (isSocketActivityMessage(message)) {
    state.socket_activity_detected = true;
    tracker.markHealthy();
    state.consecutive_connection_error_count = 0;
  }
  if (isJoinMessage(message, collectionSlug)) {
    state.channel_join_confirmed = true;
    tracker.markHealthy();
    state.consecutive_connection_error_count = 0;
  }
}

export function createStreamClient(apiKey: string, storage: LocalStorage, onError: (error: unknown) => void, logLevel: LogLevel): OpenSeaStreamClient {
  return new OpenSeaStreamClient({ token: apiKey, connectOptions: { transport: WebSocket as any, sessionStorage: storage } as any, onError, logLevel });
}

function diagnosticText(error: unknown): string {
  return JSON.stringify(serializeDiagnostic(error));
}

function isExplicitlyFatal(error: unknown): boolean {
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.+(api|token)|authentication.+(failed|rejected)/i.test(diagnosticText(error));
}

function isJoinMessage(message: string, collectionSlug: string): boolean {
  return new RegExp(`Successfully joined channel ["']?collection:${collectionSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(message);
}

function isSocketActivityMessage(message: string): boolean {
  return /connected to socket|connected to wss?:|Successfully joined channel|re-established/i.test(message);
}

function stringifyConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(serializeDiagnostic(value)); } catch { return "<UNSERIALIZABLE>"; }
}

export async function runProbe(config: ProbeConfig): Promise<void> {
  fs.mkdirSync(path.dirname(config.eventsPath), { recursive: true });
  fs.mkdirSync(config.localStorageDir, { recursive: true });
  const logger = new ProbeLogger(config.logPath, config.logLevel);
  const state = createInitialProbeState();
  const tracker = new ConnectionErrorTracker(config.maxConsecutiveConnectionErrors, config.connectionErrorWindowSeconds * 1000);
  const selectedEventTypes = eventTypesForProfile(config.profile);
  const counters = new CaptureCounters(config.maxEvents, config.perTypeMaxEvents);
  const capLogged = new Set<string>();
  const malformedNftWarnings = new Set<string>();
  let lastEventAt: string | undefined;
  let firstEventTimestamp: string | null = null;
  let lastEventTimestamp: string | null = null;
  let shutdownReason = "unknown";
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeCalled = false;
  let client: OpenSeaStreamClient | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  let durationTimer: NodeJS.Timeout | undefined;
  let outputReady = false;
  const started = Date.now();
  let consoleCapture: ReturnType<typeof installConsoleCapture> | undefined;

  const stop = (reason: string, fatal = false): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownReason = reason;
    if (statusTimer) clearInterval(statusTimer);
    if (durationTimer) clearTimeout(durationTimer);
    shutdownPromise = (async () => {
      logger.info(`graceful shutdown: ${reason}`);
      if (!unsubscribeCalled && unsubscribe) {
        unsubscribeCalled = true;
        try { unsubscribe(); } catch (error) { logger.warn(`unsubscribe failed ${diagnosticText(error)}`); }
      }
      if (client) {
        try {
          await Promise.race([
            new Promise<void>((resolve) => client?.disconnect(resolve)),
            new Promise<void>((resolve) => setTimeout(resolve, 5000))
          ]);
        } catch (error) { logger.warn(`client disconnect failed ${diagnosticText(error)}`); }
      }
      logger.info(`final state ${JSON.stringify({ shutdown_reason: shutdownReason, capture_profile: config.profile, selected_event_types: selectedEventTypes, ...state, ...counters.snapshot(), first_event_timestamp: firstEventTimestamp, last_event_timestamp: lastEventTimestamp, last_event_time: lastEventAt ?? "no events received", output_paths: { log: config.logPath, jsonl: config.eventsPath } })}`);
      consoleCapture?.restore();
      await logger.close();
      if (fatal) process.exitCode = 1;
    })();
    return shutdownPromise;
  };

  logger.setErrorHandler((error) => { void stop(`output failure ${diagnosticText(error)}`, true); });
  try {
    const output = fs.createWriteStream(config.eventsPath, { flags: "a", encoding: "utf8" });
    output.on("error", (error) => { void stop(`JSONL output failure ${diagnosticText(error)}`, true); });
    outputReady = true;
    await new Promise<void>((resolve) => output.end(resolve));
  } catch (error) {
    await stop(`output initialization failure ${diagnosticText(error)}`, true);
    return;
  }

  const onSdkConsole = (level: "debug" | "info" | "warn" | "error", args: unknown[]) => {
    const message = args.map(stringifyConsoleArg).join(" ");
    logger.sdk(level, args);
    applySdkConsoleMessage(state, message, config.collectionSlug, tracker);
  };
  consoleCapture = installConsoleCapture(onSdkConsole);

  try {
    const logLevel = config.logLevel === "debug" ? LogLevel.DEBUG : config.logLevel === "warn" ? LogLevel.WARN : config.logLevel === "error" ? LogLevel.ERROR : LogLevel.INFO;
    logger.info(`process startup ${JSON.stringify({ node: process.version, sdk_version: "0.4.0", collection_slug: config.collectionSlug, capture_profile: config.profile, event_types: selectedEventTypes, jsonl_path: config.eventsPath, log_path: config.logPath, max_events: config.maxEvents, per_type_max_events: config.perTypeMaxEvents, event_log_sample_every: config.eventLogSampleEvery, max_consecutive_connection_errors: config.maxConsecutiveConnectionErrors, connection_error_window_seconds: config.connectionErrorWindowSeconds })}`);
    const storage = new LocalStorage(config.localStorageDir);
    client = createStreamClient(config.apiKey, storage, (error: unknown) => {
        state.connection_error_count += 1;
        state.last_connection_error_at = new Date().toISOString();
        logger.error(`SDK error ${diagnosticText(error)}`);
        if (isExplicitlyFatal(error)) {
          void stop("explicit fatal SDK error", true);
          return;
        }
        const result = tracker.record();
        state.consecutive_connection_error_count = result.consecutive;
        if (result.fatal) void stop("connection error threshold exceeded", true);
      }, logLevel);
    logger.info(`subscription registration ${JSON.stringify({ collection: config.collectionSlug, capture_profile: config.profile, event_types: selectedEventTypes })}`);
    const registeredUnsubscribe = client.onEvents(config.collectionSlug, [...selectedEventTypes], (event: any) => {
      if (stopping) return;
      try {
        const eventType = event?.event_type ?? event?.eventType ?? "unknown";
        const decision = counters.observe(eventType);
        lastEventAt = new Date().toISOString();
        const summary = summarizeEvent(event);
        const eventTimestamp = typeof summary.event_timestamp === "string" ? summary.event_timestamp : null;
        if (firstEventTimestamp === null) firstEventTimestamp = eventTimestamp;
        lastEventTimestamp = eventTimestamp;
        state.first_event_received = true;
        state.last_event_received_at = lastEventAt;
        state.socket_activity_detected = true;
        tracker.markHealthy();
        state.consecutive_connection_error_count = 0;
        if (shouldLogEvent(decision.observed_count_for_type, config.eventLogSampleEvery)) logger.info(`event received ${JSON.stringify(summary)}`);
        if (summary.nft_id && summary.nft_id_parse_valid === false && !malformedNftWarnings.has(String(summary.nft_id)) && malformedNftWarnings.size < 20) {
          malformedNftWarnings.add(String(summary.nft_id));
          logger.warn(`malformed nft_id ignored for normalization: ${String(summary.nft_id).slice(0, 200)}`);
        }
        if (decision.skipped_due_to_type_cap) {
          if (!capLogged.has(eventType)) { capLogged.add(eventType); logger.warn(`per-type storage cap reached ${JSON.stringify({ event_type: eventType, cap: config.perTypeMaxEvents })}`); }
          return;
        }
        if (decision.global_limit_reached) { void stop("max stored events reached"); return; }
        const wrapper = createEventWrapper(event, lastEventAt, counters.totalStored, counters.totalObserved, config.collectionSlug, config.profile);
        if (!outputReady) throw new Error("JSONL output is not ready");
        fs.appendFileSync(config.eventsPath, `${JSON.stringify(wrapper)}\n`, "utf8");
        if (config.maxEvents > 0 && counters.totalStored >= config.maxEvents) void stop("max stored events reached");
      } catch (error) { void stop(`event/output failure ${diagnosticText(error)}`, true); }
    });
    unsubscribe = registeredUnsubscribe;
    state.subscription_registered = true;
    if (stopping) registeredUnsubscribe();
    statusTimer = setInterval(() => logger.info(`status ${JSON.stringify({ process_alive: true, elapsed_seconds: Math.floor((Date.now() - started) / 1000), capture_profile: config.profile, selected_event_types: selectedEventTypes, ...counters.snapshot(), last_event_time: lastEventAt ?? "no events received yet", first_event_timestamp: firstEventTimestamp, last_event_timestamp: lastEventTimestamp, ...state })}`), 60000);
    durationTimer = setTimeout(() => void stop(state.first_event_received ? "duration reached" : "probe timeout with zero events"), config.durationMinutes * 60 * 1000);
    await new Promise<void>((resolve) => {
      if (stopping) { resolve(); return; }
      const check = setInterval(() => { if (stopping) { clearInterval(check); resolve(); } }, 100);
    });
    await shutdownPromise;
  } catch (error) {
    await stop(`fatal initialization failure ${diagnosticText(error)}`, true);
  }
}
