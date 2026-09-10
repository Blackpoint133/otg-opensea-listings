import { createHash } from "node:crypto";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACTIVE_LISTINGS_CHAIN,
  ACTIVE_LISTINGS_COLLECTION,
  ACTIVE_LISTINGS_CONTRACT,
  ACTIVE_LISTINGS_ENDPOINT,
  ActiveListingsClient,
  type ActiveListingsClientDependencies,
  type ActiveListingsSnapshotEvidence,
  sha256File,
  writeActiveListingsEvidenceExclusive,
} from "../src/activeListings.js";

export const OPERATOR_VERSION = "1.0.0";
export const REQUIRED_CONFIRMATIONS = ["--confirm-read-only", "--confirm-no-database", "--confirm-one-shot"] as const;
const REQUIRED_VALUES = ["--output-file", "--limit", "--max-pages", "--max-listings", "--timeout-ms", "--max-retries", "--inter-page-delay-ms"] as const;
const EXIT_BY_SNAPSHOT: Record<ActiveListingsSnapshotEvidence["result"], number> = { COMPLETE: 0, PARTIAL: 2, FAILED: 3, UNSAFE: 4 };
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type OperatorStatus = "PROBE_COMPLETE" | "PROBE_PARTIAL" | "PROBE_FAILED" | "PROBE_UNSAFE" | "PREFLIGHT_FAILED" | "EVIDENCE_FAILED";
export interface ProbeArguments { outputFile: string; limit: number; maxPages: number; maxListings: number; timeoutMs: number; maxRetries: number; interPageDelayMs: number; }
export interface ProbeDependencies {
  clientFactory?: (apiKey: string, args: ProbeArguments, dependencies?: ActiveListingsClientDependencies) => Pick<ActiveListingsClient, "fetchSnapshot"> & { close?: () => Promise<void> };
  transportDependencies?: ActiveListingsClientDependencies;
  sourceFiles?: string[];
  hashFile?: (filePath: string) => Promise<string>;
  writeEvidence?: typeof writeActiveListingsEvidenceExclusive;
  now?: () => string;
  log?: (line: string) => void;
}
export interface ProbeRun { status: OperatorStatus; exitCode: number; evidencePath: string | null; summary: Record<string, unknown>; }

function fail(message: string): never { throw new Error(message); }
function safeText(value: unknown, secret?: string): string {
  let result = value instanceof Error ? value.message : String(value);
  if (secret) result = result.split(secret).join("<redacted>");
  return result.replace(/(x-api-key|api[_-]?key|authorization)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 300);
}
function sanitize(value: unknown, secret: string): unknown {
  if (typeof value === "string") return safeText(value, secret);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, secret)]));
  return value;
}
function parseFiniteInteger(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) fail(`invalid_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`invalid_${name}`);
  return value;
}
function parseArgs(argv: readonly string[]): ProbeArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (REQUIRED_CONFIRMATIONS.includes(arg as typeof REQUIRED_CONFIRMATIONS[number])) { if (flags.has(arg)) fail("duplicate_argument"); flags.add(arg); continue; }
    if (!REQUIRED_VALUES.includes(arg as typeof REQUIRED_VALUES[number])) { if (arg.startsWith("--")) fail("unknown_argument"); fail("unexpected_argument"); }
    if (values.has(arg)) fail("duplicate_argument");
    const raw = argv[++index];
    if (!raw || raw.startsWith("--")) fail(`missing_value_${arg.slice(2)}`);
    values.set(arg, raw);
  }
  for (const flag of REQUIRED_CONFIRMATIONS) if (!flags.has(flag)) fail(`missing_${flag.slice(2)}`);
  for (const required of REQUIRED_VALUES) if (!values.has(required)) fail(`missing_${required.slice(2)}`);
  const rawOutputFile = values.get("--output-file")!;
  if (!rawOutputFile.trim() || !path.isAbsolute(rawOutputFile)) fail("output_file_must_be_absolute");
  const outputFile = path.normalize(rawOutputFile);
  const limit = parseFiniteInteger("limit", values.get("--limit")!);
  const maxPages = parseFiniteInteger("max_pages", values.get("--max-pages")!);
  const maxListings = parseFiniteInteger("max_listings", values.get("--max-listings")!);
  const timeoutMs = parseFiniteInteger("timeout_ms", values.get("--timeout-ms")!);
  const maxRetries = parseFiniteInteger("max_retries", values.get("--max-retries")!);
  const interPageDelayMs = parseFiniteInteger("inter_page_delay_ms", values.get("--inter-page-delay-ms")!);
  if (limit < 1 || limit > 200 || maxPages < 1 || maxPages > 1_000 || maxListings < 1 || maxListings > 100_000 || timeoutMs < 1_000 || timeoutMs > 300_000 || maxRetries > 10 || interPageDelayMs > 60_000) fail("argument_out_of_bounds");
  return { outputFile, limit, maxPages, maxListings, timeoutMs, maxRetries, interPageDelayMs };
}
async function assertPreflight(args: ProbeArguments, apiKey: string | undefined, sourcePaths: string[], hashFile: (filePath: string) => Promise<string>): Promise<Array<{ path: string; sha256: string }>> {
  if (!apiKey?.trim()) fail("OPENSEA_API_KEY_missing");
  if (args.outputFile.includes(apiKey)) fail("unsafe_output_path");
  try { const parent = await stat(path.dirname(args.outputFile)); if (!parent.isDirectory()) fail("output_parent_not_directory"); } catch (error) { if (error instanceof Error && error.message.startsWith("output_")) throw error; fail("output_parent_unavailable"); }
  try { await access(args.outputFile, constants.F_OK); fail("output_file_exists"); } catch (error) { if (error instanceof Error && error.message === "output_file_exists") throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("output_preflight_failed"); }
  const files = [...new Set(sourcePaths)].sort((left, right) => left.localeCompare(right));
  if (files.length !== sourcePaths.length) fail("duplicate_provenance_file");
  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const filePath of files) { try { manifest.push({ path: filePath, sha256: (await hashFile(filePath)).toLowerCase() }); } catch { fail("source_file_missing_or_unreadable"); } }
  return manifest;
}
function statusFor(result: ActiveListingsSnapshotEvidence["result"]): OperatorStatus { return `PROBE_${result}` as OperatorStatus; }
function summary(status: OperatorStatus, snapshot: ActiveListingsSnapshotEvidence | null, evidencePath: string | null): Record<string, unknown> {
  return { statement: "THIS PROBE IS RESPONSE-SHAPE / TRANSPORT EVIDENCE ONLY.", authorization: "NOT AUTHORIZATION FOR DEACTIVATION, AUTHORITATIVE DIFF, RECONCILIATION, OR PRODUCTION SWEEP.", status, result: snapshot?.result ?? null, pageAttempts: snapshot?.pageAttempts ?? 0, pagesFetched: snapshot?.pagesFetched ?? 0, httpAttempts: snapshot?.httpAttempts ?? 0, retryAttempts: snapshot?.retryAttempts ?? 0, observedCount: snapshot?.counters.observed ?? 0, normalizedCount: snapshot?.counters.normalized ?? 0, malformedCount: snapshot?.counters.malformed ?? 0, unsupportedCount: snapshot?.counters.unsupported ?? 0, duplicateCount: snapshot?.counters.duplicates ?? 0, conflictCount: snapshot?.counters.conflicts ?? 0, evidencePath };
}

export async function runProbe(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, dependencies: ProbeDependencies = {}): Promise<ProbeRun> {
  const log = dependencies.log ?? ((line) => console.log(line));
  let args: ProbeArguments;
  try { args = parseArgs(argv); } catch (error) { const message = safeText(error); return { status: "PREFLIGHT_FAILED", exitCode: 1, evidencePath: null, summary: summary("PREFLIGHT_FAILED", null, null) }; }
  const sourcePaths = dependencies.sourceFiles ?? [path.join(PACKAGE_ROOT, "src/activeListings.ts"), path.join(PACKAGE_ROOT, "scripts/runActiveListingsProbe.ts"), path.join(PACKAGE_ROOT, "package.json")];
  let manifest: Array<{ path: string; sha256: string }>;
  try { manifest = await assertPreflight(args, env.OPENSEA_API_KEY, sourcePaths, dependencies.hashFile ?? sha256File); } catch (error) { const sanitized = safeText(error, env.OPENSEA_API_KEY); log(JSON.stringify({ status: "PREFLIGHT_FAILED", error: sanitized })); return { status: "PREFLIGHT_FAILED", exitCode: 1, evidencePath: null, summary: summary("PREFLIGHT_FAILED", null, null) }; }
  const apiKey = env.OPENSEA_API_KEY!;
  const startedAt = dependencies.now?.() ?? new Date().toISOString();
  const provenance = Object.fromEntries(manifest.map((file) => [file.path, file.sha256]));
  let snapshot: ActiveListingsSnapshotEvidence | null = null;
  let client: (Pick<ActiveListingsClient, "fetchSnapshot"> & { close?: () => Promise<void> }) | null = null;
  let operationError: unknown = null;
  let cleanupError: unknown = null;
  let evidenceCommitted = false;
  try {
    const factory = dependencies.clientFactory ?? ((key, configuration, transportDependencies) => new ActiveListingsClient({ apiKey: key, policy: { pageLimit: configuration.limit, maxPages: configuration.maxPages, maxListings: configuration.maxListings, requestTimeoutMs: configuration.timeoutMs, interPageDelayMs: configuration.interPageDelayMs }, retryPolicy: { maxRetries: configuration.maxRetries }, dependencies: transportDependencies }));
    client = factory(apiKey, args, dependencies.transportDependencies);
    try {
      snapshot = await client.fetchSnapshot(startedAt, provenance);
    } catch (error) {
      const failedAt = dependencies.now?.() ?? new Date().toISOString();
      snapshot = { result: "FAILED", startedAt, completedAt: failedAt, endpoint: ACTIVE_LISTINGS_ENDPOINT, collectionSlug: ACTIVE_LISTINGS_COLLECTION, expectedChain: ACTIVE_LISTINGS_CHAIN, expectedContract: ACTIVE_LISTINGS_CONTRACT, pageAttempts: 0, pagesFetched: 0, httpAttempts: 0, retryAttempts: 0, counters: { observed: 0, normalized: 0, malformed: 0, unsupported: 0, duplicates: 0, conflicts: 0 }, paginationExhausted: false, cursorCycleDetected: false, repeatedPageDetected: false, truncatedByPageLimit: false, truncatedByListingLimit: false, listings: [], rawPages: [], nextCursor: null, warnings: [], errors: [safeText(error, apiKey)], responseHashes: [], sourceProvenance: provenance };
    }
    try {
      const operatorStatus = statusFor(snapshot.result);
      const evidence = sanitize({ operatorVersion: OPERATOR_VERSION, operatorStatus, statement: "THIS PROBE IS RESPONSE-SHAPE / TRANSPORT EVIDENCE ONLY.", authorization: "NOT AUTHORIZATION FOR DEACTIVATION, AUTHORITATIVE DIFF, RECONCILIATION, OR PRODUCTION SWEEP.", startedAt, completedAt: snapshot.completedAt, requestConfiguration: { limit: args.limit, maxPages: args.maxPages, maxListings: args.maxListings, timeoutMs: args.timeoutMs, maxRetries: args.maxRetries, interPageDelayMs: args.interPageDelayMs, method: "GET" }, productionIdentity: { endpoint: ACTIVE_LISTINGS_ENDPOINT, chain: ACTIVE_LISTINGS_CHAIN, collection: ACTIVE_LISTINGS_COLLECTION, contract: ACTIVE_LISTINGS_CONTRACT }, snapshot, executionSummary: summary(operatorStatus, snapshot, args.outputFile) }, apiKey) as ActiveListingsSnapshotEvidence;
      await (dependencies.writeEvidence ?? writeActiveListingsEvidenceExclusive)(args.outputFile, evidence, manifest);
      evidenceCommitted = true;
    } catch (error) {
      operationError = error;
    }
  } catch (error) {
    operationError = error;
    const failedAt = dependencies.now?.() ?? new Date().toISOString();
    snapshot = { result: "FAILED", startedAt, completedAt: failedAt, endpoint: ACTIVE_LISTINGS_ENDPOINT, collectionSlug: ACTIVE_LISTINGS_COLLECTION, expectedChain: ACTIVE_LISTINGS_CHAIN, expectedContract: ACTIVE_LISTINGS_CONTRACT, pageAttempts: 0, pagesFetched: 0, httpAttempts: 0, retryAttempts: 0, counters: { observed: 0, normalized: 0, malformed: 0, unsupported: 0, duplicates: 0, conflicts: 0 }, paginationExhausted: false, cursorCycleDetected: false, repeatedPageDetected: false, truncatedByPageLimit: false, truncatedByListingLimit: false, listings: [], rawPages: [], nextCursor: null, warnings: [], errors: [safeText(error, apiKey)], responseHashes: [], sourceProvenance: provenance };
  } finally {
    try { await client?.close?.(); } catch (error) { cleanupError = error; }
  }
  if (!snapshot) { const failedAt = dependencies.now?.() ?? new Date().toISOString(); snapshot = { result: "FAILED", startedAt, completedAt: failedAt, endpoint: ACTIVE_LISTINGS_ENDPOINT, collectionSlug: ACTIVE_LISTINGS_COLLECTION, expectedChain: ACTIVE_LISTINGS_CHAIN, expectedContract: ACTIVE_LISTINGS_CONTRACT, pageAttempts: 0, pagesFetched: 0, httpAttempts: 0, retryAttempts: 0, counters: { observed: 0, normalized: 0, malformed: 0, unsupported: 0, duplicates: 0, conflicts: 0 }, paginationExhausted: false, cursorCycleDetected: false, repeatedPageDetected: false, truncatedByPageLimit: false, truncatedByListingLimit: false, listings: [], rawPages: [], nextCursor: null, warnings: [], errors: ["operator_snapshot_unavailable"], responseHashes: [], sourceProvenance: provenance }; }
  if (operationError || cleanupError) { const error = cleanupError ?? operationError; log(JSON.stringify({ status: "EVIDENCE_FAILED", evidenceCommitted, error: safeText(error, apiKey) })); return { status: "EVIDENCE_FAILED", exitCode: 5, evidencePath: evidenceCommitted ? args.outputFile : null, summary: summary("EVIDENCE_FAILED", snapshot, evidenceCommitted ? args.outputFile : null) }; }
  const operatorStatus = statusFor(snapshot.result); const result = summary(operatorStatus, snapshot, args.outputFile); log(JSON.stringify(result)); return { status: operatorStatus, exitCode: EXIT_BY_SNAPSHOT[snapshot.result], evidencePath: args.outputFile, summary: result };
}

export async function main(): Promise<void> { const run = await runProbe(process.argv.slice(2)); process.exitCode = run.exitCode; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
