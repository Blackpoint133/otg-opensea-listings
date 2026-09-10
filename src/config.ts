import path from "node:path";
import dotenv from "dotenv";
import { eventTypesForProfile, isCaptureProfile, type CaptureProfile } from "./eventTypes.js";

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface ProbeConfig {
  apiKey: string;
  profile: CaptureProfile;
  selectedEventTypes: readonly string[];
  collectionSlug: string;
  durationMinutes: number;
  maxEvents: number;
  perTypeMaxEvents: number;
  eventLogSampleEvery: number;
  logLevel: LogLevelName;
  runtimeDir: string;
  logPath: string;
  eventsPath: string;
  localStorageDir: string;
  maxConsecutiveConnectionErrors: number;
  connectionErrorWindowSeconds: number;
}

const rootDir = path.resolve(import.meta.dirname, "..");
const envPath = path.resolve(rootDir, "..", ".env");

export function parsePositiveNumber(value: string | undefined, name: string, fallback: number): number {
  const candidate = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate <= 0) throw new Error(`${name} must be a positive number`);
  return candidate;
}

export function parseNonNegativeNumber(value: string | undefined, name: string, fallback: number): number {
  const candidate = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate < 0) throw new Error(`${name} must be a non-negative number`);
  return candidate;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ProbeConfig {
  const fileEnv = dotenv.config({ path: envPath }).parsed ?? {};
  const merged = env === process.env ? { ...fileEnv, ...process.env } : { ...fileEnv, ...env };
  const apiKey = merged.OPENSEA_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENSEA_API_KEY is required");

  let durationMinutes = merged.LISTINGS_V2_PROBE_DURATION_MINUTES;
  let maxEvents = merged.LISTINGS_V2_PROBE_MAX_EVENTS;
  let profile = (merged.LISTINGS_V2_CAPTURE_PROFILE ?? "all").toLowerCase();
  let perTypeMaxEvents = merged.LISTINGS_V2_PER_TYPE_MAX_EVENTS;
  let eventLogSampleEvery = merged.LISTINGS_V2_EVENT_LOG_SAMPLE_EVERY;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--duration-minutes") durationMinutes = argv[++i];
    else if (argv[i] === "--max-events") maxEvents = argv[++i];
    else if (argv[i] === "--profile") profile = argv[++i]?.toLowerCase();
    else if (argv[i] === "--per-type-max-events") perTypeMaxEvents = argv[++i];
    else if (argv[i] === "--event-log-sample-every") eventLogSampleEvery = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!isCaptureProfile(profile)) throw new Error("profile must be all, orders, or transfers");
  const logLevel = (merged.LISTINGS_V2_PROBE_LOG_LEVEL ?? "info").toLowerCase() as LogLevelName;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LISTINGS_V2_PROBE_LOG_LEVEL must be debug, info, warn, or error");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runtimeDir = path.join(rootDir, "runtime");
  return {
    apiKey,
    profile,
    selectedEventTypes: [...eventTypesForProfile(profile)],
    collectionSlug: merged.OPENSEA_COLLECTION_SLUG?.trim() || "off-the-grid",
    durationMinutes: parsePositiveNumber(durationMinutes, "duration-minutes", 10),
    maxEvents: parseNonNegativeNumber(maxEvents, "max-events", 500),
    perTypeMaxEvents: parseNonNegativeNumber(perTypeMaxEvents, "per-type-max-events", 0),
    eventLogSampleEvery: parsePositiveNumber(eventLogSampleEvery, "event-log-sample-every", 1),
    logLevel,
    maxConsecutiveConnectionErrors: parsePositiveNumber(merged.LISTINGS_V2_MAX_CONSECUTIVE_CONNECTION_ERRORS, "max-consecutive-connection-errors", 10),
    connectionErrorWindowSeconds: parsePositiveNumber(merged.LISTINGS_V2_CONNECTION_ERROR_WINDOW_SECONDS, "connection-error-window-seconds", 120),
    runtimeDir,
    logPath: path.join(runtimeDir, "logs", `stream_probe_${profile}_${stamp}.log`),
    eventsPath: path.join(runtimeDir, "probe_events", `opensea_stream_probe_${profile}_${stamp}.jsonl`),
    localStorageDir: path.join(runtimeDir, "local_storage")
  };
}
