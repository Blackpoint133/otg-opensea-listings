import { redactString } from "../logger.js";
import type {
  DbPool,
  DurableInboxMetrics,
  InboxRetryClassification,
  InboxRetryPolicy,
  InboxRetryRecordResult,
  InboxStaleRecoveryResult,
  JournalProcessingStatus,
  Queryable,
  TransactionClient
} from "./types.js";

export const DEFAULT_INBOX_RETRY_POLICY: InboxRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 5_000,
  maxDelayMs: 300_000,
  jitterRatio: 0.2
};

const TERMINAL_STATUSES = new Set<JournalProcessingStatus>(["applied", "reconciliation_required", "failed", "ignored_duplicate", "ignored_older"]);
const TRANSIENT_PG_CODES = new Set(["40001", "40P01", "55P03"]);
const TRANSIENT_NODE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "ENOTFOUND"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RetryRow {
  event_id: string;
  processing_status: JournalProcessingStatus;
  attempt_count: number;
}

interface MetricsRow {
  pending_total: string | number;
  pending_due: string | number;
  pending_scheduled: string | number;
  processing_total: string | number;
  stale_processing: string | number;
  failed_total: string | number;
  reconciliation_required_total: string | number;
  applied_total: string | number;
  ignored_older_total: string | number;
  oldest_pending_received_at: string | null;
  oldest_due_received_at: string | null;
  max_attempt_count: string | number | null;
}

function prop(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>)[name] : undefined;
}

function sanitizeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactString(raw).replace(/\b(password|token|secret|api[_-]?key)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>");
  return redacted.slice(0, 500);
}

function sanitizeCode(value: unknown): string {
  const text = typeof value === "string" && value.length > 0 ? value : "unknown_error";
  return text.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

function isPgConnectionException(code: string): boolean {
  return code.startsWith("08");
}

export function classifyInboxApplicationError(error: unknown): InboxRetryClassification {
  const explicitNonRetryable = prop(error, "nonRetryable") === true;
  const code = sanitizeCode(prop(error, "code") ?? prop(error, "errno") ?? prop(error, "name") ?? (error instanceof Error ? error.name : null));
  if (explicitNonRetryable) return { kind: "non_retryable", code, message: sanitizeMessage(error) };
  if (isPgConnectionException(code) || TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code)) {
    return { kind: "retryable", code, message: sanitizeMessage(error) };
  }
  return { kind: "retryable", code, message: sanitizeMessage(error) };
}

export function validateInboxRetryPolicy(policy: InboxRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new Error("retry policy maxAttempts must be a positive safe integer");
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) throw new Error("retry policy baseDelayMs must be a non-negative finite number");
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) throw new Error("retry policy maxDelayMs must be >= baseDelayMs");
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) throw new Error("retry policy jitterRatio must be between 0 and 1");
}

export function calculateNextRetryAt(now: string, attemptCount: number, policy: InboxRetryPolicy = DEFAULT_INBOX_RETRY_POLICY, random: () => number = Math.random): string {
  validateInboxRetryPolicy(policy);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) throw new Error("attemptCount must be a positive safe integer");
  const parsedNow = Date.parse(now);
  if (!Number.isFinite(parsedNow)) throw new Error("now must be a valid ISO timestamp");
  const exponent = Math.min(attemptCount - 1, 30);
  const exponential = policy.baseDelayMs * 2 ** exponent;
  const capped = Math.min(exponential, policy.maxDelayMs);
  const rawRandom = random();
  if (!Number.isFinite(rawRandom) || rawRandom < 0 || rawRandom > 1) throw new Error("retry jitter random source must return 0..1");
  const jitter = capped * policy.jitterRatio * rawRandom;
  const delay = Math.min(capped + jitter, policy.maxDelayMs);
  const next = parsedNow + delay;
  if (!Number.isFinite(next) || next > 8_640_000_000_000_000) throw new Error("next retry timestamp overflow");
  return new Date(next).toISOString();
}

async function selectRetryRowForUpdate(client: TransactionClient, eventId: string): Promise<RetryRow | null> {
  const result = await client.query<RetryRow>(
    `SELECT event_id::text, processing_status, attempt_count
     FROM public.opensea_listings_events_v2
     WHERE event_id = $1
     FOR UPDATE`,
    [eventId]
  );
  return result.rows[0] ?? null;
}

function retryResult(outcome: InboxRetryRecordResult["outcome"], row: RetryRow | null, eventId: string, nextRetryAt: string | null, errorCode: string | null, attemptId?: string): InboxRetryRecordResult {
  return {
    outcome,
    eventId: row?.event_id ?? eventId,
    processingStatus: row?.processing_status ?? null,
    attemptCount: row?.attempt_count ?? null,
    nextRetryAt,
    errorCode,
    attemptId
  };
}

export function validateInboxAttemptId(attemptId: string): void {
  if (!UUID_PATTERN.test(attemptId)) throw new Error("attemptId must be a canonical UUID");
}

async function attemptAlreadyRecorded(client: TransactionClient, eventId: string, attemptId: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM public.opensea_listings_events_v2_attempts
       WHERE event_id = $1
         AND attempt_id = $2::uuid
     ) AS exists`,
    [eventId, attemptId]
  );
  return Boolean(result.rows[0]?.exists);
}

async function insertAttemptRecord(client: TransactionClient, eventId: string, attemptId: string, now: string): Promise<boolean> {
  const result = await client.query<{ attempt_id: string }>(
    `INSERT INTO public.opensea_listings_events_v2_attempts (
       event_id,
       attempt_id,
       recorded_at
     ) VALUES (
       $1,
       $2::uuid,
       $3
     )
     ON CONFLICT (event_id, attempt_id) DO NOTHING
     RETURNING attempt_id::text`,
    [eventId, attemptId, now]
  );
  return result.rowCount === 1 && Boolean(result.rows[0]);
}

export async function recordInboxRetryAfterFailureInTransaction(
  client: TransactionClient,
  eventId: string,
  attemptId: string,
  error: unknown,
  now: string,
  policy: InboxRetryPolicy = DEFAULT_INBOX_RETRY_POLICY,
  random: () => number = Math.random
): Promise<InboxRetryRecordResult> {
  validateInboxRetryPolicy(policy);
  validateInboxAttemptId(attemptId);
  const row = await selectRetryRowForUpdate(client, eventId);
  if (!row) return retryResult("not_found", null, eventId, null, null, attemptId);
  if (await attemptAlreadyRecorded(client, row.event_id, attemptId)) return retryResult("duplicate_attempt_record", row, eventId, null, null, attemptId);
  if (TERMINAL_STATUSES.has(row.processing_status)) return retryResult("already_finalized", row, eventId, null, null, attemptId);
  if (row.processing_status !== "pending") return retryResult("not_eligible", row, eventId, null, null, attemptId);
  if (!(await insertAttemptRecord(client, row.event_id, attemptId, now))) return retryResult("duplicate_attempt_record", row, eventId, null, null, attemptId);

  const classification = classifyInboxApplicationError(error);
  const nextAttemptCount = row.attempt_count + 1;
  const exhausted = nextAttemptCount >= policy.maxAttempts;
  if (classification.kind === "non_retryable" || exhausted) {
    const applyResult = classification.kind === "non_retryable" ? "non_retryable_failure" : "retry_exhausted";
    const errorCode = classification.kind === "non_retryable" ? classification.code : "retry_exhausted";
    const result = await client.query<RetryRow>(
      `UPDATE public.opensea_listings_events_v2
       SET processing_status = 'failed',
           attempt_count = $2,
           processing_started_at = NULL,
           last_attempt_at = $3,
           next_retry_at = NULL,
           last_error_code = $4,
           last_error_message = $5,
           apply_result = $6,
           applied_at = $3
       WHERE event_id = $1
         AND processing_status = 'pending'
       RETURNING event_id::text, processing_status, attempt_count`,
      [row.event_id, nextAttemptCount, now, errorCode, classification.message, applyResult]
    );
    if (result.rowCount !== 1 || !result.rows[0]) throw new Error(`retry failure finalization expected 1 row, got ${result.rowCount ?? "null"}`);
    return retryResult(classification.kind === "non_retryable" ? "non_retryable_failed" : "retry_exhausted", result.rows[0], eventId, null, errorCode, attemptId);
  }

  const nextRetryAt = calculateNextRetryAt(now, nextAttemptCount, policy, random);
  const result = await client.query<RetryRow>(
    `UPDATE public.opensea_listings_events_v2
     SET processing_status = 'pending',
         attempt_count = $2,
         processing_started_at = NULL,
         last_attempt_at = $3,
         next_retry_at = $4,
         last_error_code = $5,
         last_error_message = $6,
         apply_result = NULL,
         applied_at = NULL
     WHERE event_id = $1
       AND processing_status = 'pending'
     RETURNING event_id::text, processing_status, attempt_count`,
    [row.event_id, nextAttemptCount, now, nextRetryAt, classification.code, classification.message]
  );
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error(`retry scheduling expected 1 row, got ${result.rowCount ?? "null"}`);
  return retryResult("retry_scheduled", result.rows[0], eventId, nextRetryAt, classification.code, attemptId);
}

export async function recordInboxRetryAfterFailure(
  pool: DbPool,
  eventId: string,
  attemptId: string,
  error: unknown,
  now: string = new Date().toISOString(),
  policy: InboxRetryPolicy = DEFAULT_INBOX_RETRY_POLICY,
  random: () => number = Math.random
): Promise<InboxRetryRecordResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await recordInboxRetryAfterFailureInTransaction(client, eventId, attemptId, error, now, policy, random);
    await client.query("COMMIT");
    return result;
  } catch (recordError) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original retry-recording failure.
    }
    throw recordError;
  } finally {
    client.release();
  }
}

export async function selectNextDuePendingInboxEvent(client: Queryable, now: string, limit = 1): Promise<string[]> {
  const result = await client.query<{ event_id: string }>(
    `SELECT event_id::text
     FROM public.opensea_listings_events_v2
     WHERE processing_status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= $1)
       AND COALESCE(raw_payload->'payload'->'rest_backfill_source'->>'source', '') <> 'opensea_rest_events_backfill'
     ORDER BY received_at ASC, event_id ASC
     LIMIT $2`,
    [now, limit]
  );
  return result.rows.map((row) => row.event_id);
}

export async function recoverStaleProcessingRowsInTransaction(client: TransactionClient, now: string, staleAfterMs: number, limit: number): Promise<InboxStaleRecoveryResult> {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error("staleAfterMs must be a non-negative finite number");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("stale recovery limit must be a positive safe integer");
  const threshold = new Date(Date.parse(now) - staleAfterMs).toISOString();
  const result = await client.query(
    `WITH selected AS (
       SELECT event_id
       FROM public.opensea_listings_events_v2
       WHERE processing_status = 'processing'
         AND processing_started_at IS NOT NULL
         AND processing_started_at <= $1
       ORDER BY processing_started_at ASC, event_id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     UPDATE public.opensea_listings_events_v2 events
     SET processing_status = 'pending',
         processing_started_at = NULL,
         next_retry_at = NULL,
         last_error_code = 'stale_processing_recovered',
         last_error_message = 'stale processing row recovered to pending'
     FROM selected
     WHERE events.event_id = selected.event_id`,
    [threshold, limit]
  );
  return { recovered: result.rowCount ?? 0 };
}

export async function recoverStaleProcessingRows(pool: DbPool, now: string = new Date().toISOString(), staleAfterMs = 900_000, limit = 100): Promise<InboxStaleRecoveryResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await recoverStaleProcessingRowsInTransaction(client, now, staleAfterMs, limit);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function intValue(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

export async function getDurableInboxMetrics(pool: DbPool, now: string = new Date().toISOString(), staleAfterMs = 900_000): Promise<DurableInboxMetrics> {
  const threshold = new Date(Date.parse(now) - staleAfterMs).toISOString();
  const result = await pool.query<MetricsRow>(
    `SELECT
       COUNT(*) FILTER (WHERE processing_status = 'pending') AS pending_total,
       COUNT(*) FILTER (WHERE processing_status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)) AS pending_due,
       COUNT(*) FILTER (WHERE processing_status = 'pending' AND next_retry_at > $1) AS pending_scheduled,
       COUNT(*) FILTER (WHERE processing_status = 'processing') AS processing_total,
       COUNT(*) FILTER (WHERE processing_status = 'processing' AND processing_started_at IS NOT NULL AND processing_started_at <= $2) AS stale_processing,
       COUNT(*) FILTER (WHERE processing_status = 'failed') AS failed_total,
       COUNT(*) FILTER (WHERE processing_status = 'reconciliation_required') AS reconciliation_required_total,
       COUNT(*) FILTER (WHERE processing_status = 'applied') AS applied_total,
       COUNT(*) FILTER (WHERE processing_status = 'ignored_older') AS ignored_older_total,
       MIN(received_at) FILTER (WHERE processing_status = 'pending')::text AS oldest_pending_received_at,
       MIN(received_at) FILTER (WHERE processing_status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1))::text AS oldest_due_received_at,
       COALESCE(MAX(attempt_count), 0) AS max_attempt_count
     FROM public.opensea_listings_events_v2`,
    [now, threshold]
  );
  const row = result.rows[0];
  const oldestDue = row?.oldest_due_received_at ? Date.parse(row.oldest_due_received_at) : NaN;
  const parsedNow = Date.parse(now);
  return {
    pendingTotal: intValue(row?.pending_total),
    pendingDue: intValue(row?.pending_due),
    pendingScheduled: intValue(row?.pending_scheduled),
    processingTotal: intValue(row?.processing_total),
    staleProcessing: intValue(row?.stale_processing),
    failedTotal: intValue(row?.failed_total),
    reconciliationRequiredTotal: intValue(row?.reconciliation_required_total),
    appliedTotal: intValue(row?.applied_total),
    ignoredOlderTotal: intValue(row?.ignored_older_total),
    oldestPendingReceivedAt: row?.oldest_pending_received_at ?? null,
    oldestDueAgeMs: Number.isFinite(oldestDue) && Number.isFinite(parsedNow) ? Math.max(0, parsedNow - oldestDue) : null,
    maxAttemptCount: intValue(row?.max_attempt_count)
  };
}
