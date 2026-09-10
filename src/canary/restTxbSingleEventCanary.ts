import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { redactString } from "../logger.js";
import { applyPendingInboxEvent } from "../db/pendingInboxApplicationService.js";
import type { DbPool, PendingInboxApplyResult } from "../db/types.js";
import {
  classifyRestTransferWindowEvents,
  isWindowStateReleaseEligible,
  loadRestTransferWindowJournalCandidates,
  protectedBoundarySecondsForWindow,
  type RestTransferWindowClassification,
  type TransferJournalCandidate
} from "../backfill/restTransferWindowBarrier.js";
import { normalizeBusinessSecond, normalizeTransferEvent } from "../state/normalizers.js";

export const REST_TXB_SINGLE_EVENT_EXPECTED_DATABASE = "server_otg";
export const REST_TXB_SINGLE_EVENT_ID = "82";
export const REST_TXB_SINGLE_EVENT_RELEASE_SCOPE = { after: 1786618485, before: 1786618545 } as const;
export const REST_TXB_SINGLE_EVENT_RELEASE_EVIDENCE_DIR = "C:\\VAMBAM\\Projects\\OTG\\DEV\\2026-08-15_opensea_v2_full_window_rest_txa_release_admission_evidence";
export const REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT = "inserted_nft_transfer;suppressed_orders=0";
export const REST_TXB_SINGLE_EVENT_AMBIGUOUS_APPLY_RESULT = "rest_transfer_ambiguous_same_second_no_state_mutation";
export const REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS = [
  "--confirm-server-otg-txb-write",
  "--confirm-single-event",
  "--confirm-event-82",
  "--confirm-state-mutation",
  "--confirm-no-generic-worker",
  "--confirm-no-rest",
  "--confirm-no-txa",
  "--confirm-one-shot"
] as const;

const EXPECTED = {
  eventId: REST_TXB_SINGLE_EVENT_ID,
  eventType: "item_transferred",
  eventTimestamp: "2026-08-13T10:55:43.000Z",
  eventVersion: null as string | null,
  chain: "gunzilla",
  contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271",
  tokenId: "48804197",
  transactionHash: "0x9053e97f6a088b4ac9027a6b8b0477b92ae5abeac88c9ba35a7f03531f74d165",
  dedupeKey: "transfer:v1:15a038366ca7eaca924aab2e6db5fc2271d506c8b4fa86c5b3e682977b0bba29",
  restSource: "opensea_rest_events_backfill",
  transferType: "mint",
  canonicalFrom: "0x0000000000000000000000000000000000000000",
  canonicalTo: "0xc0c259b390e5e1cd1bbac021c195fb4aa1d56082",
  nftId: "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/48804197"
} as const;

const REQUIRED_SOURCE_PROVENANCE_FILES = [
  "src/canary/restTxbSingleEventCanary.ts",
  "src/canary/runRestTxbSingleEventCanary.ts",
  "src/db/pendingInboxApplicationService.ts",
  "src/db/eventApplicationService.ts",
  "src/backfill/restTransferWindowBarrier.ts",
  "src/db/inboxRetryRepository.ts",
  "src/db/nftStateRepository.ts",
  "src/db/listingRepository.ts",
  "src/state/nftReducer.ts",
  "src/state/orderReducer.ts",
  "src/state/normalizers.ts",
  "src/state/eventIdentity.ts",
  "package.json"
] as const;

const REQUIRED_RUNTIME_PROVENANCE_FILES = [
  "dist/canary/restTxbSingleEventCanary.js",
  "dist/canary/runRestTxbSingleEventCanary.js"
] as const;

export interface RestTxbReleaseEvidenceFileExpectation {
  name: string;
  sha256: string;
}

const REQUIRED_RELEASE_EVIDENCE_FILES: readonly RestTxbReleaseEvidenceFileExpectation[] = [
  { name: "txa_canary_summary.json", sha256: "2fac7c6a226f144e89e5a9e623997d6294fb9e3cbdebacfae10d36784e622b12" },
  { name: "txa_canary_rows.jsonl", sha256: "cadc4bf711e499cd83ed87ae73336b52800e6b05dc74a0475e065c65b6f228a6" },
  { name: "txa_canary_preflight.json", sha256: "c987f9cb32d9ab5c7168989fc1118e1a3c7e1d09dc18ef778079426b40ed5fb6" },
  { name: "txa_canary_postflight.json", sha256: "e2e660b519f863810d251b358582a7dc298cdb5fe4cecbf39947c45f7171f8f5" }
] as const;

export type RestTxbSingleEventResult =
  | "REST_TXB_SINGLE_EVENT_COMPLETE"
  | "REST_TXB_SINGLE_EVENT_SAFE_NO_STATE_AMBIGUOUS"
  | "REST_TXB_SINGLE_EVENT_ABORTED_PREFLIGHT"
  | "REST_TXB_SINGLE_EVENT_PARTIAL"
  | "REST_TXB_SINGLE_EVENT_FAILED";

export interface RestTxbSingleEventConfig {
  eventId: typeof REST_TXB_SINGLE_EVENT_ID;
  outputDir: string;
  confirmations: Record<(typeof REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS)[number], true>;
}

export interface RestTxbFileProvenance {
  path: string;
  sha256: string;
}

export interface RestTxbProvenance {
  packageVersion: string;
  nodeVersion: string;
  sourceFiles: RestTxbFileProvenance[];
  sourceCombinedSha256: string;
  runtimeFiles: RestTxbFileProvenance[];
  runtimeCombinedSha256: string;
}

export interface RestTxbReleaseEvidence {
  window: typeof REST_TXB_SINGLE_EVENT_RELEASE_SCOPE;
  queryEventTypes: readonly string[];
  files: RestTxbFileProvenance[];
  combinedSha256: string;
  transportComplete: boolean;
  semanticCoverageComplete: boolean;
  txAAdmissionComplete: boolean;
  candidateCoverageComplete: boolean;
  releaseEligible: boolean;
  event82Classification: RestTransferWindowClassification | null;
}

export interface RestTxbSnapshotCounts {
  database: string;
  journal: number;
  pending: number;
  processing: number;
  failed: number;
  reconciliationRequired: number;
  unfinalized: number;
  attemptLedger: number;
  nftState: number;
  orders: number;
}

export interface RestTxbEventRow {
  eventId: string;
  eventType: string | null;
  eventTimestamp: string | null;
  eventVersion: string | null;
  chain: string | null;
  contractAddress: string | null;
  tokenId: string | null;
  transactionHash: string | null;
  dedupeKey: string | null;
  rawPayload: unknown;
  processingStatus: string | null;
  attemptCount: number | null;
  nextRetryAt: string | null;
  applyResult: string | null;
  appliedAt: string | null;
  processingStartedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  restSource: string | null;
  rawTransferType: string | null;
  canonicalFrom: string | null;
  canonicalTo: string | null;
}

export interface RestTxbNftRow {
  chain: string;
  contractAddress: string;
  tokenId: string;
  nftId: string;
  collectionSlug: string;
  currentOwnerAddress: string | null;
  lastTransferFromAddress: string | null;
  lastTransferToAddress: string | null;
  lastTransferTransactionHash: string | null;
  lastTransferAt: string | null;
  lastNftEventTimestamp: string | null;
  lastNftEventVersion: string | null;
}

export interface RestTxbEvidenceSnapshot {
  counts: RestTxbSnapshotCounts | null;
  event82: RestTxbEventRow | null;
  attemptRowsForEvent82: unknown[];
  targetNftState: RestTxbNftRow | null;
  targetActiveOrders: unknown[];
  dedupeRows: { eventId: string; processingStatus: string | null; dedupeKey: string | null }[];
  sameSecondCandidates: TransferJournalCandidate[];
  classifier: {
    releaseScope: typeof REST_TXB_SINGLE_EVENT_RELEASE_SCOPE;
    protectedBoundarySeconds: readonly string[];
    classification: RestTransferWindowClassification | null;
    reason: string | null;
    releaseEligible: boolean;
    candidateCoverageComplete: boolean;
  };
  releaseEvidence: RestTxbReleaseEvidence | null;
  validationErrors: string[];
}

export interface RestTxbSingleEventSummary {
  result: RestTxbSingleEventResult;
  eventId: string;
  gatesValid: boolean;
  databaseTargetValid: boolean;
  schemaPreflightValid: boolean;
  provenanceComplete: boolean;
  identityPreflightValid: boolean;
  lifecyclePreflightValid: boolean;
  dedupeUnique: boolean;
  sameSecondConflictFree: boolean;
  classifierSafe: boolean;
  boundaryReleaseProven: boolean;
  nftStatePreflightValid: boolean;
  orderPreflightValid: boolean;
  txBInvoked: boolean;
  txBCallCount: number;
  txBEventId: string | null;
  applicationResult: PendingInboxApplyResult | null;
  postflightValid: boolean;
  eventFinalStateValid: boolean;
  nftStateDeltaValid: boolean;
  orderDeltaValid: boolean;
  attemptDeltaValid: boolean;
  evidenceWriteComplete: boolean;
  sourceProvenance: RestTxbProvenance | null;
  releaseEvidence: RestTxbReleaseEvidence | null;
  errors: string[];
}

export interface RestTxbSingleEventDependencies {
  pool: DbPool;
  applyEvent?: (pool: DbPool, eventId: string, now: string) => Promise<PendingInboxApplyResult>;
  now?: () => string;
  writeEvidence?: (outputDir: string, files: Record<string, unknown>) => Promise<void>;
  computeProvenance?: () => RestTxbProvenance;
  verifyReleaseEvidence?: (candidateCoverageComplete: boolean, event82Classification: RestTransferWindowClassification | null) => RestTxbReleaseEvidence;
}

function sanitize(value: unknown): string {
  return redactString(value instanceof Error ? value.message : String(value))
    .replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD|authorization|x-api-key|password|token|secret)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>")
    .slice(0, 500);
}

function projectRoot(): string {
  return path.resolve(import.meta.dirname, "..", "..");
}

function normalizedRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function fileSha256(rootDir: string, relativePath: string): RestTxbFileProvenance {
  const normalized = normalizedRelativePath(relativePath);
  const bytes = fs.readFileSync(path.join(rootDir, normalized));
  return { path: normalized, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function combinedRestTxbProvenanceSha256(files: readonly RestTxbFileProvenance[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.sha256, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

export function combinedReleaseEvidenceSha256(files: readonly RestTxbFileProvenance[]): string {
  return combinedRestTxbProvenanceSha256(files);
}

export function computeRestTxbSingleEventProvenance(rootDir = projectRoot(), nodeVersion = process.version): RestTxbProvenance {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: unknown };
  const sourceFiles = REQUIRED_SOURCE_PROVENANCE_FILES.map((file) => fileSha256(rootDir, file));
  const runtimeFiles = REQUIRED_RUNTIME_PROVENANCE_FILES.map((file) => fileSha256(rootDir, file));
  return {
    packageVersion: typeof packageJson.version === "string" ? packageJson.version : "",
    nodeVersion,
    sourceFiles,
    sourceCombinedSha256: combinedRestTxbProvenanceSha256(sourceFiles),
    runtimeFiles,
    runtimeCombinedSha256: combinedRestTxbProvenanceSha256(runtimeFiles)
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

export function loadRestTxbSingleEventConfig(argv: string[]): RestTxbSingleEventConfig {
  const flags = new Set<string>();
  let eventId: string | null = null;
  let outputDir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS as readonly string[]).includes(arg)) {
      flags.add(arg);
    } else if (arg === "--event-id") {
      eventId = argv[++i] ?? null;
      if (!eventId) throw new Error("--event-id requires a value");
      if (eventId !== REST_TXB_SINGLE_EVENT_ID) throw new Error("REST Tx B single-event canary is hard-pinned to event_id 82");
    } else if (arg === "--output-dir") {
      outputDir = argv[++i] ?? null;
      if (!outputDir) throw new Error("--output-dir requires a value");
    } else {
      throw new Error(`Unknown REST Tx B single-event canary argument: ${arg}`);
    }
  }
  for (const required of REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS) {
    if (!flags.has(required)) throw new Error(`missing required confirmation ${required}`);
  }
  if (eventId === null) throw new Error("--event-id is required");
  if (outputDir === null) throw new Error("--output-dir is required");
  validateOutputDir(outputDir);
  return {
    eventId: REST_TXB_SINGLE_EVENT_ID,
    outputDir,
    confirmations: Object.fromEntries(REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS.map((flag) => [flag, true])) as RestTxbSingleEventConfig["confirmations"]
  };
}

function intValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function canonicalizePgTimestamptzForClassifier(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const pgTimestamptz = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/;
  const match = pgTimestamptz.exec(trimmed);
  if (match) {
    const offsetMinutes = match[4] ?? "00";
    const parsedPg = Date.parse(`${match[1]}T${match[2]}${match[3]}:${offsetMinutes}`);
    return Number.isFinite(parsedPg) ? new Date(parsedPg).toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function canonicalizeCandidateTimestamp(candidate: TransferJournalCandidate): TransferJournalCandidate {
  const canonical = canonicalizePgTimestamptzForClassifier(candidate.eventTimestamp);
  return { ...candidate, eventTimestamp: canonical ?? candidate.eventTimestamp };
}

function rawPayloadObject(rawPayload: unknown): any {
  return typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
}

function mapEventRow(row: any): RestTxbEventRow {
  const raw = rawPayloadObject(row.raw_payload);
  const normalized = normalizeTransferEvent(raw, row.received_at ?? new Date(0).toISOString());
  return {
    eventId: String(row.event_id),
    eventType: row.event_type ?? null,
    eventTimestamp: canonicalizePgTimestamptzForClassifier(row.event_timestamp ?? null),
    eventVersion: row.event_version === null || row.event_version === undefined ? null : String(row.event_version),
    chain: row.chain ?? null,
    contractAddress: row.contract_address ?? null,
    tokenId: row.token_id === null || row.token_id === undefined ? null : String(row.token_id),
    transactionHash: row.transaction_hash ?? null,
    dedupeKey: row.dedupe_key ?? null,
    rawPayload: raw,
    processingStatus: row.processing_status ?? null,
    attemptCount: row.attempt_count === null || row.attempt_count === undefined ? null : intValue(row.attempt_count),
    nextRetryAt: row.next_retry_at ?? null,
    applyResult: row.apply_result ?? null,
    appliedAt: row.applied_at ?? null,
    processingStartedAt: row.processing_started_at ?? null,
    lastErrorCode: row.last_error_code ?? null,
    lastErrorMessage: row.last_error_message ?? null,
    restSource: raw?.payload?.rest_backfill_source?.source ?? null,
    rawTransferType: raw?.payload?.rest_backfill_source?.transfer_type ?? null,
    canonicalFrom: normalized?.from ?? null,
    canonicalTo: normalized?.to ?? null
  };
}

function fileHashForReleaseEvidence(evidenceDir: string, name: string): RestTxbFileProvenance {
  const bytes = fs.readFileSync(path.join(evidenceDir, name));
  return { path: name, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readJsonEvidence(evidenceDir: string, name: string): any {
  return JSON.parse(fs.readFileSync(path.join(evidenceDir, name), "utf8"));
}

export function verifyRestTxbReleaseEvidence(
  candidateCoverageComplete: boolean,
  event82Classification: RestTransferWindowClassification | null,
  evidenceDir = REST_TXB_SINGLE_EVENT_RELEASE_EVIDENCE_DIR
): RestTxbReleaseEvidence {
  return verifyRestTxbReleaseEvidenceFiles(
    candidateCoverageComplete,
    event82Classification,
    evidenceDir,
    REQUIRED_RELEASE_EVIDENCE_FILES
  );
}

export function verifyRestTxbReleaseEvidenceFiles(
  candidateCoverageComplete: boolean,
  event82Classification: RestTransferWindowClassification | null,
  evidenceDir: string,
  requiredFiles: readonly RestTxbReleaseEvidenceFileExpectation[]
): RestTxbReleaseEvidence {
  const requiredNames = REQUIRED_RELEASE_EVIDENCE_FILES.map((file) => file.name).sort();
  const suppliedNames = requiredFiles.map((file) => file.name).sort();
  if (JSON.stringify(suppliedNames) !== JSON.stringify(requiredNames)) throw new Error("release evidence file manifest mismatch");
  const files = requiredFiles.map((expected) => {
    const actual = fileHashForReleaseEvidence(evidenceDir, expected.name);
    if (actual.sha256 !== expected.sha256) throw new Error(`release evidence hash mismatch: ${expected.name}`);
    return actual;
  });
  const summary = readJsonEvidence(evidenceDir, "txa_canary_summary.json");
  const preflight = readJsonEvidence(evidenceDir, "txa_canary_preflight.json");
  const rows = fs.readFileSync(path.join(evidenceDir, "txa_canary_rows.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const insertedRows = rows.filter((row) => row.outcome === "inserted_pending");
  const duplicateRows = rows.filter((row) => row.outcome === "duplicate_existing");
  const expectedSource = preflight?.sourceProvenance;
  if (JSON.stringify(summary?.sourceProvenance) !== JSON.stringify(expectedSource)) throw new Error("release evidence provenance mismatch");
  if (summary?.window?.after !== REST_TXB_SINGLE_EVENT_RELEASE_SCOPE.after || summary?.window?.before !== REST_TXB_SINGLE_EVENT_RELEASE_SCOPE.before) throw new Error("release evidence window mismatch");
  if (JSON.stringify(summary?.queryEventTypes) !== JSON.stringify(["transfer"])) throw new Error("release evidence query mismatch");
  if (summary?.result !== "REST_TXA_ONLY_CANARY_COMPLETE") throw new Error("release evidence result mismatch");
  if (summary?.transportComplete !== true) throw new Error("release transport incomplete");
  if (summary?.semanticCoverageComplete !== true) throw new Error("release semantic incomplete");
  if (summary?.txAAdmissionComplete !== true) throw new Error("release Tx A admission incomplete");
  if (summary?.eventsObserved !== 42 || summary?.eventsAdapted !== 42 || summary?.eventsMalformed !== 0 || summary?.eventsUnsupported !== 0) throw new Error("release event count mismatch");
  if (summary?.txAInserted !== 16 || summary?.txADuplicates !== 26 || summary?.txAErrors !== 0) throw new Error("release Tx A count mismatch");
  if (summary.txAInserted + summary.txADuplicates !== summary.eventsObserved) throw new Error("release Tx A accounting mismatch");
  if (!Array.isArray(summary?.insertedEventIds) || summary.insertedEventIds.length !== 16) throw new Error("release inserted ids mismatch");
  if (!Array.isArray(summary?.duplicateEventIds) || summary.duplicateEventIds.length !== 26) throw new Error("release duplicate ids mismatch");
  if (rows.length !== 42 || insertedRows.length !== 16 || duplicateRows.length !== 26) throw new Error("release row evidence accounting mismatch");
  if (summary?.txBInvoked !== false || summary?.nftStateTouched !== false || summary?.activeOrdersTouched !== false || summary?.streamConnected !== false) throw new Error("release action flag mismatch");
  if (summary?.evidenceWriteComplete !== true) throw new Error("release evidence write incomplete");
  return {
    window: REST_TXB_SINGLE_EVENT_RELEASE_SCOPE,
    queryEventTypes: ["transfer"],
    files,
    combinedSha256: combinedReleaseEvidenceSha256(files),
    transportComplete: summary.transportComplete,
    semanticCoverageComplete: summary.semanticCoverageComplete,
    txAAdmissionComplete: summary.txAAdmissionComplete,
    candidateCoverageComplete,
    releaseEligible: isWindowStateReleaseEligible({
      transportComplete: summary.transportComplete,
      semanticCoverageComplete: summary.semanticCoverageComplete,
      txAAdmissionComplete: summary.txAAdmissionComplete,
      candidateCoverageComplete
    }),
    event82Classification
  };
}

function mapNftRow(row: any): RestTxbNftRow {
  return {
    chain: row.chain,
    contractAddress: row.contract_address,
    tokenId: String(row.token_id),
    nftId: row.nft_id,
    collectionSlug: row.collection_slug,
    currentOwnerAddress: row.current_owner_address,
    lastTransferFromAddress: row.last_transfer_from_address,
    lastTransferToAddress: row.last_transfer_to_address,
    lastTransferTransactionHash: row.last_transfer_transaction_hash,
    lastTransferAt: canonicalizePgTimestamptzForClassifier(row.last_transfer_at ?? null),
    lastNftEventTimestamp: canonicalizePgTimestamptzForClassifier(row.last_nft_event_timestamp ?? null),
    lastNftEventVersion: row.last_nft_event_version === null || row.last_nft_event_version === undefined ? null : String(row.last_nft_event_version)
  };
}

export async function collectRestTxbSingleEventCounts(pool: DbPool): Promise<RestTxbSnapshotCounts> {
  const database = (await pool.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database ?? "";
  const counts = (await pool.query<any>(
    `SELECT
       (SELECT COUNT(*) FROM public.opensea_listings_events_v2) AS journal,
       COUNT(*) FILTER (WHERE processing_status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE processing_status = 'processing') AS processing,
       COUNT(*) FILTER (WHERE processing_status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE processing_status = 'reconciliation_required') AS reconciliation_required,
       COUNT(*) FILTER (WHERE processing_status IN ('pending','processing','failed')) AS unfinalized,
       (SELECT COUNT(*) FROM public.opensea_listings_events_v2_attempts) AS attempt_ledger,
       (SELECT COUNT(*) FROM public.opensea_listings_nft_state_v2) AS nft_state,
       (SELECT COUNT(*) FROM public.opensea_listings_v2) AS orders
     FROM public.opensea_listings_events_v2`
  )).rows[0];
  return {
    database,
    journal: intValue(counts?.journal),
    pending: intValue(counts?.pending),
    processing: intValue(counts?.processing),
    failed: intValue(counts?.failed),
    reconciliationRequired: intValue(counts?.reconciliation_required),
    unfinalized: intValue(counts?.unfinalized),
    attemptLedger: intValue(counts?.attempt_ledger),
    nftState: intValue(counts?.nft_state),
    orders: intValue(counts?.orders)
  };
}

export async function verifyRestTxbSingleEventSchema(pool: DbPool): Promise<boolean> {
  const result = await pool.query<{ ok: boolean }>(
    `SELECT
       to_regclass('public.opensea_listings_events_v2') IS NOT NULL
       AND to_regclass('public.opensea_listings_events_v2_attempts') IS NOT NULL
       AND to_regclass('public.opensea_listings_nft_state_v2') IS NOT NULL
       AND to_regclass('public.opensea_listings_v2') IS NOT NULL AS ok`
  );
  return result.rows[0]?.ok === true;
}

export async function collectRestTxbSingleEventSnapshot(
  pool: DbPool,
  releaseEvidenceVerifier: (candidateCoverageComplete: boolean, event82Classification: RestTransferWindowClassification | null) => RestTxbReleaseEvidence = verifyRestTxbReleaseEvidence
): Promise<RestTxbEvidenceSnapshot> {
  const counts = await collectRestTxbSingleEventCounts(pool);
  const eventResult = await pool.query<any>(
    `SELECT event_id::text,
            event_type,
            event_timestamp::text,
            event_version::text,
            chain,
            contract_address,
            token_id,
            transaction_hash,
            received_at::text,
            dedupe_key,
            raw_payload,
            processing_status,
            attempt_count,
            next_retry_at::text,
            apply_result,
            applied_at::text,
            processing_started_at::text,
            last_error_code,
            last_error_message
     FROM public.opensea_listings_events_v2
     WHERE event_id::text = $1`,
    [REST_TXB_SINGLE_EVENT_ID]
  );
  const event82 = eventResult.rows[0] ? mapEventRow(eventResult.rows[0]) : null;
  const attempts = await pool.query<unknown>(
    `SELECT event_id::text, attempt_id::text, recorded_at::text
     FROM public.opensea_listings_events_v2_attempts
     WHERE event_id::text = $1
     ORDER BY recorded_at ASC, attempt_id ASC`,
    [REST_TXB_SINGLE_EVENT_ID]
  );
  const nft = await pool.query<any>(
    `SELECT chain,
            contract_address,
            token_id,
            nft_id,
            collection_slug,
            current_owner_address,
            last_transfer_from_address,
            last_transfer_to_address,
            last_transfer_transaction_hash,
            last_transfer_at::text,
            last_nft_event_timestamp::text,
            last_nft_event_version::text
     FROM public.opensea_listings_nft_state_v2
     WHERE chain = $1 AND contract_address = $2 AND token_id = $3`,
    [EXPECTED.chain, EXPECTED.contractAddress, EXPECTED.tokenId]
  );
  const orders = await pool.query<unknown>(
    `SELECT order_hash, status, is_active
     FROM public.opensea_listings_v2
     WHERE chain = $1 AND contract_address = $2 AND token_id = $3 AND status = 'active' AND is_active = true
     ORDER BY order_hash ASC`,
    [EXPECTED.chain, EXPECTED.contractAddress, EXPECTED.tokenId]
  );
  const dedupe = await pool.query<{ event_id: string; processing_status: string | null; dedupe_key: string | null }>(
    `SELECT event_id::text, processing_status, dedupe_key
     FROM public.opensea_listings_events_v2
     WHERE dedupe_key = $1
     ORDER BY event_id ASC`,
    [EXPECTED.dedupeKey]
  );
  const sameSecondCandidates = (await loadRestTransferWindowJournalCandidates(pool, {
    after: Math.floor(Date.parse(EXPECTED.eventTimestamp) / 1000),
    before: Math.floor(Date.parse(EXPECTED.eventTimestamp) / 1000) + 1
  })).map(canonicalizeCandidateTimestamp);
  const releaseCandidates = (await loadRestTransferWindowJournalCandidates(pool, REST_TXB_SINGLE_EVENT_RELEASE_SCOPE)).map(canonicalizeCandidateTimestamp);
  const candidateCoverageComplete = releaseCandidates.every((candidate) => candidate.eventType !== "item_transferred"
    || (candidate.chain && candidate.contractAddress && candidate.tokenId && candidate.transactionHash && candidate.dedupeKey && normalizeBusinessSecond(candidate.eventTimestamp)));
  const classified = classifyRestTransferWindowEvents(releaseCandidates, [REST_TXB_SINGLE_EVENT_ID], {
    protectedBoundarySeconds: protectedBoundarySecondsForWindow(REST_TXB_SINGLE_EVENT_RELEASE_SCOPE),
    candidateCoverageComplete
  });
  const targetClassification = classified.find((item) => item.eventId === REST_TXB_SINGLE_EVENT_ID);
  const releaseEvidence = releaseEvidenceVerifier(candidateCoverageComplete, targetClassification?.classification ?? null);
  return {
    counts,
    event82,
    attemptRowsForEvent82: attempts.rows,
    targetNftState: nft.rows[0] ? mapNftRow(nft.rows[0]) : null,
    targetActiveOrders: orders.rows,
    dedupeRows: dedupe.rows.map((row) => ({ eventId: String(row.event_id), processingStatus: row.processing_status, dedupeKey: row.dedupe_key })),
    sameSecondCandidates,
    classifier: {
      releaseScope: REST_TXB_SINGLE_EVENT_RELEASE_SCOPE,
      protectedBoundarySeconds: protectedBoundarySecondsForWindow(REST_TXB_SINGLE_EVENT_RELEASE_SCOPE),
      classification: targetClassification?.classification ?? null,
      reason: targetClassification?.reason ?? null,
      releaseEligible: releaseEvidence.releaseEligible,
      candidateCoverageComplete: Boolean(candidateCoverageComplete)
    },
    releaseEvidence,
    validationErrors: []
  };
}

function validatePreflight(snapshot: RestTxbEvidenceSnapshot): string[] {
  const errors: string[] = [];
  const event = snapshot.event82;
  if (!event) return ["event_82_missing"];
  if (event.eventId !== EXPECTED.eventId) errors.push("event_id_mismatch");
  if (event.eventType !== EXPECTED.eventType) errors.push("event_type_mismatch");
  if (event.eventTimestamp !== EXPECTED.eventTimestamp) errors.push("event_timestamp_mismatch");
  if (event.eventVersion !== EXPECTED.eventVersion) errors.push("event_version_mismatch");
  if (event.chain !== EXPECTED.chain) errors.push("chain_mismatch");
  if (event.contractAddress !== EXPECTED.contractAddress) errors.push("contract_mismatch");
  if (event.tokenId !== EXPECTED.tokenId) errors.push("token_mismatch");
  if (event.transactionHash !== EXPECTED.transactionHash) errors.push("transaction_mismatch");
  if (event.dedupeKey !== EXPECTED.dedupeKey) errors.push("dedupe_mismatch");
  if (event.restSource !== EXPECTED.restSource) errors.push("rest_source_mismatch");
  if (event.rawTransferType !== EXPECTED.transferType) errors.push("raw_transfer_type_mismatch");
  if (event.canonicalFrom !== EXPECTED.canonicalFrom) errors.push("canonical_from_mismatch");
  if (event.canonicalTo !== EXPECTED.canonicalTo) errors.push("canonical_to_mismatch");
  if (event.processingStatus !== "pending") errors.push("processing_status_not_pending");
  if (event.attemptCount !== 0) errors.push("attempt_count_not_zero");
  if (event.nextRetryAt !== null) errors.push("next_retry_at_not_null");
  if (event.applyResult !== null) errors.push("apply_result_not_null");
  if (event.appliedAt !== null) errors.push("applied_at_not_null");
  if (snapshot.dedupeRows.length !== 1 || snapshot.dedupeRows[0]?.eventId !== EXPECTED.eventId) errors.push("dedupe_not_unique_to_event_82");
  const conflicting = snapshot.sameSecondCandidates.filter((candidate) => candidate.eventId !== EXPECTED.eventId
    && candidate.chain?.toLowerCase() === EXPECTED.chain
    && candidate.contractAddress?.toLowerCase() === EXPECTED.contractAddress
    && candidate.tokenId === EXPECTED.tokenId
    && normalizeBusinessSecond(candidate.eventTimestamp) === EXPECTED.eventTimestamp
    && (candidate.transactionHash?.toLowerCase() !== EXPECTED.transactionHash || candidate.dedupeKey !== EXPECTED.dedupeKey));
  if (conflicting.length > 0) errors.push("same_second_distinct_transfer_conflict");
  if (!snapshot.releaseEvidence || !snapshot.releaseEvidence.releaseEligible || !snapshot.classifier.releaseEligible || !snapshot.classifier.candidateCoverageComplete || snapshot.classifier.classification !== "SAFE") errors.push("classifier_not_safe");
  if (snapshot.classifier.protectedBoundarySeconds.includes(EXPECTED.eventTimestamp)) errors.push("event_82_in_protected_boundary");
  if (snapshot.targetNftState !== null) errors.push("target_nft_state_exists");
  if (snapshot.targetActiveOrders.length !== 0) errors.push("target_active_orders_exist");
  return errors;
}

function validateSafePostflight(before: RestTxbEvidenceSnapshot, after: RestTxbEvidenceSnapshot, applied: PendingInboxApplyResult | null): string[] {
  const errors: string[] = [];
  const event = after.event82;
  const nft = after.targetNftState;
  if (applied?.outcome !== "reconciliation_required") errors.push("application_outcome_unexpected");
  if (applied?.processingStatus !== "reconciliation_required") errors.push("application_processing_status_unexpected");
  if (applied?.attemptCount !== 1) errors.push("application_attempt_count_unexpected");
  if (applied?.applyResult !== REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT) errors.push("application_result_unexpected");
  if (!event) errors.push("event_82_missing_after");
  if (event && event.processingStatus !== "reconciliation_required") errors.push("event_final_status_unexpected");
  if (event && event.attemptCount !== 1) errors.push("event_attempt_count_unexpected");
  if (event && event.applyResult !== REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT) errors.push("event_apply_result_unexpected");
  if (event && event.appliedAt === null) errors.push("event_applied_at_missing");
  if (event && event.processingStartedAt !== null) errors.push("event_processing_started_not_cleared");
  if (event && event.nextRetryAt !== null) errors.push("event_next_retry_not_cleared");
  if (!nft) errors.push("target_nft_state_missing");
  if (nft && nft.nftId !== EXPECTED.nftId) errors.push("nft_id_unexpected");
  if (nft && nft.currentOwnerAddress !== EXPECTED.canonicalTo) errors.push("nft_owner_unexpected");
  if (nft && nft.lastTransferFromAddress !== EXPECTED.canonicalFrom) errors.push("nft_last_from_unexpected");
  if (nft && nft.lastTransferToAddress !== EXPECTED.canonicalTo) errors.push("nft_last_to_unexpected");
  if (nft && nft.lastTransferTransactionHash !== EXPECTED.transactionHash) errors.push("nft_last_tx_unexpected");
  if (nft && nft.lastTransferAt !== EXPECTED.eventTimestamp) errors.push("nft_last_transfer_at_unexpected");
  if (nft && nft.lastNftEventTimestamp !== EXPECTED.eventTimestamp) errors.push("nft_last_event_timestamp_unexpected");
  if (nft && nft.lastNftEventVersion !== null) errors.push("nft_last_event_version_unexpected");
  if (after.targetActiveOrders.length !== 0) errors.push("target_orders_changed");
  if (before.counts && after.counts) {
    if (after.counts.journal !== before.counts.journal) errors.push("journal_delta_unexpected");
    if (after.counts.pending !== before.counts.pending - 1) errors.push("pending_delta_unexpected");
    if (after.counts.processing !== before.counts.processing) errors.push("processing_delta_unexpected");
    if (after.counts.reconciliationRequired !== before.counts.reconciliationRequired + 1) errors.push("reconciliation_delta_unexpected");
    if (after.counts.unfinalized !== before.counts.unfinalized - 1) errors.push("unfinalized_delta_unexpected");
    if (after.counts.nftState !== before.counts.nftState + 1) errors.push("nft_state_delta_unexpected");
    if (after.counts.orders !== before.counts.orders) errors.push("orders_delta_unexpected");
    if (after.counts.attemptLedger !== before.counts.attemptLedger) errors.push("attempt_ledger_delta_unexpected");
  }
  if (after.attemptRowsForEvent82.length !== before.attemptRowsForEvent82.length) errors.push("event_attempt_rows_delta_unexpected");
  return errors;
}

function finalResult(summary: RestTxbSingleEventSummary): RestTxbSingleEventResult {
  if (!summary.gatesValid || !summary.provenanceComplete || !summary.databaseTargetValid || !summary.schemaPreflightValid) return "REST_TXB_SINGLE_EVENT_FAILED";
  if (!summary.identityPreflightValid || !summary.lifecyclePreflightValid || !summary.dedupeUnique || !summary.sameSecondConflictFree || !summary.classifierSafe || !summary.boundaryReleaseProven || !summary.nftStatePreflightValid || !summary.orderPreflightValid) return "REST_TXB_SINGLE_EVENT_ABORTED_PREFLIGHT";
  if (summary.applicationResult?.applyResult === REST_TXB_SINGLE_EVENT_AMBIGUOUS_APPLY_RESULT) return "REST_TXB_SINGLE_EVENT_SAFE_NO_STATE_AMBIGUOUS";
  if (summary.txBInvoked && summary.postflightValid && summary.eventFinalStateValid && summary.nftStateDeltaValid && summary.orderDeltaValid && summary.attemptDeltaValid && summary.evidenceWriteComplete) return "REST_TXB_SINGLE_EVENT_COMPLETE";
  return summary.txBInvoked ? "REST_TXB_SINGLE_EVENT_PARTIAL" : "REST_TXB_SINGLE_EVENT_FAILED";
}

function emptySummary(config: RestTxbSingleEventConfig): RestTxbSingleEventSummary {
  return {
    result: "REST_TXB_SINGLE_EVENT_FAILED",
    eventId: config.eventId,
    gatesValid: true,
    databaseTargetValid: false,
    schemaPreflightValid: false,
    provenanceComplete: false,
    identityPreflightValid: false,
    lifecyclePreflightValid: false,
    dedupeUnique: false,
    sameSecondConflictFree: false,
    classifierSafe: false,
    boundaryReleaseProven: false,
    nftStatePreflightValid: false,
    orderPreflightValid: false,
    txBInvoked: false,
    txBCallCount: 0,
    txBEventId: null,
    applicationResult: null,
    postflightValid: false,
    eventFinalStateValid: false,
    nftStateDeltaValid: false,
    orderDeltaValid: false,
    attemptDeltaValid: false,
    evidenceWriteComplete: false,
    sourceProvenance: null,
    releaseEvidence: null,
    errors: []
  };
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

export async function writeRestTxbSingleEventEvidence(outputDir: string, files: Record<string, unknown>): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    writeJsonAtomic(path.join(outputDir, name), value);
  }
}

export async function runRestTxbSingleEventCanary(config: RestTxbSingleEventConfig, dependencies: RestTxbSingleEventDependencies): Promise<RestTxbSingleEventSummary> {
  const summary = emptySummary(config);
  let preflight: RestTxbEvidenceSnapshot | null = null;
  let postflight: RestTxbEvidenceSnapshot | null = null;
  try {
    summary.sourceProvenance = (dependencies.computeProvenance ?? computeRestTxbSingleEventProvenance)();
    summary.provenanceComplete = true;
    preflight = await collectRestTxbSingleEventSnapshot(dependencies.pool, dependencies.verifyReleaseEvidence);
    summary.releaseEvidence = preflight.releaseEvidence;
    summary.databaseTargetValid = preflight.counts?.database === REST_TXB_SINGLE_EVENT_EXPECTED_DATABASE;
    if (!summary.databaseTargetValid) throw new Error(`expected database ${REST_TXB_SINGLE_EVENT_EXPECTED_DATABASE}, got ${preflight.counts?.database ?? "unknown"}`);
    summary.schemaPreflightValid = await verifyRestTxbSingleEventSchema(dependencies.pool);
    if (!summary.schemaPreflightValid) throw new Error("required V2 tables are missing");
    const preflightErrors = validatePreflight(preflight);
    preflight.validationErrors.push(...preflightErrors);
    summary.identityPreflightValid = !preflightErrors.some((error) => error.endsWith("_mismatch") || error === "event_82_missing");
    summary.lifecyclePreflightValid = !preflightErrors.some((error) => error === "processing_status_not_pending" || error === "attempt_count_not_zero" || error === "next_retry_at_not_null" || error === "apply_result_not_null" || error === "applied_at_not_null");
    summary.dedupeUnique = !preflightErrors.includes("dedupe_not_unique_to_event_82");
    summary.sameSecondConflictFree = !preflightErrors.includes("same_second_distinct_transfer_conflict");
    summary.classifierSafe = !preflightErrors.includes("classifier_not_safe");
    summary.boundaryReleaseProven = !preflightErrors.includes("event_82_in_protected_boundary") && summary.classifierSafe;
    summary.nftStatePreflightValid = !preflightErrors.includes("target_nft_state_exists");
    summary.orderPreflightValid = !preflightErrors.includes("target_active_orders_exist");
    if (preflightErrors.length > 0) throw new Error(`preflight aborted: ${preflightErrors.join(",")}`);

    summary.txBInvoked = true;
    summary.txBCallCount = 1;
    summary.txBEventId = REST_TXB_SINGLE_EVENT_ID;
    summary.applicationResult = await (dependencies.applyEvent ?? applyPendingInboxEvent)(dependencies.pool, REST_TXB_SINGLE_EVENT_ID, dependencies.now?.() ?? new Date().toISOString());
  } catch (error) {
    summary.errors.push(sanitize(error));
  } finally {
    try {
      postflight = await collectRestTxbSingleEventSnapshot(dependencies.pool, dependencies.verifyReleaseEvidence);
      if (preflight && summary.applicationResult?.applyResult === REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT) {
        const errors = validateSafePostflight(preflight, postflight, summary.applicationResult);
        postflight.validationErrors.push(...errors);
        summary.postflightValid = errors.length === 0;
        summary.eventFinalStateValid = !errors.some((error) => error.startsWith("event_") || error.startsWith("application_"));
        summary.nftStateDeltaValid = !errors.some((error) => error.startsWith("nft_") || error === "nft_state_delta_unexpected");
        summary.orderDeltaValid = !errors.some((error) => error === "target_orders_changed" || error === "orders_delta_unexpected");
        summary.attemptDeltaValid = !errors.some((error) => error === "attempt_ledger_delta_unexpected" || error === "event_attempt_rows_delta_unexpected");
        if (errors.length > 0) summary.errors.push(`postflight validation failed: ${errors.join(",")}`);
      } else if (summary.applicationResult?.applyResult === REST_TXB_SINGLE_EVENT_AMBIGUOUS_APPLY_RESULT) {
        summary.postflightValid = true;
      }
    } catch (error) {
      summary.errors.push(`postflight failed: ${sanitize(error)}`);
    }
    summary.result = finalResult(summary);
    try {
      const finalSummary = { ...summary, evidenceWriteComplete: true } satisfies RestTxbSingleEventSummary;
      finalSummary.result = finalResult(finalSummary);
      const files = {
        "txb_canary_preflight.json": { snapshot: preflight, sourceProvenance: summary.sourceProvenance },
        "txb_canary_postflight.json": postflight,
        "txb_canary_event82.json": { before: preflight, after: postflight, applicationResult: summary.applicationResult },
        "txb_canary_summary.json": finalSummary
      };
      await (dependencies.writeEvidence ?? writeRestTxbSingleEventEvidence)(config.outputDir, files);
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

export const REST_TXB_SINGLE_EVENT_EXPECTED = EXPECTED;
