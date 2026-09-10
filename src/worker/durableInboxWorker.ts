import { randomUUID } from "node:crypto";
import { applyPendingInboxEvent } from "../db/pendingInboxApplicationService.js";
import {
  DEFAULT_INBOX_RETRY_POLICY,
  getDurableInboxMetrics,
  recordInboxRetryAfterFailure,
  recoverStaleProcessingRows,
  selectNextDuePendingInboxEvent
} from "../db/inboxRetryRepository.js";
import type { DbPool, DurableInboxMetrics, DurableInboxStartupRecoveryResult, InboxRetryPolicy, PendingInboxApplyResult } from "../db/types.js";

export type DurableInboxWorkerOnceOutcome = "idle" | "processed" | "retry_scheduled" | "retry_exhausted" | "non_retryable_failed" | "retry_recording_skipped";

export interface DurableInboxWorkerOnceOptions {
  retryPolicy?: InboxRetryPolicy;
  random?: () => number;
  createAttemptId?: () => string;
  applyEvent?: typeof applyPendingInboxEvent;
  recordRetry?: typeof recordInboxRetryAfterFailure;
}

export interface DurableInboxWorkerOnceResult {
  outcome: DurableInboxWorkerOnceOutcome;
  eventId: string | null;
  applyResult: PendingInboxApplyResult | null;
  retryResult: Awaited<ReturnType<typeof recordInboxRetryAfterFailure>> | null;
}

export interface DurableInboxStartupRecoveryOptions {
  staleAfterMs?: number;
  limit?: number;
}

export async function runDurableInboxWorkerOnce(
  pool: DbPool,
  now: string = new Date().toISOString(),
  options: DurableInboxWorkerOnceOptions = {}
): Promise<DurableInboxWorkerOnceResult> {
  const due = await selectNextDuePendingInboxEvent(pool, now, 1);
  const eventId = due[0] ?? null;
  if (!eventId) return { outcome: "idle", eventId: null, applyResult: null, retryResult: null };

  const applyEvent = options.applyEvent ?? applyPendingInboxEvent;
  const recordRetry = options.recordRetry ?? recordInboxRetryAfterFailure;
  const attemptId = (options.createAttemptId ?? randomUUID)();
  try {
    const applyResult = await applyEvent(pool, eventId, now);
    return { outcome: "processed", eventId, applyResult, retryResult: null };
  } catch (error) {
    const retryResult = await recordRetry(pool, eventId, attemptId, error, now, options.retryPolicy ?? DEFAULT_INBOX_RETRY_POLICY, options.random);
    const outcome =
      retryResult.outcome === "retry_scheduled" || retryResult.outcome === "retry_exhausted" || retryResult.outcome === "non_retryable_failed"
        ? retryResult.outcome
        : "retry_recording_skipped";
    return { outcome, eventId, applyResult: null, retryResult };
  }
}

export async function prepareDurableInboxOnStartup(
  pool: DbPool,
  now: string = new Date().toISOString(),
  options: DurableInboxStartupRecoveryOptions = {}
): Promise<DurableInboxStartupRecoveryResult> {
  const stale = await recoverStaleProcessingRows(pool, now, options.staleAfterMs ?? 900_000, options.limit ?? 100);
  const metrics = await getDurableInboxMetrics(pool, now, options.staleAfterMs ?? 900_000);
  return { staleProcessingRecovered: stale.recovered, metrics };
}

export type { DurableInboxMetrics };
