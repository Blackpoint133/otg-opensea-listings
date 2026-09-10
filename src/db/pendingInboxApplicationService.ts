import { redactString } from "../logger.js";
import { normalizeOrderEvent, normalizeTransferEvent, normalizeUnknownRevalidate } from "../state/normalizers.js";
import type { NormalizedOrderEvent, NormalizedTransferEvent } from "../state/types.js";
import { REST_TRANSFER_AMBIGUOUS_APPLY_RESULT, applyNormalizedEventStateInTransaction } from "./eventApplicationService.js";
import type { DbPool, EventApplicationOutcome, JournalProcessingStatus, PendingInboxApplyResult, TransactionClient } from "./types.js";

const TERMINAL_STATUSES = new Set<JournalProcessingStatus>(["applied", "reconciliation_required", "failed", "ignored_duplicate", "ignored_older"]);

interface InboxJournalRow {
  event_id: string;
  event_type: string;
  dedupe_key: string;
  raw_payload: unknown;
  processing_status: JournalProcessingStatus;
  attempt_count: number;
}

export interface PendingInboxApplyOptions {
  beforeStateApplication?: (row: { eventId: string; eventType: string; dedupeKey: string; attemptCount: number }) => void | Promise<void>;
}

function normalizeStoredRawEvent(rawPayload: unknown, receivedAt: string): NormalizedOrderEvent | NormalizedTransferEvent | null {
  const raw = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  const eventType = (raw as { event_type?: unknown } | null)?.event_type;
  if (eventType === "item_transferred") return normalizeTransferEvent(raw, receivedAt);
  if (eventType === "order_revalidate") return normalizeUnknownRevalidate(raw, receivedAt);
  if (eventType === "item_listed" || eventType === "item_cancelled" || eventType === "item_sold" || eventType === "order_invalidate") return normalizeOrderEvent(raw, receivedAt);
  return null;
}

function processingStatusFrom(outcome: EventApplicationOutcome): JournalProcessingStatus {
  if (outcome === "ignored_older_event") return "ignored_older";
  if (outcome === "journaled_reconciliation_required") return "reconciliation_required";
  if (outcome === "failed") return "failed";
  return "applied";
}

function outcomeFromStatus(status: JournalProcessingStatus): PendingInboxApplyResult["outcome"] {
  if (status === "processing") return "already_processing";
  if (TERMINAL_STATUSES.has(status)) return "already_finalized";
  return "failed";
}

function sanitizeMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return redactString(message).replace(/\b(password|token|secret|api[_-]?key)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>").slice(0, 500);
}

function isStoredRestBackfillTransfer(rawPayload: unknown): boolean {
  const raw = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  return (raw as { event_type?: unknown; payload?: { rest_backfill_source?: { source?: unknown } } } | null)?.event_type === "item_transferred"
    && raw !== null
    && typeof raw === "object"
    && (raw as { payload?: { rest_backfill_source?: { source?: unknown } } }).payload?.rest_backfill_source?.source === "opensea_rest_events_backfill";
}

async function selectInboxEventForUpdate(client: TransactionClient, eventId: string): Promise<InboxJournalRow | null> {
  const result = await client.query<InboxJournalRow>(
    `SELECT event_id::text,
            event_type,
            dedupe_key,
            raw_payload,
            processing_status,
            attempt_count
     FROM public.opensea_listings_events_v2
     WHERE event_id = $1
     FOR UPDATE`,
    [eventId]
  );
  return result.rows[0] ?? null;
}

async function markProcessing(client: TransactionClient, eventId: string, now: string): Promise<InboxJournalRow> {
  const result = await client.query<InboxJournalRow>(
    `UPDATE public.opensea_listings_events_v2
     SET processing_status = 'processing',
         processing_started_at = $2,
         last_attempt_at = $2,
         attempt_count = attempt_count + 1
     WHERE event_id = $1
       AND processing_status = 'pending'
     RETURNING event_id::text,
               event_type,
               dedupe_key,
               raw_payload,
               processing_status,
               attempt_count`,
    [eventId, now]
  );
  const row = result.rows[0];
  if (!row || result.rowCount !== 1) throw new Error(`pending inbox claim expected 1 row, got ${result.rowCount ?? "null"}`);
  return row;
}

async function finalizeInboxEvent(client: TransactionClient, eventId: string, status: JournalProcessingStatus, applyResult: string, appliedAt: string): Promise<void> {
  const result = await client.query(
    `UPDATE public.opensea_listings_events_v2
     SET processing_status = $2,
         processing_started_at = NULL,
         last_attempt_at = $3,
         next_retry_at = NULL,
         last_error_code = NULL,
         last_error_message = NULL,
         apply_result = $4,
         applied_at = $3
     WHERE event_id = $1
       AND processing_status = 'processing'`,
    [eventId, status, appliedAt, applyResult]
  );
  if (result.rowCount !== 1) throw new Error(`pending inbox finalization expected 1 row, got ${result.rowCount ?? "null"}`);
}

async function finalizeInboxFailure(client: TransactionClient, eventId: string, errorCode: string, errorMessage: string, appliedAt: string): Promise<void> {
  const result = await client.query(
    `UPDATE public.opensea_listings_events_v2
     SET processing_status = 'failed',
         processing_started_at = NULL,
         last_attempt_at = $2,
         next_retry_at = NULL,
         last_error_code = $3,
         last_error_message = $4,
         apply_result = $3,
         applied_at = $2
     WHERE event_id = $1
       AND processing_status = 'processing'`,
    [eventId, appliedAt, errorCode, errorMessage]
  );
  if (result.rowCount !== 1) throw new Error(`pending inbox failure finalization expected 1 row, got ${result.rowCount ?? "null"}`);
}

export async function applyPendingInboxEventInTransaction(client: TransactionClient, eventId: string, now: string = new Date().toISOString(), options: PendingInboxApplyOptions = {}): Promise<PendingInboxApplyResult> {
  const current = await selectInboxEventForUpdate(client, eventId);
  if (!current) {
    return { outcome: "not_found", eventId, eventType: null, dedupeKey: null, processingStatus: null, attemptCount: null, applyResult: null };
  }
  if (current.processing_status !== "pending") {
    return {
      outcome: outcomeFromStatus(current.processing_status),
      eventId: current.event_id,
      eventType: current.event_type,
      dedupeKey: current.dedupe_key,
      processingStatus: current.processing_status,
      attemptCount: current.attempt_count,
      applyResult: null
    };
  }

  const claimed = await markProcessing(client, eventId, now);
  await options.beforeStateApplication?.({ eventId: claimed.event_id, eventType: claimed.event_type, dedupeKey: claimed.dedupe_key, attemptCount: claimed.attempt_count });
  let normalized: NormalizedOrderEvent | NormalizedTransferEvent | null;
  try {
    normalized = normalizeStoredRawEvent(claimed.raw_payload, now);
  } catch (error) {
    normalized = null;
  }
  if (!normalized) {
    const errorCode = "normalization_failed";
    const errorMessage = "stored raw event could not be normalized for state application";
    await finalizeInboxFailure(client, eventId, errorCode, errorMessage, now);
    return {
      outcome: "failed",
      eventId: claimed.event_id,
      eventType: claimed.event_type,
      dedupeKey: claimed.dedupe_key,
      processingStatus: "failed",
      attemptCount: claimed.attempt_count,
      applyResult: errorCode,
      errorCode,
      errorMessage
    };
  }

  const applied = await applyNormalizedEventStateInTransaction(client, normalized, now, { currentJournalEventId: claimed.event_id, currentDedupeKey: claimed.dedupe_key });
  const status = processingStatusFrom(applied.outcome);
  await finalizeInboxEvent(client, eventId, status, applied.applyResult, now);
  return {
    outcome: status === "reconciliation_required" ? "reconciliation_required" : status === "ignored_older" ? "ignored_older" : status === "failed" ? "failed" : "applied",
    eventId: claimed.event_id,
    eventType: claimed.event_type,
    dedupeKey: claimed.dedupe_key,
    processingStatus: status,
    attemptCount: claimed.attempt_count,
    applyResult: applied.applyResult
  };
}

export async function finalizeRestTransferAmbiguousNoStateInTransaction(client: TransactionClient, eventId: string, now: string = new Date().toISOString()): Promise<PendingInboxApplyResult> {
  const current = await selectInboxEventForUpdate(client, eventId);
  if (!current) return { outcome: "not_found", eventId, eventType: null, dedupeKey: null, processingStatus: null, attemptCount: null, applyResult: null };
  if (current.processing_status !== "pending") {
    return {
      outcome: outcomeFromStatus(current.processing_status),
      eventId: current.event_id,
      eventType: current.event_type,
      dedupeKey: current.dedupe_key,
      processingStatus: current.processing_status,
      attemptCount: current.attempt_count,
      applyResult: null
    };
  }
  let validRestTransfer = false;
  try {
    validRestTransfer = isStoredRestBackfillTransfer(current.raw_payload);
  } catch {
    validRestTransfer = false;
  }
  const claimed = await markProcessing(client, eventId, now);
  if (!validRestTransfer) {
    await finalizeInboxFailure(client, eventId, "rest_ambiguous_finalization_invalid_source", "stored raw event is not a REST backfill transfer", now);
    return {
      outcome: "failed",
      eventId: claimed.event_id,
      eventType: claimed.event_type,
      dedupeKey: claimed.dedupe_key,
      processingStatus: "failed",
      attemptCount: claimed.attempt_count,
      applyResult: "rest_ambiguous_finalization_invalid_source",
      errorCode: "rest_ambiguous_finalization_invalid_source",
      errorMessage: "stored raw event is not a REST backfill transfer"
    };
  }
  await finalizeInboxEvent(client, eventId, "reconciliation_required", REST_TRANSFER_AMBIGUOUS_APPLY_RESULT, now);
  return {
    outcome: "reconciliation_required",
    eventId: claimed.event_id,
    eventType: claimed.event_type,
    dedupeKey: claimed.dedupe_key,
    processingStatus: "reconciliation_required",
    attemptCount: claimed.attempt_count,
    applyResult: REST_TRANSFER_AMBIGUOUS_APPLY_RESULT
  };
}

export async function applyPendingInboxEvent(pool: DbPool, eventId: string, now: string = new Date().toISOString(), options: PendingInboxApplyOptions = {}): Promise<PendingInboxApplyResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await applyPendingInboxEventInTransaction(client, eventId, now, options);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure for callers.
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sanitizedMessage: sanitizeMessage(error) });
  } finally {
    client.release();
  }
}

export async function finalizeRestTransferAmbiguousNoState(pool: DbPool, eventId: string, now: string = new Date().toISOString()): Promise<PendingInboxApplyResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await finalizeRestTransferAmbiguousNoStateInTransaction(client, eventId, now);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure for callers.
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { sanitizedMessage: sanitizeMessage(error) });
  } finally {
    client.release();
  }
}
