import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { applyPendingInboxEvent } from "../db/pendingInboxApplicationService.js";
import type { DbPool, PendingInboxApplyResult } from "../db/types.js";
import { acquireV2RuntimeGuard, type V2RuntimeGuard } from "../runtime/runtimeGuard.js";
import {
  classifyRestTransferWindowEvents,
  loadRestTransferWindowJournalCandidates,
  protectedBoundarySecondsForWindow,
  type ClassifiedTransferWindowEvent,
  type RestTransferWindowClassification,
  type TransferJournalCandidate
} from "../backfill/restTransferWindowBarrier.js";
import { normalizeBusinessSecond, normalizeTransferEvent } from "../state/normalizers.js";
import {
  canonicalizePgTimestamptzForClassifier,
  combinedReleaseEvidenceSha256,
  verifyRestTxbReleaseEvidence,
  type RestTxbEventRow,
  type RestTxbFileProvenance,
  type RestTxbNftRow,
  type RestTxbReleaseEvidence,
  type RestTxbSnapshotCounts,
  type RestTxbProvenance
} from "./restTxbSingleEventCanary.js";

export const MULTI_REST_TXB_DATABASE = "server_otg";
export const MULTI_REST_TXB_TARGET_IDS = ["84", "86"] as const;
export const MULTI_REST_TXB_ORDERED_IDS = ["86", "84"] as const;
export const MULTI_REST_TXB_MAX_TARGETS = 2 as const;
export const MULTI_REST_TXB_RELEASE_SCOPE = { after: 1786618485, before: 1786618545 } as const;
export const MULTI_REST_TXB_RELEASE_EVIDENCE_DIR = "C:\\VAMBAM\\Projects\\OTG\\DEV\\2026-08-15_opensea_v2_full_window_rest_txa_release_admission_evidence";
export const MULTI_REST_TXB_EXPECTED_APPLY_RESULT = "inserted_nft_transfer;suppressed_orders=0";
export const MULTI_REST_TXB_AMBIGUOUS_APPLY_RESULT = "rest_transfer_ambiguous_same_second_no_state_mutation";
export const MULTI_REST_TXB_CONFIRMATIONS = [
  "--confirm-server-otg-txb-write",
  "--confirm-multi-event",
  "--confirm-events-84-86",
  "--confirm-state-mutation",
  "--confirm-runtime-guard",
  "--confirm-no-generic-worker",
  "--confirm-no-rest",
  "--confirm-no-txa",
  "--confirm-one-shot"
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";
const EXPECTED = {
  "84": { eventId: "84", eventTimestamp: "2026-08-13T10:55:41.000Z", tokenId: "48804196", transactionHash: "0xe7af35f01f1964d07ea91f00bb3463e54646141ac4387276f98e837c57d8e74d", dedupeKey: "transfer:v1:455ba5b6607ec231f9646f58c4b0b6643ecd436cc7f4856185c9a524ad6cf88d", canonicalTo: "0x9358fbf091d1bba21d4ff4cd5e1b7af3487d72d8" },
  "86": { eventId: "86", eventTimestamp: "2026-08-13T10:55:39.000Z", tokenId: "48804194", transactionHash: "0x7f42cbc36f71eba2e835f35da9857361d87beac947cdc78c3d963ef350274070", dedupeKey: "transfer:v1:32ae1a92e603be4cb99f7c48eb79f63213ac78a0de70937ff8ce68269d761732", canonicalTo: "0xf2e8148fa50555903cafcbd711a61bf3328eecbf" }
} as const;
const EXPECTED_CHAIN = "gunzilla";
const EXPECTED_CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271";
const REST_SOURCE = "opensea_rest_events_backfill";

export type MultiRestTxbResult =
  | "MULTI_REST_TXB_COMPLETE"
  | "MULTI_REST_TXB_ABORTED_PREFLIGHT"
  | "MULTI_REST_TXB_SAFE_STOP_AMBIGUOUS"
  | "MULTI_REST_TXB_PARTIAL"
  | "MULTI_REST_TXB_FAILED";

export interface MultiRestTxbConfig {
  eventIds: typeof MULTI_REST_TXB_TARGET_IDS;
  outputDir: string;
  confirmations: Record<(typeof MULTI_REST_TXB_CONFIRMATIONS)[number], true>;
}

export interface MultiRestTxbTargetSnapshot {
  event: RestTxbEventRow | null;
  nftState: RestTxbNftRow | null;
  activeOrders: unknown[];
  attempts: unknown[];
  dedupeRows: { eventId: string; processingStatus: string | null; dedupeKey: string | null }[];
  sameSecondCandidates: TransferJournalCandidate[];
  classification: ClassifiedTransferWindowEvent | null;
  validationErrors: string[];
}

export interface MultiRestTxbSnapshot {
  counts: RestTxbSnapshotCounts | null;
  targets: Record<string, MultiRestTxbTargetSnapshot>;
  candidateCoverageComplete: boolean;
  releaseEvidence: RestTxbReleaseEvidence | null;
  protectedBoundarySeconds: readonly string[];
  validationErrors: string[];
}

export interface MultiRestTxbProvenance extends RestTxbProvenance {
  sourceFiles: RestTxbFileProvenance[];
  runtimeFiles: RestTxbFileProvenance[];
}

export interface MultiRestTxbEventEvidence {
  sequence: number;
  eventId: string;
  identity: (typeof EXPECTED)[keyof typeof EXPECTED];
  preClassification: RestTransferWindowClassification | null;
  preValidation: MultiRestTxbTargetSnapshot;
  txBInvoked: boolean;
  applicationResult: PendingInboxApplyResult | null;
  committed: boolean;
  postValidation: MultiRestTxbTargetSnapshot | null;
  deltas: Record<string, number> | null;
  validationErrors: string[];
  stopReason: string | null;
}

export interface MultiRestTxbSummary {
  result: MultiRestTxbResult;
  plannedEventIds: string[];
  orderedEventIds: string[];
  attemptedEventIds: string[];
  committedEventIds: string[];
  unattemptedEventIds: string[];
  stopEventId: string | null;
  stopReason: string | null;
  gatesValid: boolean;
  databaseTargetValid: boolean;
  schemaPreflightValid: boolean;
  provenanceComplete: boolean;
  releaseEvidenceValid: boolean;
  entirePlanPreflightValid: boolean;
  runtimeGuardAcquired: boolean;
  txBCallCount: number;
  postflightValid: boolean;
  aggregateDeltaValid: boolean;
  evidenceWriteComplete: boolean;
  eventEvidenceWriteComplete: boolean;
  postflightWriteComplete: boolean;
  summaryWriteComplete: boolean;
  guardReleaseAttempted: boolean;
  guardReleaseSucceeded: boolean;
  guardReleaseError: string | null;
  sourceProvenance: MultiRestTxbProvenance | null;
  releaseEvidence: RestTxbReleaseEvidence | null;
  errors: string[];
}

export interface MultiRestTxbDependencies {
  pool: DbPool;
  acquireRuntimeGuard?: (pool: DbPool) => Promise<V2RuntimeGuard>;
  applyEvent?: (pool: DbPool, eventId: string, now: string) => Promise<PendingInboxApplyResult>;
  collectSnapshot?: (pool: DbPool, targetIds: readonly string[]) => Promise<MultiRestTxbSnapshot>;
  computeProvenance?: () => MultiRestTxbProvenance;
  now?: () => string;
  writePlan?: (outputDir: string, value: unknown) => Promise<void>;
  writePreflight?: (outputDir: string, value: unknown) => Promise<void>;
  initializeEvents?: (outputDir: string) => Promise<void>;
  appendEvent?: (outputDir: string, value: unknown) => Promise<void>;
  writePostflight?: (outputDir: string, value: unknown) => Promise<void>;
  writeSummary?: (outputDir: string, value: unknown) => Promise<void>;
}

function projectRoot(): string { return path.resolve(import.meta.dirname, "..", ".."); }
function sanitize(value: unknown): string { return String(value instanceof Error ? value.message : value).replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD|authorization|x-api-key|password|token|secret)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 500); }
function rawObject(value: unknown): any { return typeof value === "string" ? JSON.parse(value) : value; }
function normalizedCandidate(candidate: TransferJournalCandidate): TransferJournalCandidate { return { ...candidate, eventTimestamp: canonicalizePgTimestamptzForClassifier(candidate.eventTimestamp) ?? candidate.eventTimestamp }; }

function fileHash(root: string, relativePath: string): RestTxbFileProvenance {
  const normalized = relativePath.replace(/\\/g, "/");
  return { path: normalized, sha256: createHash("sha256").update(fs.readFileSync(path.join(root, normalized))).digest("hex") };
}

const SOURCE_FILES = [
  "src/canary/restTxbMultiEvent8486Canary.ts", "src/canary/runRestTxbMultiEvent8486Canary.ts", "src/runtime/runtimeGuard.ts",
  "src/db/pendingInboxApplicationService.ts", "src/db/eventApplicationService.ts", "src/backfill/restTransferWindowBarrier.ts",
  "src/db/nftStateRepository.ts", "src/db/listingRepository.ts", "src/state/nftReducer.ts", "src/state/orderReducer.ts",
  "src/state/normalizers.ts", "src/state/eventIdentity.ts", "package.json"
] as const;
const RUNTIME_FILES = ["dist/canary/restTxbMultiEvent8486Canary.js", "dist/canary/runRestTxbMultiEvent8486Canary.js"] as const;

export function combinedMultiRestTxbSha256(files: readonly RestTxbFileProvenance[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0${file.sha256}\n`, "utf8");
  return hash.digest("hex");
}

export function computeMultiRestTxbProvenance(rootDir = projectRoot(), nodeVersion = process.version): MultiRestTxbProvenance {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown };
  const sourceFiles = SOURCE_FILES.map((file) => fileHash(rootDir, file));
  const runtimeFiles = RUNTIME_FILES.map((file) => fileHash(rootDir, file));
  return { packageVersion: typeof pkg.version === "string" ? pkg.version : "", nodeVersion, sourceFiles, sourceCombinedSha256: combinedMultiRestTxbSha256(sourceFiles), runtimeFiles, runtimeCombinedSha256: combinedMultiRestTxbSha256(runtimeFiles) };
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

export function loadRestTxbMultiEventConfig(argv: string[]): MultiRestTxbConfig {
  const flags = new Set<string>();
  let eventIds: string | null = null;
  let outputDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((MULTI_REST_TXB_CONFIRMATIONS as readonly string[]).includes(arg)) flags.add(arg);
    else if (arg === "--event-ids") eventIds = argv[++i] ?? null;
    else if (arg === "--output-dir") outputDir = argv[++i] ?? null;
    else throw new Error(`Unknown REST Tx B multi-event argument: ${arg}`);
  }
  for (const flag of MULTI_REST_TXB_CONFIRMATIONS) if (!flags.has(flag)) throw new Error(`missing required confirmation ${flag}`);
  if (eventIds !== "84,86") throw new Error("multi-event canary is hard-pinned to --event-ids 84,86");
  if (!outputDir) throw new Error("--output-dir is required");
  validateOutputDir(outputDir);
  return { eventIds: MULTI_REST_TXB_TARGET_IDS, outputDir, confirmations: Object.fromEntries(MULTI_REST_TXB_CONFIRMATIONS.map((flag) => [flag, true])) as MultiRestTxbConfig["confirmations"] };
}

function mapEventRow(row: any): RestTxbEventRow {
  const raw = rawObject(row.raw_payload);
  const normalized = normalizeTransferEvent(raw, row.received_at ?? new Date(0).toISOString());
  return { eventId: String(row.event_id), eventType: row.event_type ?? null, eventTimestamp: canonicalizePgTimestamptzForClassifier(row.event_timestamp ?? null), eventVersion: row.event_version == null ? null : String(row.event_version), chain: row.chain ?? null, contractAddress: row.contract_address ?? null, tokenId: row.token_id == null ? null : String(row.token_id), transactionHash: row.transaction_hash ?? null, dedupeKey: row.dedupe_key ?? null, rawPayload: raw, processingStatus: row.processing_status ?? null, attemptCount: row.attempt_count == null ? null : Number(row.attempt_count), nextRetryAt: row.next_retry_at ?? null, applyResult: row.apply_result ?? null, appliedAt: row.applied_at ?? null, processingStartedAt: row.processing_started_at ?? null, lastErrorCode: row.last_error_code ?? null, lastErrorMessage: row.last_error_message ?? null, restSource: raw?.payload?.rest_backfill_source?.source ?? null, rawTransferType: raw?.payload?.rest_backfill_source?.transfer_type ?? null, canonicalFrom: normalized?.from ?? null, canonicalTo: normalized?.to ?? null };
}

export function canonicalizeMultiRestTxbNftTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::?(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const [, date, hour, minute, second, fraction = "", sign, offsetHour, offsetMinute = "00"] = match;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const hours = Number(hour);
  const minutes = Number(minute);
  const seconds = Number(second);
  const offsetHours = Number(offsetHour);
  const offsetMinutes = Number(offsetMinute);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59 || offsetHours > 23 || offsetMinutes > 59) return null;
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
  const utcMillis = Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds) - (sign === "+" ? 1 : -1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  const parsed = new Date(utcMillis);
  const local = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds));
  if (!Number.isFinite(parsed.getTime()) || local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day || local.getUTCHours() !== hours || local.getUTCMinutes() !== minutes || local.getUTCSeconds() !== seconds || local.getUTCMilliseconds() !== milliseconds) return null;
  const iso = parsed.toISOString();
  return fraction.length > 3 ? `${iso.slice(0, 23)}${fraction.slice(3).padEnd(3, "0")}Z` : iso;
}

export function mapMultiRestTxbNftRow(row: any): RestTxbNftRow {
  return { chain: row.chain, contractAddress: row.contract_address, tokenId: String(row.token_id), nftId: row.nft_id, collectionSlug: row.collection_slug, currentOwnerAddress: row.current_owner_address, lastTransferFromAddress: row.last_transfer_from_address, lastTransferToAddress: row.last_transfer_to_address, lastTransferTransactionHash: row.last_transfer_transaction_hash, lastTransferAt: canonicalizeMultiRestTxbNftTimestamp(row.last_transfer_at), lastNftEventTimestamp: canonicalizeMultiRestTxbNftTimestamp(row.last_nft_event_timestamp), lastNftEventVersion: row.last_nft_event_version == null ? null : String(row.last_nft_event_version) };
}

async function counts(pool: DbPool): Promise<RestTxbSnapshotCounts> {
  const db = await pool.query<{ database: string }>("SELECT current_database() AS database");
  const row = (await pool.query<any>(`SELECT
    (SELECT count(*)::int FROM public.opensea_listings_events_v2) journal,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='pending') pending,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='processing') processing,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='failed') failed,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='reconciliation_required') reconciliation_required,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status IN ('pending','processing')) unfinalized,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2_attempts) attempt_ledger,
    (SELECT count(*)::int FROM public.opensea_listings_nft_state_v2) nft_state,
    (SELECT count(*)::int FROM public.opensea_listings_v2) orders`)).rows[0];
  return { database: db.rows[0]?.database ?? "", journal: row?.journal ?? 0, pending: row?.pending ?? 0, processing: row?.processing ?? 0, failed: row?.failed ?? 0, reconciliationRequired: row?.reconciliation_required ?? 0, unfinalized: row?.unfinalized ?? 0, attemptLedger: row?.attempt_ledger ?? 0, nftState: row?.nft_state ?? 0, orders: row?.orders ?? 0 };
}

async function schemaOk(pool: DbPool): Promise<boolean> {
  const result = await pool.query<{ ok: boolean }>(`SELECT to_regclass('public.opensea_listings_events_v2') IS NOT NULL AND to_regclass('public.opensea_listings_events_v2_attempts') IS NOT NULL AND to_regclass('public.opensea_listings_nft_state_v2') IS NOT NULL AND to_regclass('public.opensea_listings_v2') IS NOT NULL AS ok`);
  return Boolean(result.rows[0]?.ok);
}

export async function collectMultiRestTxbSnapshot(pool: DbPool, targetIds: readonly string[] = MULTI_REST_TXB_TARGET_IDS): Promise<MultiRestTxbSnapshot> {
  const all = (await loadRestTransferWindowJournalCandidates(pool, MULTI_REST_TXB_RELEASE_SCOPE)).map(normalizedCandidate);
  const coverage = all.every((candidate) => candidate.eventType !== "item_transferred" || Boolean(candidate.chain && candidate.contractAddress && candidate.tokenId && candidate.transactionHash && candidate.dedupeKey && normalizeBusinessSecond(candidate.eventTimestamp)));
  const classified = classifyRestTransferWindowEvents(all, targetIds, { protectedBoundarySeconds: protectedBoundarySecondsForWindow(MULTI_REST_TXB_RELEASE_SCOPE), candidateCoverageComplete: coverage });
  const byId = new Map(classified.map((item) => [item.eventId, item]));
  const targetSnapshots: Record<string, MultiRestTxbTargetSnapshot> = {};
  for (const id of targetIds) {
    const eventResult = await pool.query<any>(`SELECT event_id::text,event_type,event_timestamp::text,event_version,chain,contract_address,token_id,transaction_hash,dedupe_key,raw_payload,processing_status,attempt_count,next_retry_at::text,apply_result,applied_at::text,processing_started_at::text,last_error_code,last_error_message,received_at::text FROM public.opensea_listings_events_v2 WHERE event_id::text=$1`, [id]);
    const event = eventResult.rows[0] ? mapEventRow(eventResult.rows[0]) : null;
    const raw = event?.rawPayload as any;
    const normalized = event ? normalizeTransferEvent(raw, new Date(0).toISOString()) : null;
    const nftRows = normalized?.nft ? await pool.query<any>(`SELECT chain,contract_address,token_id,nft_id,collection_slug,current_owner_address,last_transfer_from_address,last_transfer_to_address,last_transfer_transaction_hash,last_transfer_at::text,last_nft_event_timestamp::text,last_nft_event_version FROM public.opensea_listings_nft_state_v2 WHERE chain=$1 AND contract_address=$2 AND token_id=$3`, [normalized.nft.chain, normalized.nft.contractAddress, normalized.nft.tokenId]) : { rows: [] };
    const orders = normalized?.nft ? await pool.query<any>(`SELECT order_hash,status,is_active FROM public.opensea_listings_v2 WHERE chain=$1 AND contract_address=$2 AND token_id=$3 AND status='active' AND is_active=true`, [normalized.nft.chain, normalized.nft.contractAddress, normalized.nft.tokenId]) : { rows: [] };
    const attempts = await pool.query<any>(`SELECT * FROM public.opensea_listings_events_v2_attempts WHERE event_id::text=$1`, [id]);
    const dedupeRows = event?.dedupeKey ? await pool.query<any>(`SELECT event_id::text,processing_status,dedupe_key FROM public.opensea_listings_events_v2 WHERE dedupe_key=$1 ORDER BY event_id`, [event.dedupeKey]) : { rows: [] };
    const businessSecond = event?.eventTimestamp ? normalizeBusinessSecond(event.eventTimestamp) : null;
    const sameSecondCandidates = all.filter((candidate) => candidate.eventId === id || (businessSecond !== null && normalizeBusinessSecond(candidate.eventTimestamp) === businessSecond && candidate.chain?.toLowerCase() === event?.chain?.toLowerCase() && candidate.contractAddress?.toLowerCase() === event?.contractAddress?.toLowerCase() && candidate.tokenId === event?.tokenId));
    const conflicts = sameSecondCandidates.filter((candidate) => candidate.eventId !== id && (candidate.transactionHash?.toLowerCase() !== event?.transactionHash?.toLowerCase() || candidate.dedupeKey !== event?.dedupeKey));
    const errors: string[] = [];
    const expected = (EXPECTED as Record<string, (typeof EXPECTED)[keyof typeof EXPECTED]>)[id];
    if (!event) errors.push("event_missing");
    if (expected && event) {
      if (event.eventType !== "item_transferred") errors.push("event_type_mismatch");
      if (event.eventTimestamp !== expected.eventTimestamp) errors.push("timestamp_mismatch");
      if (event.chain !== EXPECTED_CHAIN || event.contractAddress !== EXPECTED_CONTRACT || event.tokenId !== expected.tokenId || event.transactionHash?.toLowerCase() !== expected.transactionHash || event.dedupeKey !== expected.dedupeKey) errors.push("identity_mismatch");
      if (event.restSource !== REST_SOURCE || event.rawTransferType !== "mint" || event.canonicalFrom !== ZERO || event.canonicalTo?.toLowerCase() !== expected.canonicalTo) errors.push("mint_identity_mismatch");
      if (event.processingStatus !== "pending" || event.attemptCount !== 0 || event.nextRetryAt !== null || event.applyResult !== null || event.appliedAt !== null) errors.push("lifecycle_mismatch");
    }
    if (dedupeRows.rows.length !== 1 || dedupeRows.rows[0]?.event_id !== id) errors.push("dedupe_not_unique");
    if (conflicts.length > 0) errors.push("same_second_distinct_transaction");
    if ((byId.get(id)?.classification ?? null) !== "SAFE") errors.push("classification_not_safe");
    if (protectedBoundarySecondsForWindow(MULTI_REST_TXB_RELEASE_SCOPE).includes(expected?.eventTimestamp ?? "")) errors.push("protected_boundary");
    if (nftRows.rows.length !== 0) errors.push("nft_state_exists");
    if (orders.rows.length !== 0) errors.push("active_orders_exist");
    if (id === "82") errors.push("event82_forbidden");
    targetSnapshots[id] = { event, nftState: nftRows.rows[0] ? mapMultiRestTxbNftRow(nftRows.rows[0]) : null, activeOrders: orders.rows, attempts: attempts.rows, dedupeRows: dedupeRows.rows.map((row) => ({ eventId: String(row.event_id), processingStatus: row.processing_status, dedupeKey: row.dedupe_key })), sameSecondCandidates, classification: byId.get(id) ?? null, validationErrors: errors };
  }
  const releaseEvidence = verifyRestTxbReleaseEvidence(coverage, "SAFE", MULTI_REST_TXB_RELEASE_EVIDENCE_DIR);
  return { counts: await counts(pool), targets: targetSnapshots, candidateCoverageComplete: coverage, releaseEvidence, protectedBoundarySeconds: protectedBoundarySecondsForWindow(MULTI_REST_TXB_RELEASE_SCOPE), validationErrors: Object.values(targetSnapshots).flatMap((target) => target.validationErrors) };
}

function difference(before: RestTxbSnapshotCounts | null, after: RestTxbSnapshotCounts | null): Record<string, number> | null {
  if (!before || !after) return null;
  return { journal: after.journal - before.journal, pending: after.pending - before.pending, processing: after.processing - before.processing, failed: after.failed - before.failed, reconciliationRequired: after.reconciliationRequired - before.reconciliationRequired, unfinalized: after.unfinalized - before.unfinalized, attemptLedger: after.attemptLedger - before.attemptLedger, nftState: after.nftState - before.nftState, orders: after.orders - before.orders };
}

function emptySummary(): MultiRestTxbSummary {
  return { result: "MULTI_REST_TXB_FAILED", plannedEventIds: [...MULTI_REST_TXB_TARGET_IDS], orderedEventIds: [...MULTI_REST_TXB_ORDERED_IDS], attemptedEventIds: [], committedEventIds: [], unattemptedEventIds: [...MULTI_REST_TXB_ORDERED_IDS], stopEventId: null, stopReason: null, gatesValid: true, databaseTargetValid: false, schemaPreflightValid: false, provenanceComplete: false, releaseEvidenceValid: false, entirePlanPreflightValid: false, runtimeGuardAcquired: false, txBCallCount: 0, postflightValid: false, aggregateDeltaValid: false, evidenceWriteComplete: false, eventEvidenceWriteComplete: false, postflightWriteComplete: false, summaryWriteComplete: false, guardReleaseAttempted: false, guardReleaseSucceeded: false, guardReleaseError: null, sourceProvenance: null, releaseEvidence: null, errors: [] };
}

function resultFor(summary: MultiRestTxbSummary, ambiguous = false): MultiRestTxbResult {
  if (!summary.gatesValid || !summary.databaseTargetValid || !summary.schemaPreflightValid || !summary.provenanceComplete) return "MULTI_REST_TXB_FAILED";
  if (!summary.entirePlanPreflightValid || !summary.releaseEvidenceValid) return "MULTI_REST_TXB_ABORTED_PREFLIGHT";
  if (ambiguous) return "MULTI_REST_TXB_SAFE_STOP_AMBIGUOUS";
  if (summary.attemptedEventIds.length !== summary.orderedEventIds.length || summary.committedEventIds.length !== summary.orderedEventIds.length) return summary.committedEventIds.length > 0 ? "MULTI_REST_TXB_PARTIAL" : "MULTI_REST_TXB_FAILED";
  if (!summary.postflightValid || !summary.aggregateDeltaValid || !summary.evidenceWriteComplete || !summary.eventEvidenceWriteComplete || !summary.postflightWriteComplete || !summary.summaryWriteComplete) return summary.committedEventIds.length > 0 ? "MULTI_REST_TXB_PARTIAL" : "MULTI_REST_TXB_FAILED";
  if (!summary.guardReleaseAttempted || !summary.guardReleaseSucceeded) return summary.committedEventIds.length > 0 ? "MULTI_REST_TXB_PARTIAL" : "MULTI_REST_TXB_FAILED";
  return "MULTI_REST_TXB_COMPLETE";
}

function validatePlan(snapshot: MultiRestTxbSnapshot): string[] {
  const errors = [...snapshot.validationErrors];
  if (snapshot.counts?.database !== MULTI_REST_TXB_DATABASE) errors.push("database_target_invalid");
  if (!snapshot.candidateCoverageComplete) errors.push("candidate_coverage_incomplete");
  if (!snapshot.releaseEvidence?.releaseEligible) errors.push("release_evidence_not_eligible");
  for (const id of MULTI_REST_TXB_TARGET_IDS) if (!snapshot.targets[id]) errors.push(`${id}_missing_from_plan`);
  return errors;
}

export function validateMultiRestTxbEventSuccess(before: MultiRestTxbSnapshot, after: MultiRestTxbSnapshot, applied: PendingInboxApplyResult, id: string): string[] {
  const errors: string[] = [];
  const event = after.targets[id]?.event;
  const nft = after.targets[id]?.nftState;
  const expected = EXPECTED[id as "84" | "86"];
  if (applied.outcome !== "reconciliation_required" || applied.processingStatus !== "reconciliation_required" || applied.attemptCount !== 1 || applied.applyResult !== MULTI_REST_TXB_EXPECTED_APPLY_RESULT) errors.push("application_result_mismatch");
  if (!event || event.processingStatus !== "reconciliation_required" || event.attemptCount !== 1 || event.applyResult !== MULTI_REST_TXB_EXPECTED_APPLY_RESULT || event.appliedAt === null || event.nextRetryAt !== null || event.processingStartedAt !== null) errors.push("event_final_state_mismatch");
  if (!nft || nft.tokenId !== expected.tokenId || nft.currentOwnerAddress?.toLowerCase() !== expected.canonicalTo || nft.lastTransferFromAddress?.toLowerCase() !== ZERO || nft.lastTransferToAddress?.toLowerCase() !== expected.canonicalTo || nft.lastTransferTransactionHash?.toLowerCase() !== expected.transactionHash || nft.lastNftEventTimestamp !== expected.eventTimestamp || nft.lastNftEventVersion !== null) errors.push("nft_final_state_mismatch");
  if ((after.targets[id]?.activeOrders.length ?? 0) !== 0) errors.push("order_delta_unexpected");
  if ((after.targets[id]?.attempts.length ?? 0) !== (before.targets[id]?.attempts.length ?? 0)) errors.push("attempt_delta_unexpected");
  const delta = difference(before.counts, after.counts);
  if (!delta || delta.journal !== 0 || delta.pending !== -1 || delta.processing !== 0 || delta.reconciliationRequired !== 1 || delta.unfinalized !== -1 || delta.nftState !== 1 || delta.orders !== 0 || delta.attemptLedger !== 0) errors.push("aggregate_delta_unexpected");
  return errors;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const handle = fs.openSync(temp, "wx");
  try { fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temp, filePath);
}
async function defaultWriteJson(outputDir: string, name: string, value: unknown): Promise<void> { writeJsonAtomic(path.join(outputDir, name), value); }
async function defaultInitEvents(outputDir: string): Promise<void> { const handle = fs.openSync(path.join(outputDir, "multi_txb_events.jsonl"), "wx"); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }
async function defaultAppendEvent(outputDir: string, value: unknown): Promise<void> { const handle = fs.openSync(path.join(outputDir, "multi_txb_events.jsonl"), "a"); try { fs.writeFileSync(handle, `${JSON.stringify(value)}\n`, "utf8"); fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }

export async function runRestTxbMultiEventCanary(config: MultiRestTxbConfig, dependencies: MultiRestTxbDependencies): Promise<MultiRestTxbSummary> {
  const summary = emptySummary();
  let guard: V2RuntimeGuard | null = null;
  let planSnapshot: MultiRestTxbSnapshot | null = null;
  let lastSnapshot: MultiRestTxbSnapshot | null = null;
  let ambiguous = false;
  let finalSummary: MultiRestTxbSummary = summary;
  const committedEventRecords = new Map<string, MultiRestTxbEventEvidence>();
  const appendEvent = dependencies.appendEvent ?? defaultAppendEvent;
  const writePlan = dependencies.writePlan ?? ((dir, value) => defaultWriteJson(dir, "multi_txb_plan.json", value));
  const writePreflight = dependencies.writePreflight ?? ((dir, value) => defaultWriteJson(dir, "multi_txb_preflight.json", value));
  const writePostflight = dependencies.writePostflight ?? ((dir, value) => defaultWriteJson(dir, "multi_txb_postflight.json", value));
  const writeSummary = dependencies.writeSummary ?? ((dir, value) => defaultWriteJson(dir, "multi_txb_summary.json", value));
  try {
    summary.sourceProvenance = (dependencies.computeProvenance ?? computeMultiRestTxbProvenance)();
    summary.provenanceComplete = true;
    guard = await (dependencies.acquireRuntimeGuard ?? ((pool) => acquireV2RuntimeGuard(pool, "durable_inbox")))(dependencies.pool);
    summary.runtimeGuardAcquired = true;
    planSnapshot = await (dependencies.collectSnapshot ?? collectMultiRestTxbSnapshot)(dependencies.pool, MULTI_REST_TXB_TARGET_IDS);
    lastSnapshot = planSnapshot;
    summary.databaseTargetValid = planSnapshot.counts?.database === MULTI_REST_TXB_DATABASE;
    summary.schemaPreflightValid = await schemaOk(dependencies.pool);
    summary.releaseEvidence = planSnapshot.releaseEvidence;
    summary.releaseEvidenceValid = Boolean(planSnapshot.releaseEvidence?.releaseEligible && planSnapshot.releaseEvidence.transportComplete && planSnapshot.releaseEvidence.semanticCoverageComplete && planSnapshot.releaseEvidence.txAAdmissionComplete);
    const planErrors = validatePlan(planSnapshot);
    summary.entirePlanPreflightValid = planErrors.length === 0 && MULTI_REST_TXB_TARGET_IDS.every((id) => planSnapshot?.targets[id]?.validationErrors.length === 0);
    if (planErrors.length > 0 || !summary.entirePlanPreflightValid) throw new Error(`multi-event preflight aborted: ${[...planErrors, ...MULTI_REST_TXB_TARGET_IDS.flatMap((id) => planSnapshot?.targets[id]?.validationErrors ?? [])].join(",")}`);
    await writePlan(config.outputDir, { targetEventIds: [...MULTI_REST_TXB_TARGET_IDS], orderedEventIds: [...MULTI_REST_TXB_ORDERED_IDS], maxTargetCount: MULTI_REST_TXB_MAX_TARGETS, ordering: ["businessSecond", "chain", "contract", "tokenId", "transactionHash", "dedupeKey", "eventId"], releaseEvidence: planSnapshot.releaseEvidence, runtimeGuard: { name: "V2_RUNTIME_GUARD_KEY", mode: "durable_inbox" }, expectedApplyResult: MULTI_REST_TXB_EXPECTED_APPLY_RESULT, orderSuppressionRequiredZero: true, provenance: summary.sourceProvenance });
    await writePreflight(config.outputDir, { snapshot: planSnapshot, runtimeGuardAcquired: true, targetEventIds: [...MULTI_REST_TXB_TARGET_IDS], orderedEventIds: [...MULTI_REST_TXB_ORDERED_IDS] });
    await (dependencies.initializeEvents ?? defaultInitEvents)(config.outputDir);
    summary.eventEvidenceWriteComplete = true;

    for (let sequence = 0; sequence < MULTI_REST_TXB_ORDERED_IDS.length; sequence += 1) {
      const id = MULTI_REST_TXB_ORDERED_IDS[sequence];
      const before = await (dependencies.collectSnapshot ?? collectMultiRestTxbSnapshot)(dependencies.pool, [id]);
      lastSnapshot = before;
      const preErrors = before.targets[id]?.validationErrors ?? ["target_missing"];
      if (preErrors.length > 0) {
        summary.stopEventId = id; summary.stopReason = `per_event_revalidation:${preErrors.join(",")}`; throw new Error(summary.stopReason);
      }
      summary.attemptedEventIds.push(id);
      summary.unattemptedEventIds = MULTI_REST_TXB_ORDERED_IDS.filter((candidate) => !summary.attemptedEventIds.includes(candidate));
      summary.txBCallCount += 1;
      let applicationResult: PendingInboxApplyResult | null = null;
      let after: MultiRestTxbSnapshot | null = null;
      let eventErrors: string[] = [];
      try {
        applicationResult = await (dependencies.applyEvent ?? applyPendingInboxEvent)(dependencies.pool, id, dependencies.now?.() ?? new Date().toISOString());
        after = await (dependencies.collectSnapshot ?? collectMultiRestTxbSnapshot)(dependencies.pool, [id]);
        lastSnapshot = after;
        eventErrors = applicationResult.applyResult === MULTI_REST_TXB_AMBIGUOUS_APPLY_RESULT ? [] : validateMultiRestTxbEventSuccess(before, after, applicationResult, id);
      } catch (error) {
        eventErrors = [`transaction_or_postflight_error:${sanitize(error)}`];
        try { after = await (dependencies.collectSnapshot ?? collectMultiRestTxbSnapshot)(dependencies.pool, [id]); lastSnapshot = after; } catch (postflightError) { eventErrors.push(`postflight_after_error:${sanitize(postflightError)}`); }
      }
      const committed = applicationResult?.outcome === "reconciliation_required" && applicationResult.applyResult === MULTI_REST_TXB_EXPECTED_APPLY_RESULT;
      const evidence: MultiRestTxbEventEvidence = { sequence, eventId: id, identity: EXPECTED[id as "84" | "86"], preClassification: before.targets[id]?.classification?.classification ?? null, preValidation: before.targets[id], txBInvoked: true, applicationResult, committed, postValidation: after?.targets[id] ?? null, deltas: difference(before.counts, after?.counts ?? null), validationErrors: eventErrors, stopReason: eventErrors.length > 0 ? eventErrors.join(",") : null };
      if (committed) {
        summary.committedEventIds.push(id);
        committedEventRecords.set(id, Object.freeze({ ...evidence }));
      }
      try {
        await appendEvent(config.outputDir, evidence);
      } catch (error) {
        summary.eventEvidenceWriteComplete = false;
        summary.stopEventId = id;
        summary.stopReason = `event_evidence_write_failed:${sanitize(error)}`;
        throw new Error(summary.stopReason);
      }
      if (applicationResult?.applyResult === MULTI_REST_TXB_AMBIGUOUS_APPLY_RESULT) { ambiguous = true; summary.stopEventId = id; summary.stopReason = "rest_transfer_ambiguous_same_second_no_state_mutation"; throw new Error(summary.stopReason); }
      if (eventErrors.length > 0) { summary.stopEventId = id; summary.stopReason = eventErrors.join(","); throw new Error(summary.stopReason); }
    }
  } catch (error) {
    summary.errors.push(sanitize(error));
  } finally {
    if (planSnapshot) {
      try {
        lastSnapshot = await (dependencies.collectSnapshot ?? collectMultiRestTxbSnapshot)(dependencies.pool, MULTI_REST_TXB_TARGET_IDS);
        summary.postflightValid = summary.errors.length === 0;
        summary.aggregateDeltaValid = Boolean(lastSnapshot.counts && planSnapshot.counts && lastSnapshot.counts.pending === planSnapshot.counts.pending - summary.committedEventIds.length && lastSnapshot.counts.reconciliationRequired === planSnapshot.counts.reconciliationRequired + summary.committedEventIds.length && lastSnapshot.counts.unfinalized === planSnapshot.counts.unfinalized - summary.committedEventIds.length && lastSnapshot.counts.nftState === planSnapshot.counts.nftState + summary.committedEventIds.length && lastSnapshot.counts.orders === planSnapshot.counts.orders && lastSnapshot.counts.attemptLedger === planSnapshot.counts.attemptLedger);
        await writePostflight(config.outputDir, { snapshot: lastSnapshot, committedEventIds: summary.committedEventIds, attemptedEventIds: summary.attemptedEventIds });
        summary.postflightWriteComplete = true;
      } catch (error) { summary.postflightValid = false; summary.aggregateDeltaValid = false; summary.errors.push(`postflight failed: ${sanitize(error)}`); }
    }
    summary.unattemptedEventIds = MULTI_REST_TXB_ORDERED_IDS.filter((id) => !summary.attemptedEventIds.includes(id));
    if (guard) {
      summary.guardReleaseAttempted = true;
      try {
        await guard.release();
        summary.guardReleaseSucceeded = true;
      } catch (error) {
        summary.guardReleaseError = sanitize(error);
        summary.errors.push(`runtime guard release failed: ${summary.guardReleaseError}`);
      }
    }
    summary.evidenceWriteComplete = summary.eventEvidenceWriteComplete && summary.postflightWriteComplete;
    const candidateBase: MultiRestTxbSummary = { ...summary, summaryWriteComplete: true };
    const candidate: MultiRestTxbSummary = { ...candidateBase, result: resultFor(candidateBase, ambiguous) };
    try {
      await writeSummary(config.outputDir, candidate);
      finalSummary = candidate;
    } catch (error) {
      const failed: MultiRestTxbSummary = { ...candidateBase, evidenceWriteComplete: false, summaryWriteComplete: false, errors: [...candidateBase.errors, `summary write failed: ${sanitize(error)}`], result: "MULTI_REST_TXB_FAILED" };
      failed.result = resultFor(failed, ambiguous);
      finalSummary = failed;
    }
  }
  return finalSummary;
}

export const MULTI_REST_TXB_EXPECTED = EXPECTED;
export const MULTI_REST_TXB_RELEASE_EVIDENCE_COMBINED_SHA256 = combinedReleaseEvidenceSha256([
  { path: "txa_canary_summary.json", sha256: "2fac7c6a226f144e89e5a9e623997d6294fb9e3cbdebacfae10d36784e622b12" },
  { path: "txa_canary_rows.jsonl", sha256: "cadc4bf711e499cd83ed87ae73336b52800e6b05dc74a0475e065c65b6f228a6" },
  { path: "txa_canary_preflight.json", sha256: "c987f9cb32d9ab5c7168989fc1118e1a3c7e1d09dc18ef778079426b40ed5fb6" },
  { path: "txa_canary_postflight.json", sha256: "e2e660b519f863810d251b358582a7dc298cdb5fe4cecbf39947c45f7171f8f5" }
]);
