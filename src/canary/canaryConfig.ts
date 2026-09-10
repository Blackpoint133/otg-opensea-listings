import path from "node:path";
import dotenv from "dotenv";
import { parseLiveWritesEnabled, type LiveWriterConfig } from "../writer/writerConfig.js";

export interface CanaryConfig {
  canaryEnabled: boolean;
  durationMs: number;
  maxEvents: number;
  queueCapacity: number;
  writerConcurrency: 1;
  collectionSlug: string;
  apiKey: string;
  localStorageDir: string;
  liveWriterConfig: LiveWriterConfig;
}

export const CANARY_EXPECTED_DATABASE = "server_otg" as const;

const rootDir = path.resolve(import.meta.dirname, "..", "..");
const envPath = path.resolve(rootDir, "..", ".env");

function parsePositiveInteger(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  const text = value === undefined || value.trim() === "" ? String(fallback) : value.trim();
  if (!/^[0-9]+$/.test(text)) throw new Error(`${name} must be an integer`);
  const candidate = Number(text);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return candidate;
}

export function parseCanaryEnabled(value: string | undefined): boolean {
  return parseLiveWritesEnabled(value);
}

export function parseCanaryArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--duration-minutes") { values.durationMinutes = value; i += 1; }
    else if (key === "--max-events") { values.maxEvents = value; i += 1; }
    else if (key === "--queue-capacity") { values.queueCapacity = value; i += 1; }
    else throw new Error(`Unknown canary argument: ${key}`);
  }
  return values;
}

export function loadCanaryConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, explicitWriterMode = false): CanaryConfig {
  const fileEnv = dotenv.config({ path: envPath }).parsed ?? {};
  const merged = env === process.env ? { ...fileEnv, ...process.env } : { ...fileEnv, ...env };
  const args = parseCanaryArgs(argv);
  const durationMinutes = parsePositiveInteger(args.durationMinutes ?? merged.OPENSEA_V2_CANARY_DURATION_MINUTES, "duration-minutes", 5, 1, 30);
  const maxEvents = parsePositiveInteger(args.maxEvents ?? merged.OPENSEA_V2_CANARY_MAX_EVENTS, "max-events", 25, 1, 1000);
  const queueCapacity = parsePositiveInteger(args.queueCapacity ?? merged.OPENSEA_V2_CANARY_QUEUE_CAPACITY, "queue-capacity", 100, 1, 1000);
  const apiKey = merged.OPENSEA_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("OPENSEA_API_KEY is required");
  return {
    canaryEnabled: parseCanaryEnabled(merged.OPENSEA_V2_CANARY_ENABLED),
    durationMs: durationMinutes * 60 * 1000,
    maxEvents,
    queueCapacity,
    writerConcurrency: 1,
    collectionSlug: merged.OPENSEA_COLLECTION_SLUG?.trim() || "off-the-grid",
    apiKey,
    localStorageDir: path.join(rootDir, "runtime", "canary_local_storage"),
    liveWriterConfig: {
      liveWritesEnabled: parseLiveWritesEnabled(merged.OPENSEA_V2_LIVE_WRITES_ENABLED),
      explicitWriterMode,
      maxConcurrency: 1
    }
  };
}

export function assertCanaryCanStart(config: CanaryConfig): void {
  if (!config.canaryEnabled) throw new Error("OPENSEA_V2_CANARY_ENABLED must be explicitly enabled");
  if (!config.liveWriterConfig.explicitWriterMode) throw new Error("canary explicit writer mode is required");
  if (!config.liveWriterConfig.liveWritesEnabled) throw new Error("OPENSEA_V2_LIVE_WRITES_ENABLED must be explicitly enabled");
  if (config.writerConcurrency !== 1) throw new Error("first canary writerConcurrency must equal 1");
}
