import type { DurableInboxPersistResult } from "../db/types.js";

export const OPENSEA_REST_COLLECTION_EVENTS_ENDPOINT = "https://api.opensea.io/api/v2/events/collection/off-the-grid";
export const REST_BACKFILL_CHAIN = "gunzilla";
export const REST_BACKFILL_COLLECTION_SLUG = "off-the-grid";
export const REST_BACKFILL_CONTRACT_ADDRESS = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271";

export const SUPPORTED_REST_EVENT_TYPES = ["listing", "sale", "transfer"] as const;
export const UNSUPPORTED_REST_EVENT_TYPES = ["cancel", "mint", "offer", "trait_offer", "collection_offer", "order_invalidate", "order_revalidate"] as const;

export type SupportedRestEventType = (typeof SUPPORTED_REST_EVENT_TYPES)[number];
export type DurableBackfillEventType = "item_listed" | "item_sold" | "item_transferred";

export interface RestBackfillWindow {
  after: number;
  before: number;
}

export interface RestBackfillPolicy {
  pageLimit: number;
  maxPages: number;
  maxEvents: number;
  requestTimeoutMs: number;
  maxWindowSeconds: number;
}

export interface RestHttpRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface RestBackfillRateLimit {
  limit: string | null;
  remaining: string | null;
  reset: string | null;
  retryAfter: string | null;
}

export interface RestEventsPage {
  events: unknown[];
  next: string | null;
  httpStatus: number;
  literalResponseText: string;
  literalResponseSha256: string;
  literalResponseByteLength: number;
  rateLimit: RestBackfillRateLimit;
  retries: number;
  rateLimitedResponses: number;
}

export type RestEventAdaptResult =
  | { outcome: "adapted"; restEventType: SupportedRestEventType; durableEventType: DurableBackfillEventType; rawEvent: unknown; eventTimestamp: string | null }
  | { outcome: "unsupported"; restEventType: string; reason: string }
  | { outcome: "malformed"; restEventType: string; reason: string };

export interface RestBackfillCounters {
  pagesRequested: number;
  pagesSucceeded: number;
  restEventsObserved: number;
  restEventsSupported: number;
  restEventsUnsupported: number;
  restEventsMalformed: number;
  adaptedEvents: number;
  persistInsertedPending: number;
  persistDuplicateExisting: number;
  persistErrors: number;
  httpRetries: number;
  rateLimitedResponses: number;
  cursorCycles: number;
}

export interface RestEventsBackfillSummary extends RestBackfillCounters {
  result: "BACKFILL_COMPLETE" | "BACKFILL_PARTIAL" | "BACKFILL_FAILED";
  window: RestBackfillWindow;
  transportComplete: boolean;
  semanticCoverageComplete: boolean;
  eventTypeDistribution: Record<string, number>;
  unsupportedTypeDistribution: Record<string, number>;
  firstEventTimestamp: string | null;
  lastEventTimestamp: string | null;
  lastCursor: string | null;
  errors: string[];
}

export type PersistBackfillEvent = (rawEvent: unknown, receivedAt: string) => Promise<DurableInboxPersistResult>;
