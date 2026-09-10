import { persistRawEventToInbox } from "../db/durableInboxRepository.js";
import type { DbPool } from "../db/types.js";
import { adaptRestEventToDurableIngress } from "./restEventAdapter.js";
import { RestEventsClient, sanitizeBackfillError, validateRestBackfillPolicy, type RestEventsClientOptions } from "./restEventsClient.js";
import { type PersistBackfillEvent, type RestBackfillPolicy, type RestBackfillWindow, type RestEventsBackfillSummary, type SupportedRestEventType } from "./types.js";

export const PRODUCTION_REST_TRANSFER_EVENT_TYPES = ["transfer"] as const satisfies readonly SupportedRestEventType[];

export interface RestEventsBackfillDependencies {
  client: Pick<RestEventsClient, "fetchCollectionEventsPage">;
  persistEvent: PersistBackfillEvent;
  now?: () => string;
}

export interface RunRestEventsBackfillWindowInput {
  window: RestBackfillWindow;
  policy?: Partial<RestBackfillPolicy>;
  eventTypes?: readonly SupportedRestEventType[];
}

export function validateBackfillWindow(window: RestBackfillWindow, policy: RestBackfillPolicy): void {
  if (!Number.isSafeInteger(window.after) || !Number.isSafeInteger(window.before)) throw new Error("after and before must be safe Unix seconds");
  if (window.after < 0 || window.before < 0) throw new Error("after and before must be non-negative");
  if (window.after >= window.before) throw new Error("after must be lower than before");
  if (window.before - window.after > policy.maxWindowSeconds) throw new Error("backfill window exceeds configured safety maximum");
}

export function backfillWindowWithOverlap(gapStart: number, gapEnd: number, overlapSeconds = 300): RestBackfillWindow {
  if (!Number.isSafeInteger(gapStart) || !Number.isSafeInteger(gapEnd) || !Number.isSafeInteger(overlapSeconds)) throw new Error("gap and overlap values must be safe integers");
  if (gapStart < 0 || gapEnd < 0 || overlapSeconds < 0) throw new Error("gap and overlap values must be non-negative");
  if (gapStart >= gapEnd) throw new Error("gapStart must be lower than gapEnd");
  return { after: Math.max(0, gapStart - overlapSeconds), before: gapEnd };
}

function addCounter(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function emptySummary(window: RestBackfillWindow): RestEventsBackfillSummary {
  return {
    result: "BACKFILL_FAILED",
    window,
    transportComplete: false,
    semanticCoverageComplete: true,
    pagesRequested: 0,
    pagesSucceeded: 0,
    restEventsObserved: 0,
    restEventsSupported: 0,
    restEventsUnsupported: 0,
    restEventsMalformed: 0,
    adaptedEvents: 0,
    persistInsertedPending: 0,
    persistDuplicateExisting: 0,
    persistErrors: 0,
    httpRetries: 0,
    rateLimitedResponses: 0,
    cursorCycles: 0,
    eventTypeDistribution: {},
    unsupportedTypeDistribution: {},
    firstEventTimestamp: null,
    lastEventTimestamp: null,
    lastCursor: null,
    errors: []
  };
}

function finalResult(summary: RestEventsBackfillSummary): RestEventsBackfillSummary["result"] {
  if (summary.pagesSucceeded === 0 && !summary.transportComplete) return "BACKFILL_FAILED";
  if (!summary.transportComplete || !summary.semanticCoverageComplete || summary.persistErrors > 0) return "BACKFILL_PARTIAL";
  return "BACKFILL_COMPLETE";
}

export async function runRestEventsBackfillWindow(input: RunRestEventsBackfillWindowInput, dependencies: RestEventsBackfillDependencies): Promise<RestEventsBackfillSummary> {
  const policy = validateRestBackfillPolicy(input.policy);
  validateBackfillWindow(input.window, policy);
  const summary = emptySummary(input.window);
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let bounded = false;
  while (summary.pagesRequested < policy.maxPages && summary.restEventsObserved < policy.maxEvents) {
    summary.pagesRequested += 1;
    try {
      const page = await dependencies.client.fetchCollectionEventsPage({ after: input.window.after, before: input.window.before, limit: policy.pageLimit, cursor, eventTypes: input.eventTypes });
      summary.pagesSucceeded += 1;
      summary.httpRetries += page.retries;
      summary.rateLimitedResponses += page.rateLimitedResponses;
      for (const event of page.events) {
        if (summary.restEventsObserved >= policy.maxEvents) {
          bounded = true;
          break;
        }
        summary.restEventsObserved += 1;
        const type = typeof (event as any)?.event_type === "string" ? (event as any).event_type : typeof (event as any)?.eventType === "string" ? (event as any).eventType : "unknown";
        addCounter(summary.eventTypeDistribution, type);
        const adapted = adaptRestEventToDurableIngress(event);
        if (adapted.outcome === "unsupported") {
          summary.restEventsUnsupported += 1;
          summary.semanticCoverageComplete = false;
          addCounter(summary.unsupportedTypeDistribution, adapted.restEventType);
          continue;
        }
        if (adapted.outcome === "malformed") {
          summary.restEventsMalformed += 1;
          summary.semanticCoverageComplete = false;
          summary.errors.push(`malformed ${adapted.restEventType}: ${sanitizeBackfillError(adapted.reason)}`);
          continue;
        }
        summary.restEventsSupported += 1;
        summary.adaptedEvents += 1;
        summary.firstEventTimestamp ??= adapted.eventTimestamp;
        summary.lastEventTimestamp = adapted.eventTimestamp ?? summary.lastEventTimestamp;
        try {
          const result = await dependencies.persistEvent(adapted.rawEvent, dependencies.now?.() ?? new Date().toISOString());
          if (result.outcome === "inserted_pending") summary.persistInsertedPending += 1;
          else summary.persistDuplicateExisting += 1;
        } catch (error) {
          summary.persistErrors += 1;
          summary.errors.push(`persist failed: ${sanitizeBackfillError(error)}`);
        }
      }
      summary.lastCursor = page.next;
      if (!page.next) {
        summary.transportComplete = true;
        break;
      }
      if (seenCursors.has(page.next)) {
        summary.cursorCycles += 1;
        summary.errors.push("cursor cycle detected");
        break;
      }
      seenCursors.add(page.next);
      cursor = page.next;
    } catch (error) {
      summary.errors.push(`page request failed: ${sanitizeBackfillError(error)}`);
      break;
    }
  }
  if (!summary.transportComplete && summary.pagesRequested >= policy.maxPages && summary.lastCursor) summary.errors.push("maxPages reached before API exhaustion");
  if (!summary.transportComplete && (summary.restEventsObserved >= policy.maxEvents || bounded)) summary.errors.push("maxEvents reached before API exhaustion");
  summary.result = finalResult(summary);
  return summary;
}

export function createRestEventsBackfillDependencies(pool: DbPool, clientOptions: RestEventsClientOptions): RestEventsBackfillDependencies {
  const client = new RestEventsClient(clientOptions);
  return {
    client,
    persistEvent: (rawEvent, receivedAt) => persistRawEventToInbox(pool, rawEvent, receivedAt)
  };
}
