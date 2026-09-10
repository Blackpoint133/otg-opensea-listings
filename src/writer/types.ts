import type { DbPool, EventApplicationResult, NormalizedEventForApplication } from "../db/types.js";

export type WriterOutcome =
  | EventApplicationResult["result"]
  | "ignored_unsupported_type"
  | "normalization_failed"
  | "failed";

export interface WriterResult {
  eventType: string;
  dedupeKey: string | null;
  result: WriterOutcome;
  applyResult: string | null;
  orderHash: string | null;
  nftId: string | null;
  stateChanged: boolean;
  reconciliationRequired: boolean;
  journalEventId: string | null;
  durationMs: number;
  errorMessage?: string;
}

export interface WriterMetricsSnapshot {
  events_received: number;
  events_applied: number;
  duplicates: number;
  reconciliation_required: number;
  unsupported: number;
  normalization_failed: number;
  errors: number;
}

export interface EventApplicator {
  (pool: DbPool, event: NormalizedEventForApplication, now?: string): Promise<EventApplicationResult>;
}
