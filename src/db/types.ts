import type { NormalizedOrderEvent, NormalizedTransferEvent, NftState, OrderState } from "../state/types.js";

export interface QueryResult<Row = unknown> {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

export interface TransactionClient extends Queryable {
  release(): void;
}

export interface DbPool {
  connect(): Promise<TransactionClient>;
  query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  end(): Promise<void>;
}

export type NormalizedEventForApplication = NormalizedOrderEvent | NormalizedTransferEvent;

export type EventApplicationOutcome =
  | "applied"
  | "duplicate_ignored"
  | "ignored_older_event"
  | "journaled_reconciliation_required"
  | "journaled_state_not_persisted"
  | "failed";

export interface EventApplicationResult {
  dedupeKey: string;
  eventType: string;
  orderHash: string | null;
  nftId: string | null;
  result: EventApplicationOutcome;
  applyResult: string;
  reconciliationRequired: boolean;
  stateChanged: boolean;
  journalEventId: string | null;
}

export interface JournalInsertInput {
  eventType: string;
  eventTimestamp: string | null;
  eventVersion: string | null;
  orderHash: string | null;
  nftId: string | null;
  chain: string | null;
  contractAddress: string | null;
  tokenId: string | null;
  transactionHash: string | null;
  receivedAt: string;
  payloadHash: string;
  dedupeKey: string;
  rawPayload: unknown;
}

export interface JournalInsertResult {
  inserted: boolean;
  eventId: string | null;
}

export type JournalProcessingStatus =
  | "pending"
  | "processing"
  | "applied"
  | "reconciliation_required"
  | "failed"
  | "ignored_duplicate"
  | "ignored_older";

export type DurableInboxPersistOutcome = "inserted_pending" | "duplicate_existing";

export interface DurableInboxPersistResult {
  outcome: DurableInboxPersistOutcome;
  eventId: string;
  dedupeKey: string;
  eventType: string;
  orderHash: string | null;
  nftId: string | null;
  processingStatus: JournalProcessingStatus;
  attemptCount: number;
}

export type PendingInboxApplyOutcome =
  | "applied"
  | "reconciliation_required"
  | "ignored_older"
  | "failed"
  | "already_finalized"
  | "already_processing"
  | "not_found";

export interface PendingInboxApplyResult {
  outcome: PendingInboxApplyOutcome;
  eventId: string;
  eventType: string | null;
  dedupeKey: string | null;
  processingStatus: JournalProcessingStatus | null;
  attemptCount: number | null;
  applyResult: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface InboxRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export type InboxRetryClassificationKind = "retryable" | "non_retryable";

export interface InboxRetryClassification {
  kind: InboxRetryClassificationKind;
  code: string;
  message: string;
}

export type InboxRetryRecordOutcome =
  | "retry_scheduled"
  | "retry_exhausted"
  | "non_retryable_failed"
  | "duplicate_attempt_record"
  | "already_finalized"
  | "not_eligible"
  | "not_found";

export interface InboxRetryRecordResult {
  outcome: InboxRetryRecordOutcome;
  eventId: string;
  processingStatus: JournalProcessingStatus | null;
  attemptCount: number | null;
  nextRetryAt: string | null;
  errorCode: string | null;
  attemptId?: string;
}

export interface InboxStaleRecoveryResult {
  recovered: number;
}

export interface DurableInboxMetrics {
  pendingTotal: number;
  pendingDue: number;
  pendingScheduled: number;
  processingTotal: number;
  staleProcessing: number;
  failedTotal: number;
  reconciliationRequiredTotal: number;
  appliedTotal: number;
  ignoredOlderTotal: number;
  oldestPendingReceivedAt: string | null;
  oldestDueAgeMs: number | null;
  maxAttemptCount: number;
}

export interface DurableInboxStartupRecoveryResult {
  staleProcessingRecovered: number;
  metrics: DurableInboxMetrics;
}

export interface ActiveOrderSelector {
  chain: string;
  contractAddress: string;
  tokenId: string;
}

export type { OrderState, NftState };
