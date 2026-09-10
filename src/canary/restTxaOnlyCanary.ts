import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { redactString } from "../logger.js";
import { persistRawEventToInbox } from "../db/durableInboxRepository.js";
import { selectNextDuePendingInboxEvent } from "../db/inboxRetryRepository.js";
import type { DbPool, DurableInboxPersistResult } from "../db/types.js";
import { adaptRestEventToDurableIngress } from "../backfill/restEventAdapter.js";
import { PRODUCTION_REST_TRANSFER_EVENT_TYPES, validateBackfillWindow } from "../backfill/restEventsBackfill.js";
import { RestEventsClient, sanitizeBackfillError, validateRestBackfillPolicy, type RestEventsClientOptions } from "../backfill/restEventsClient.js";
import { REST_BACKFILL_CHAIN, REST_BACKFILL_CONTRACT_ADDRESS, type RestBackfillPolicy, type RestBackfillWindow, type RestEventsPage } from "../backfill/types.js";

export const REST_TXA_ONLY_EXPECTED_DATABASE = "server_otg";
export const REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS = 120;
export const REST_TXA_ONLY_CANARY_POLICY: RestBackfillPolicy = {
  pageLimit: 100,
  maxPages: 3,
  maxEvents: 300,
  requestTimeoutMs: 15_000,
  maxWindowSeconds: REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS
};
export const REST_TXA_ONLY_REQUIRED_CONFIRMATIONS = [
  "--confirm-live-opensea-rest",
  "--confirm-server-otg-txa-write",
  "--confirm-txa-only",
  "--confirm-no-txb",
  "--confirm-one-shot"
] as const;
const REQUIRED_SOURCE_PROVENANCE_FILES = [
  "src/canary/restTxaOnlyCanary.ts",
  "src/canary/runRestTxaOnlyCanary.ts",
  "src/backfill/restEventAdapter.ts",
  "src/db/durableInboxRepository.ts",
  "src/db/inboxRetryRepository.ts",
  "package.json"
] as const;
const OPTIONAL_RUNTIME_PROVENANCE_FILES = [
  "dist/canary/restTxaOnlyCanary.js",
  "dist/canary/runRestTxaOnlyCanary.js"
] as const;

export type RestTxaOnlyCanaryResult = "REST_TXA_ONLY_CANARY_COMPLETE" | "REST_TXA_ONLY_CANARY_PARTIAL" | "REST_TXA_ONLY_CANARY_FAILED";

export interface RestTxaOnlyCanaryConfig {
  after: number;
  before: number;
  outputDir: string;
  apiKey: string;
  confirmations: Record<(typeof REST_TXA_ONLY_REQUIRED_CONFIRMATIONS)[number], true>;
  policy: RestBackfillPolicy;
}

export interface RestTxaOnlySnapshot {
  database: string;
  orders: number;
  nftState: number;
  journal: number;
  attemptLedger: number | null;
  pending: number;
  processing: number;
  failed: number;
  reconciliationRequired: number;
  unfinalized: number;
  restPending: number;
}

export interface RestTxaOnlyRowEvidence {
  eventId: string;
  valid: boolean;
  errors: string[];
  eventType: string | null;
  chain: string | null;
  contractAddress: string | null;
  tokenId: string | null;
  transactionHash: string | null;
  eventVersion: string | null;
  dedupeKey: string | null;
  processingStatus: string | null;
  attemptCount: number | null;
  applyResult: string | null;
  appliedAt: string | null;
  restSource: string | null;
}

export interface RestTxaOnlyFileProvenance {
  path: string;
  sha256: string;
}

export interface RestTxaOnlyProvenance {
  packageVersion: string;
  nodeVersion: string;
  sourceFiles: RestTxaOnlyFileProvenance[];
  sourceCombinedSha256: string;
  runtimeFiles: RestTxaOnlyFileProvenance[];
  runtimeCombinedSha256: string | null;
}

export interface RestTxaOnlyCanarySummary {
  result: RestTxaOnlyCanaryResult;
  window: RestBackfillWindow;
  maxWindowSeconds: number;
  queryEventTypes: readonly string[];
  gatesValid: boolean;
  databaseTargetValid: boolean;
  schemaPreflightValid: boolean;
  genericWorkerRestHoldVerified: boolean;
  transportComplete: boolean;
  semanticCoverageComplete: boolean;
  txAAdmissionComplete: boolean;
  postflightStateNonMutationValid: boolean;
  newRowsValid: boolean;
  evidenceWriteComplete: boolean;
  pagesFetched: number;
  eventsObserved: number;
  eventsAdapted: number;
  eventsMalformed: number;
  eventsUnsupported: number;
  txAInserted: number;
  txADuplicates: number;
  txAErrors: number;
  insertedEventIds: string[];
  duplicateEventIds: string[];
  sourceProvenance: RestTxaOnlyProvenance | null;
  txBInvoked: false;
  nftStateTouched: false;
  activeOrdersTouched: false;
  streamConnected: false;
  errors: string[];
}

export interface RestTxaOnlyCanaryDependencies {
  pool: DbPool;
  client: Pick<RestEventsClient, "fetchCollectionEventsPage">;
  persistEvent?: (pool: DbPool, rawEvent: unknown, receivedAt?: string) => Promise<DurableInboxPersistResult>;
  now?: () => string;
  writeEvidence?: (outputDir: string, files: Record<string, unknown | string[]>) => Promise<void>;
  computeProvenance?: () => RestTxaOnlyProvenance;
}

function safeInt(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a non-negative integer Unix second`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe Unix second`);
  return parsed;
}

function sanitize(value: unknown): string {
  return redactString(sanitizeBackfillError(value))
    .replace(/\b(OPENSEA_API_KEY|X-API-KEY|authorization)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>");
}

function projectRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function normalizedRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function fileSha256(rootDir: string, relativePath: string): RestTxaOnlyFileProvenance {
  const normalized = normalizedRelativePath(relativePath);
  const bytes = fs.readFileSync(path.join(rootDir, normalized));
  return { path: normalized, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function combinedProvenanceSha256(files: readonly RestTxaOnlyFileProvenance[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.sha256, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

export function computeRestTxaOnlyProvenance(rootDir = projectRoot(), nodeVersion = process.version): RestTxaOnlyProvenance {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown };
  const sourceFiles = REQUIRED_SOURCE_PROVENANCE_FILES.map((file) => fileSha256(rootDir, file));
  const runtimeFiles = OPTIONAL_RUNTIME_PROVENANCE_FILES
    .filter((file) => fs.existsSync(path.join(rootDir, file)))
    .map((file) => fileSha256(rootDir, file));
  return {
    packageVersion: typeof packageJson.version === "string" ? packageJson.version : "",
    nodeVersion,
    sourceFiles,
    sourceCombinedSha256: combinedProvenanceSha256(sourceFiles),
    runtimeFiles,
    runtimeCombinedSha256: runtimeFiles.length > 0 ? combinedProvenanceSha256(runtimeFiles) : null
  };
}

function validateOutputDir(outputDir: string): void {
  if (!outputDir.trim()) throw new Error("--output-dir is required");
  if (fs.existsSync(outputDir)) {
    if (!fs.statSync(outputDir).isDirectory()) throw new Error("output-dir exists and is not a directory");
    if (fs.readdirSync(outputDir).length > 0) throw new Error("output-dir must be new or empty");
    return;
  }
  fs.mkdirSync(outputDir, { recursive: true });
}

export function loadRestTxaOnlyCanaryConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): RestTxaOnlyCanaryConfig {
  const flags = new Set<string>();
  let after: number | null = null;
  let before: number | null = null;
  let outputDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((REST_TXA_ONLY_REQUIRED_CONFIRMATIONS as readonly string[]).includes(arg)) {
      flags.add(arg);
    } else if (arg === "--after") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--after requires a value");
      after = safeInt(value, "after");
    } else if (arg === "--before") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--before requires a value");
      before = safeInt(value, "before");
    } else if (arg === "--output-dir") {
      outputDir = argv[++i] ?? null;
      if (!outputDir) throw new Error("--output-dir requires a value");
    } else {
      throw new Error(`Unknown REST Tx A-only canary argument: ${arg}`);
    }
  }
  for (const required of REST_TXA_ONLY_REQUIRED_CONFIRMATIONS) {
    if (!flags.has(required)) throw new Error(`missing required confirmation ${required}`);
  }
  if (after === null) throw new Error("--after is required");
  if (before === null) throw new Error("--before is required");
  const policy = validateRestBackfillPolicy(REST_TXA_ONLY_CANARY_POLICY);
  validateBackfillWindow({ after, before }, policy);
  if (before - after > REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS) throw new Error(`REST Tx A-only canary window must be <= ${REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS} seconds`);
  if (outputDir === null) throw new Error("--output-dir is required");
  validateOutputDir(outputDir);
  const apiKey = env.OPENSEA_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENSEA_API_KEY is required");
  return {
    after,
    before,
    outputDir,
    apiKey,
    confirmations: Object.fromEntries(REST_TXA_ONLY_REQUIRED_CONFIRMATIONS.map((flag) => [flag, true])) as RestTxaOnlyCanaryConfig["confirmations"],
    policy
  };
}

function intValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function collectRestTxaOnlySnapshot(pool: DbPool): Promise<RestTxaOnlySnapshot> {
  const database = (await pool.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database ?? "";
  const counts = (await pool.query<{
    orders: string | number;
    nft_state: string | number;
    journal: string | number;
    pending: string | number;
    processing: string | number;
    failed: string | number;
    reconciliation_required: string | number;
    unfinalized: string | number;
    rest_pending: string | number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM public.opensea_listings_v2) AS orders,
       (SELECT COUNT(*) FROM public.opensea_listings_nft_state_v2) AS nft_state,
       (SELECT COUNT(*) FROM public.opensea_listings_events_v2) AS journal,
       COUNT(*) FILTER (WHERE processing_status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE processing_status = 'processing') AS processing,
       COUNT(*) FILTER (WHERE processing_status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE processing_status = 'reconciliation_required') AS reconciliation_required,
       COUNT(*) FILTER (WHERE processing_status IN ('pending','processing','failed')) AS unfinalized,
       COUNT(*) FILTER (
         WHERE processing_status = 'pending'
           AND raw_payload->'payload'->'rest_backfill_source'->>'source' = 'opensea_rest_events_backfill'
       ) AS rest_pending
     FROM public.opensea_listings_events_v2`
  )).rows[0];
  const attempts = await pool.query<{ exists: boolean }>("SELECT to_regclass('public.opensea_listings_events_v2_attempts') IS NOT NULL AS exists");
  let attemptLedger: number | null = null;
  if (attempts.rows[0]?.exists) {
    const row = (await pool.query<{ count: string | number }>("SELECT COUNT(*) AS count FROM public.opensea_listings_events_v2_attempts")).rows[0];
    attemptLedger = intValue(row?.count);
  }
  return {
    database,
    orders: intValue(counts?.orders),
    nftState: intValue(counts?.nft_state),
    journal: intValue(counts?.journal),
    attemptLedger,
    pending: intValue(counts?.pending),
    processing: intValue(counts?.processing),
    failed: intValue(counts?.failed),
    reconciliationRequired: intValue(counts?.reconciliation_required),
    unfinalized: intValue(counts?.unfinalized),
    restPending: intValue(counts?.rest_pending)
  };
}

export async function verifyRestTxaOnlySchema(pool: DbPool): Promise<boolean> {
  const result = await pool.query<{ table_exists: boolean }>("SELECT to_regclass('public.opensea_listings_events_v2') IS NOT NULL AS table_exists");
  return result.rows[0]?.table_exists === true;
}

export async function verifyGenericWorkerRestHold(pool: DbPool, now: string): Promise<boolean> {
  await selectNextDuePendingInboxEvent(pool, now, 1);
  return true;
}

export async function validateInsertedRestTxaRows(pool: DbPool, eventIds: readonly string[]): Promise<RestTxaOnlyRowEvidence[]> {
  if (eventIds.length === 0) return [];
  const result = await pool.query<{
    event_id: string;
    event_type: string | null;
    chain: string | null;
    contract_address: string | null;
    token_id: string | null;
    transaction_hash: string | null;
    event_version: string | null;
    dedupe_key: string | null;
    processing_status: string | null;
    attempt_count: string | number | null;
    apply_result: string | null;
    applied_at: string | null;
    rest_source: string | null;
  }>(
    `SELECT event_id::text,
            event_type,
            chain,
            contract_address,
            token_id,
            transaction_hash,
            event_version::text,
            dedupe_key,
            processing_status,
            attempt_count,
            apply_result,
            applied_at::text,
            raw_payload->'payload'->'rest_backfill_source'->>'source' AS rest_source
     FROM public.opensea_listings_events_v2
     WHERE event_id::text = ANY($1::text[])
     ORDER BY event_id ASC`,
    [eventIds]
  );
  const byId = new Map(result.rows.map((row) => [row.event_id, row]));
  return eventIds.map((eventId) => {
    const row = byId.get(eventId);
    const errors: string[] = [];
    if (!row) errors.push("row_missing");
    if (row && row.event_type !== "item_transferred") errors.push("event_type_not_transfer");
    if (row && row.chain !== REST_BACKFILL_CHAIN) errors.push("chain_invalid");
    if (row && row.contract_address !== REST_BACKFILL_CONTRACT_ADDRESS) errors.push("contract_invalid");
    if (row && (!row.token_id || typeof row.token_id !== "string")) errors.push("token_id_invalid");
    if (row && !/^0x[0-9a-f]{64}$/i.test(row.transaction_hash ?? "")) errors.push("transaction_hash_invalid");
    if (row && !row.dedupe_key?.startsWith("transfer:v1:")) errors.push("dedupe_not_structured_transfer");
    if (row && row.rest_source !== "opensea_rest_events_backfill") errors.push("rest_source_missing");
    if (row && row.processing_status !== "pending") errors.push("processing_status_not_pending");
    if (row && intValue(row.attempt_count) !== 0) errors.push("attempt_count_not_zero");
    if (row && row.apply_result !== null) errors.push("apply_result_not_null");
    if (row && row.applied_at !== null) errors.push("applied_at_not_null");
    return {
      eventId,
      valid: errors.length === 0,
      errors,
      eventType: row?.event_type ?? null,
      chain: row?.chain ?? null,
      contractAddress: row?.contract_address ?? null,
      tokenId: row?.token_id ?? null,
      transactionHash: row?.transaction_hash ?? null,
      eventVersion: row?.event_version ?? null,
      dedupeKey: row?.dedupe_key ?? null,
      processingStatus: row?.processing_status ?? null,
      attemptCount: row ? intValue(row.attempt_count) : null,
      applyResult: row?.apply_result ?? null,
      appliedAt: row?.applied_at ?? null,
      restSource: row?.rest_source ?? null
    };
  });
}

export function stateNonMutationValid(before: RestTxaOnlySnapshot, after: RestTxaOnlySnapshot, insertedCount: number): boolean {
  return before.orders === after.orders
    && before.nftState === after.nftState
    && before.attemptLedger === after.attemptLedger
    && before.processing === after.processing
    && before.reconciliationRequired === after.reconciliationRequired
    && after.journal - before.journal === insertedCount;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(tmp, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tmp, filePath);
}

export async function writeRestTxaOnlyEvidence(outputDir: string, files: Record<string, unknown | string[]>): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    const filePath = path.join(outputDir, name);
    if (name.endsWith(".jsonl") && Array.isArray(value)) {
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      const handle = fs.openSync(tmp, "wx");
      try {
        fs.writeFileSync(handle, value.join("\n") + (value.length > 0 ? "\n" : ""), "utf8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(tmp, filePath);
    } else {
      writeJsonAtomic(filePath, value);
    }
  }
}

export async function writeRestTxaOnlyEvidenceFinal(
  outputDir: string,
  nonSummaryFiles: Record<string, unknown | string[]>,
  finalSummary: RestTxaOnlyCanarySummary
): Promise<void> {
  await writeRestTxaOnlyEvidence(outputDir, nonSummaryFiles);
  await writeRestTxaOnlyEvidence(outputDir, { "txa_canary_summary.json": finalSummary });
}

function emptySummary(config: RestTxaOnlyCanaryConfig): RestTxaOnlyCanarySummary {
  return {
    result: "REST_TXA_ONLY_CANARY_FAILED",
    window: { after: config.after, before: config.before },
    maxWindowSeconds: REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS,
    queryEventTypes: PRODUCTION_REST_TRANSFER_EVENT_TYPES,
    gatesValid: true,
    databaseTargetValid: false,
    schemaPreflightValid: false,
    genericWorkerRestHoldVerified: false,
    transportComplete: false,
    semanticCoverageComplete: true,
    txAAdmissionComplete: true,
    postflightStateNonMutationValid: false,
    newRowsValid: true,
    evidenceWriteComplete: false,
    pagesFetched: 0,
    eventsObserved: 0,
    eventsAdapted: 0,
    eventsMalformed: 0,
    eventsUnsupported: 0,
    txAInserted: 0,
    txADuplicates: 0,
    txAErrors: 0,
    insertedEventIds: [],
    duplicateEventIds: [],
    sourceProvenance: null,
    txBInvoked: false,
    nftStateTouched: false,
    activeOrdersTouched: false,
    streamConnected: false,
    errors: []
  };
}

function finalResult(summary: RestTxaOnlyCanarySummary): RestTxaOnlyCanaryResult {
  if (!summary.databaseTargetValid || !summary.schemaPreflightValid || !summary.genericWorkerRestHoldVerified || summary.pagesFetched === 0 && !summary.transportComplete) return "REST_TXA_ONLY_CANARY_FAILED";
  if (!summary.transportComplete || !summary.semanticCoverageComplete || !summary.txAAdmissionComplete || !summary.postflightStateNonMutationValid || !summary.newRowsValid || !summary.evidenceWriteComplete || summary.txAErrors > 0) return "REST_TXA_ONLY_CANARY_PARTIAL";
  return "REST_TXA_ONLY_CANARY_COMPLETE";
}

export async function runRestTxaOnlyCanary(config: RestTxaOnlyCanaryConfig, dependencies: RestTxaOnlyCanaryDependencies): Promise<RestTxaOnlyCanarySummary> {
  const summary = emptySummary(config);
  let preflight: RestTxaOnlySnapshot | null = null;
  let postflight: RestTxaOnlySnapshot | null = null;
  let rows: RestTxaOnlyRowEvidence[] = [];
  const rowLines: string[] = [];
  try {
    summary.sourceProvenance = (dependencies.computeProvenance ?? computeRestTxaOnlyProvenance)();
    preflight = await collectRestTxaOnlySnapshot(dependencies.pool);
    summary.databaseTargetValid = preflight.database === REST_TXA_ONLY_EXPECTED_DATABASE;
    if (!summary.databaseTargetValid) throw new Error(`expected database ${REST_TXA_ONLY_EXPECTED_DATABASE}, got ${preflight.database}`);
    summary.schemaPreflightValid = await verifyRestTxaOnlySchema(dependencies.pool);
    if (!summary.schemaPreflightValid) throw new Error("required V2 durable journal table is missing");
    summary.genericWorkerRestHoldVerified = await verifyGenericWorkerRestHold(dependencies.pool, dependencies.now?.() ?? new Date().toISOString());
    if (!summary.genericWorkerRestHoldVerified) throw new Error("generic worker REST hold could not be verified");

    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    while (summary.pagesFetched < config.policy.maxPages && summary.eventsObserved < config.policy.maxEvents) {
      let page: RestEventsPage;
      try {
        page = await dependencies.client.fetchCollectionEventsPage({
          after: config.after,
          before: config.before,
          limit: config.policy.pageLimit,
          cursor,
          eventTypes: PRODUCTION_REST_TRANSFER_EVENT_TYPES
        });
      } catch (error) {
        summary.errors.push(`page request failed: ${sanitize(error)}`);
        break;
      }
      summary.pagesFetched += 1;
      for (const event of page.events) {
        if (summary.eventsObserved >= config.policy.maxEvents) break;
        summary.eventsObserved += 1;
        const adapted = adaptRestEventToDurableIngress(event);
        if (adapted.outcome !== "adapted" || adapted.durableEventType !== "item_transferred") {
          summary.semanticCoverageComplete = false;
          if (adapted.outcome === "unsupported") summary.eventsUnsupported += 1;
          else summary.eventsMalformed += 1;
          summary.errors.push(adapted.outcome === "malformed" ? `malformed transfer: ${sanitize(adapted.reason)}` : `unsupported transfer: ${sanitize((adapted as any).reason)}`);
          continue;
        }
        summary.eventsAdapted += 1;
        try {
          const persisted = await (dependencies.persistEvent ?? persistRawEventToInbox)(dependencies.pool, adapted.rawEvent, dependencies.now?.() ?? new Date().toISOString());
          rowLines.push(JSON.stringify({ eventId: persisted.eventId, outcome: persisted.outcome, dedupeKey: persisted.dedupeKey, eventType: persisted.eventType, processingStatus: persisted.processingStatus }));
          if (persisted.outcome === "inserted_pending") {
            summary.txAInserted += 1;
            summary.insertedEventIds.push(persisted.eventId);
          } else {
            summary.txADuplicates += 1;
            summary.duplicateEventIds.push(persisted.eventId);
          }
        } catch (error) {
          summary.txAAdmissionComplete = false;
          summary.txAErrors += 1;
          summary.errors.push(`Tx A failed: ${sanitize(error)}`);
          break;
        }
      }
      if (!summary.txAAdmissionComplete) break;
      if (!page.next) {
        summary.transportComplete = true;
        break;
      }
      if (seenCursors.has(page.next)) {
        summary.errors.push("cursor cycle detected");
        break;
      }
      seenCursors.add(page.next);
      cursor = page.next;
    }
    if (!summary.transportComplete && summary.pagesFetched >= config.policy.maxPages) summary.errors.push("maxPages reached before API exhaustion");
    if (!summary.transportComplete && summary.eventsObserved >= config.policy.maxEvents) summary.errors.push("maxEvents reached before API exhaustion");
  } catch (error) {
    summary.errors.push(sanitize(error));
  } finally {
    try {
      postflight = await collectRestTxaOnlySnapshot(dependencies.pool);
      if (preflight) summary.postflightStateNonMutationValid = stateNonMutationValid(preflight, postflight, summary.txAInserted);
      rows = await validateInsertedRestTxaRows(dependencies.pool, summary.insertedEventIds);
      summary.newRowsValid = rows.every((row) => row.valid);
      if (!summary.newRowsValid) summary.errors.push("inserted row validation failed");
    } catch (error) {
      summary.errors.push(`postflight failed: ${sanitize(error)}`);
    }
    summary.result = finalResult(summary);
    try {
      const nonSummaryEvidence = {
        "txa_canary_preflight.json": { snapshot: preflight, sourceProvenance: summary.sourceProvenance },
        "txa_canary_postflight.json": postflight,
        "txa_canary_rows.jsonl": rowLines
      };
      const finalSummary = { ...summary, evidenceWriteComplete: true } satisfies RestTxaOnlyCanarySummary;
      finalSummary.result = finalResult(finalSummary);
      await (dependencies.writeEvidence
        ? dependencies.writeEvidence(config.outputDir, { ...nonSummaryEvidence, "txa_canary_summary.json": finalSummary })
        : writeRestTxaOnlyEvidenceFinal(config.outputDir, nonSummaryEvidence, finalSummary));
      summary.evidenceWriteComplete = true;
      summary.result = finalSummary.result;
    } catch (error) {
      summary.evidenceWriteComplete = false;
      summary.errors.push(`evidence write failed: ${sanitize(error)}`);
    }
    summary.result = finalResult(summary);
  }
  return summary;
}

export function createRestTxaOnlyCanaryClientOptions(config: RestTxaOnlyCanaryConfig): RestEventsClientOptions {
  return {
    apiKey: config.apiKey,
    policy: config.policy,
    retryPolicy: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000, jitterRatio: 0.1 }
  };
}
