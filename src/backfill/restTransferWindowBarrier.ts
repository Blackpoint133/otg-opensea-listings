import type { DurableInboxPersistResult, PendingInboxApplyResult } from "../db/types.js";
import type { Queryable } from "../db/types.js";
import { normalizeBusinessSecond } from "../state/normalizers.js";
import { PRODUCTION_REST_TRANSFER_EVENT_TYPES, validateBackfillWindow } from "./restEventsBackfill.js";
import { sanitizeBackfillError, validateRestBackfillPolicy } from "./restEventsClient.js";
import { adaptRestEventToDurableIngress } from "./restEventAdapter.js";
import type { PersistBackfillEvent, RestBackfillPolicy, RestBackfillWindow, RestEventsPage } from "./types.js";

export type RestTransferWindowClassification = "SAFE" | "AMBIGUOUS" | "DEFERRED_BOUNDARY" | "DUPLICATE_EXISTING" | "NOT_ADMITTED" | "UNCERTAIN";

export interface TransferJournalCandidate {
  eventId: string;
  eventType: string;
  eventTimestamp: string | null;
  eventVersion: string | null;
  chain: string | null;
  contractAddress: string | null;
  tokenId: string | null;
  transactionHash: string | null;
  dedupeKey: string;
  processingStatus?: string | null;
  rawPayload?: unknown;
}

export interface ClassifiedTransferWindowEvent {
  eventId: string;
  dedupeKey: string;
  classification: RestTransferWindowClassification;
  reason: string;
}

export interface RestTransferWindowSummary {
  result: "REST_TRANSFER_WINDOW_COMPLETE" | "REST_TRANSFER_WINDOW_PARTIAL" | "REST_TRANSFER_WINDOW_FAILED";
  window: RestBackfillWindow;
  transportComplete: boolean;
  semanticCoverageComplete: boolean;
  txAAdmissionComplete: boolean;
  candidateCoverageComplete: boolean;
  pagesFetched: number;
  eventsObserved: number;
  eventsAdapted: number;
  eventsMalformed: number;
  eventsUnsupported: number;
  txAInserted: number;
  txADuplicates: number;
  txAErrors: number;
  safeCount: number;
  ambiguousCount: number;
  deferredBoundaryCount: number;
  uncertainCount: number;
  duplicateExistingCount: number;
  crossSourceConflictCount: number;
  txBProcessed: number;
  txBReconciliationNoState: number;
  txBErrors: number;
  classified: ClassifiedTransferWindowEvent[];
  errors: string[];
}

export interface RestTransferWindowDependencies {
  client: { fetchCollectionEventsPage(input: { after: number; before: number; limit?: number; cursor?: string | null; eventTypes?: readonly string[] }): Promise<RestEventsPage> };
  persistEvent: PersistBackfillEvent;
  journal: Queryable;
  applyEventById(eventId: string): Promise<PendingInboxApplyResult>;
  finalizeAmbiguousEventById(eventId: string): Promise<PendingInboxApplyResult>;
  now?: () => string;
}

export interface RunRestTransferWindowInput {
  window: RestBackfillWindow;
  policy?: Partial<RestBackfillPolicy>;
  deferBoundaryTimestamp?: string | null;
}

let restTransferWindowInFlight = false;

function isRestBackfillCandidate(candidate: TransferJournalCandidate): boolean {
  return (candidate.rawPayload as { payload?: { rest_backfill_source?: { source?: unknown } } } | null)?.payload?.rest_backfill_source?.source === "opensea_rest_events_backfill";
}

function groupKey(candidate: TransferJournalCandidate): string | null {
  const businessSecond = normalizeBusinessSecond(candidate.eventTimestamp);
  if (!candidate.chain || !candidate.contractAddress || !candidate.tokenId || !businessSecond) return null;
  return `${candidate.chain.toLowerCase()}\n${candidate.contractAddress.toLowerCase()}\n${candidate.tokenId}\n${businessSecond}`;
}

function sameTransactionKey(candidate: TransferJournalCandidate): string | null {
  return candidate.transactionHash ? `${candidate.transactionHash.toLowerCase()}\n${candidate.dedupeKey}` : null;
}

function addClassified(map: Map<string, ClassifiedTransferWindowEvent>, eventId: string, dedupeKey: string, classification: RestTransferWindowClassification, reason: string): void {
  map.set(eventId, { eventId, dedupeKey, classification, reason });
}

function utcSecondStart(unixSecond: number): string {
  return new Date(unixSecond * 1000).toISOString();
}

export function protectedBoundarySecondsForWindow(window: RestBackfillWindow): readonly string[] {
  const seconds = new Set<string>();
  if (window.before > 0) seconds.add(utcSecondStart(window.before - 1));
  seconds.add(utcSecondStart(window.before));
  return [...seconds].sort();
}

function hasIncompleteCandidate(candidates: readonly TransferJournalCandidate[]): boolean {
  return candidates.some((candidate) => candidate.eventType === "item_transferred"
    && (!candidate.chain || !candidate.contractAddress || !candidate.tokenId || !candidate.dedupeKey || !candidate.transactionHash || !normalizeBusinessSecond(candidate.eventTimestamp)));
}

export function isWindowStateReleaseEligible(summary: Pick<RestTransferWindowSummary, "transportComplete" | "semanticCoverageComplete" | "txAAdmissionComplete" | "candidateCoverageComplete">): boolean {
  return summary.transportComplete && summary.semanticCoverageComplete && summary.txAAdmissionComplete && summary.candidateCoverageComplete;
}

export async function loadRestTransferWindowJournalCandidates(client: Queryable, window: RestBackfillWindow): Promise<TransferJournalCandidate[]> {
  const start = utcSecondStart(Math.max(0, window.after - 1));
  const end = utcSecondStart(window.before + 1);
  const result = await client.query<{
    event_id: string;
    event_type: string;
    event_timestamp: string | null;
    event_version: string | null;
    chain: string | null;
    contract_address: string | null;
    token_id: string | null;
    transaction_hash: string | null;
    dedupe_key: string;
    processing_status: string | null;
    raw_payload: unknown;
  }>(
    `SELECT event_id::text,
            event_type,
            event_timestamp::text,
            event_version::text,
            chain,
            contract_address,
            token_id,
            transaction_hash,
            dedupe_key,
            processing_status,
            raw_payload
     FROM public.opensea_listings_events_v2
     WHERE event_type = 'item_transferred'
       AND event_timestamp >= $1::timestamptz
       AND event_timestamp < $2::timestamptz
     ORDER BY event_timestamp ASC, event_id ASC`,
    [start, end]
  );
  return result.rows.map((row) => ({
    eventId: row.event_id,
    eventType: row.event_type,
    eventTimestamp: row.event_timestamp,
    eventVersion: row.event_version,
    chain: row.chain,
    contractAddress: row.contract_address,
    tokenId: row.token_id,
    transactionHash: row.transaction_hash,
    dedupeKey: row.dedupe_key,
    processingStatus: row.processing_status,
    rawPayload: row.raw_payload
  }));
}

export function classifyRestTransferWindowEvents(
  candidates: readonly TransferJournalCandidate[],
  targetEventIds: readonly string[],
  options: { protectedBoundarySeconds?: readonly string[]; candidateCoverageComplete?: boolean } = {}
): ClassifiedTransferWindowEvent[] {
  const targetSet = new Set(targetEventIds);
  const protectedBoundarySet = new Set(options.protectedBoundarySeconds ?? []);
  const groups = new Map<string, TransferJournalCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.eventType !== "item_transferred") continue;
    const key = groupKey(candidate);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const out = new Map<string, ClassifiedTransferWindowEvent>();
  for (const candidate of candidates) {
    if (!targetSet.has(candidate.eventId)) continue;
    if (!isRestBackfillCandidate(candidate)) continue;
    if (candidate.processingStatus && candidate.processingStatus !== "pending") {
      addClassified(out, candidate.eventId, candidate.dedupeKey, "DUPLICATE_EXISTING", "existing_non_pending_lifecycle");
      continue;
    }
    const businessSecond = normalizeBusinessSecond(candidate.eventTimestamp);
    if (businessSecond && protectedBoundarySet.has(businessSecond)) {
      addClassified(out, candidate.eventId, candidate.dedupeKey, "DEFERRED_BOUNDARY", "trailing_boundary_second_deferred");
      continue;
    }
    if (options.candidateCoverageComplete === false) {
      addClassified(out, candidate.eventId, candidate.dedupeKey, "UNCERTAIN", "candidate_coverage_incomplete");
      continue;
    }
    const key = groupKey(candidate);
    const ownTx = sameTransactionKey(candidate);
    if (!key || !ownTx) {
      addClassified(out, candidate.eventId, candidate.dedupeKey, "NOT_ADMITTED", "missing_structured_transfer_identity");
      continue;
    }
    const group = groups.get(key) ?? [];
    const distinctTransactions = new Set(group.map(sameTransactionKey).filter((value): value is string => value !== null));
    const incompleteInGroup = group.some((item) => sameTransactionKey(item) === null);
    addClassified(
      out,
      candidate.eventId,
      candidate.dedupeKey,
      incompleteInGroup ? "UNCERTAIN" : distinctTransactions.size > 1 ? "AMBIGUOUS" : "SAFE",
      incompleteInGroup ? "incomplete_same_second_transfer_candidate" : distinctTransactions.size > 1 ? "same_nft_same_second_distinct_transaction" : "no_same_second_distinct_transaction"
    );
  }
  return [...out.values()];
}

function emptySummary(window: RestBackfillWindow): RestTransferWindowSummary {
  return {
    result: "REST_TRANSFER_WINDOW_FAILED",
    window,
    transportComplete: false,
    semanticCoverageComplete: true,
    txAAdmissionComplete: true,
    candidateCoverageComplete: true,
    pagesFetched: 0,
    eventsObserved: 0,
    eventsAdapted: 0,
    eventsMalformed: 0,
    eventsUnsupported: 0,
    txAInserted: 0,
    txADuplicates: 0,
    txAErrors: 0,
    safeCount: 0,
    ambiguousCount: 0,
    deferredBoundaryCount: 0,
    uncertainCount: 0,
    duplicateExistingCount: 0,
    crossSourceConflictCount: 0,
    txBProcessed: 0,
    txBReconciliationNoState: 0,
    txBErrors: 0,
    classified: [],
    errors: []
  };
}

function finalResult(summary: RestTransferWindowSummary): RestTransferWindowSummary["result"] {
  if (!summary.transportComplete) return summary.pagesFetched === 0 ? "REST_TRANSFER_WINDOW_FAILED" : "REST_TRANSFER_WINDOW_PARTIAL";
  if (!summary.semanticCoverageComplete || !summary.txAAdmissionComplete || !summary.candidateCoverageComplete || summary.deferredBoundaryCount > 0 || summary.uncertainCount > 0 || summary.txBErrors > 0) return "REST_TRANSFER_WINDOW_PARTIAL";
  return "REST_TRANSFER_WINDOW_COMPLETE";
}

export async function runRestTransferWindowAdmissionBarrier(input: RunRestTransferWindowInput, dependencies: RestTransferWindowDependencies): Promise<RestTransferWindowSummary> {
  const policy = validateRestBackfillPolicy(input.policy);
  validateBackfillWindow(input.window, policy);
  const summary = emptySummary(input.window);
  if (restTransferWindowInFlight) {
    summary.txAAdmissionComplete = false;
    summary.errors.push("rest transfer window executor already in flight");
    summary.result = finalResult(summary);
    return summary;
  }
  restTransferWindowInFlight = true;
  try {
  const fetched: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (summary.pagesFetched < policy.maxPages && summary.eventsObserved < policy.maxEvents) {
    let page: RestEventsPage;
    try {
      page = await dependencies.client.fetchCollectionEventsPage({
        after: input.window.after,
        before: input.window.before,
        limit: policy.pageLimit,
        cursor,
        eventTypes: PRODUCTION_REST_TRANSFER_EVENT_TYPES
      });
    } catch (error) {
      summary.errors.push(`page request failed: ${sanitizeBackfillError(error)}`);
      break;
    }
    summary.pagesFetched += 1;
    for (const event of page.events) {
      if (summary.eventsObserved >= policy.maxEvents) break;
      fetched.push(event);
      summary.eventsObserved += 1;
    }
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
  if (!summary.transportComplete && summary.pagesFetched >= policy.maxPages && cursor) summary.errors.push("maxPages reached before API exhaustion");
  if (!summary.transportComplete && summary.eventsObserved >= policy.maxEvents) summary.errors.push("maxEvents reached before API exhaustion");

  if (!summary.transportComplete) {
    summary.result = finalResult(summary);
    return summary;
  }

  const adapted: unknown[] = [];
  for (const event of fetched) {
    const result = adaptRestEventToDurableIngress(event);
    if (result.outcome !== "adapted") {
      summary.semanticCoverageComplete = false;
      if (result.outcome === "unsupported") summary.eventsUnsupported += 1;
      else summary.eventsMalformed += 1;
      summary.errors.push(result.outcome === "malformed" ? `malformed transfer: ${sanitizeBackfillError(result.reason)}` : `unsupported transfer: ${sanitizeBackfillError(result.reason)}`);
      continue;
    }
    if (result.durableEventType !== "item_transferred") {
      summary.eventsMalformed += 1;
      summary.semanticCoverageComplete = false;
      summary.errors.push(`non-transfer event in transfer window: ${result.durableEventType}`);
      continue;
    }
    adapted.push(result.rawEvent);
    summary.eventsAdapted += 1;
  }

  const admitted: DurableInboxPersistResult[] = [];
  for (const rawEvent of adapted) {
    try {
      const result = await dependencies.persistEvent(rawEvent, dependencies.now?.() ?? new Date().toISOString());
      admitted.push(result);
      if (result.outcome === "inserted_pending") summary.txAInserted += 1;
      else summary.txADuplicates += 1;
    } catch (error) {
      summary.txAAdmissionComplete = false;
      summary.txAErrors += 1;
      summary.errors.push(`Tx A admission failed: ${sanitizeBackfillError(error)}`);
    }
  }

  const protectedBoundarySeconds = protectedBoundarySecondsForWindow(input.window);
  const pendingEventIds = admitted.filter((result) => result.outcome === "inserted_pending" || (result.outcome === "duplicate_existing" && result.processingStatus === "pending")).map((result) => result.eventId);
  const duplicateEventIds = admitted.filter((result) => result.outcome === "duplicate_existing").map((result) => result.eventId);
  if (!summary.transportComplete || !summary.semanticCoverageComplete || !summary.txAAdmissionComplete) {
    summary.duplicateExistingCount = summary.txADuplicates;
    summary.result = finalResult(summary);
    return summary;
  }
  const candidates = await loadRestTransferWindowJournalCandidates(dependencies.journal, input.window);
  const returnedIds = new Set(candidates.map((candidate) => candidate.eventId));
  const missingTargets = pendingEventIds.filter((eventId) => !returnedIds.has(eventId));
  if (missingTargets.length > 0 || hasIncompleteCandidate(candidates)) {
    summary.candidateCoverageComplete = false;
    if (missingTargets.length > 0) summary.errors.push(`candidate coverage missing target event ids: ${missingTargets.map(sanitizeBackfillError).join(",")}`);
    if (hasIncompleteCandidate(candidates)) summary.errors.push("candidate coverage incomplete transfer identity");
  }
  const classified = classifyRestTransferWindowEvents(candidates, pendingEventIds, { protectedBoundarySeconds, candidateCoverageComplete: summary.candidateCoverageComplete });
  summary.classified = classified;
  for (const item of classified) {
    if (item.classification === "SAFE") summary.safeCount += 1;
    else if (item.classification === "AMBIGUOUS") {
      summary.ambiguousCount += 1;
      const own = candidates.find((candidate) => candidate.eventId === item.eventId);
      const ownSecond = normalizeBusinessSecond(own?.eventTimestamp);
      summary.crossSourceConflictCount += candidates.some((candidate) => candidate.eventId !== item.eventId && normalizeBusinessSecond(candidate.eventTimestamp) === ownSecond && !isRestBackfillCandidate(candidate)) ? 1 : 0;
    } else if (item.classification === "DEFERRED_BOUNDARY") summary.deferredBoundaryCount += 1;
    else if (item.classification === "UNCERTAIN") summary.uncertainCount += 1;
  }
  summary.duplicateExistingCount = summary.txADuplicates;

  if (!isWindowStateReleaseEligible(summary)) {
    summary.result = finalResult(summary);
    return summary;
  }

  for (const item of classified) {
    if (item.classification !== "SAFE" && item.classification !== "AMBIGUOUS") continue;
    try {
      const result = item.classification === "AMBIGUOUS"
        ? await dependencies.finalizeAmbiguousEventById(item.eventId)
        : await dependencies.applyEventById(item.eventId);
      summary.txBProcessed += 1;
      if (item.classification === "AMBIGUOUS" && result.outcome === "reconciliation_required") summary.txBReconciliationNoState += 1;
    } catch (error) {
      summary.txBErrors += 1;
      summary.errors.push(`Tx B failed: ${sanitizeBackfillError(error)}`);
    }
  }

  summary.result = finalResult(summary);
  return summary;
  } finally {
    restTransferWindowInFlight = false;
  }
}
