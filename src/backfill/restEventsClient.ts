import {
  OPENSEA_REST_COLLECTION_EVENTS_ENDPOINT,
  SUPPORTED_REST_EVENT_TYPES,
  type RestBackfillPolicy,
  type RestBackfillRateLimit,
  type RestEventsPage,
  type RestHttpRetryPolicy,
  type SupportedRestEventType
} from "./types.js";
import { createHash } from "node:crypto";

export interface HttpHeadersLike {
  get(name: string): string | null;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  headers: HttpHeadersLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<HttpResponseLike>;
export type SleepLike = (ms: number) => Promise<void>;
export type RandomLike = () => number;

export interface RestEventsClientDependencies {
  fetch?: FetchLike;
  sleep?: SleepLike;
  random?: RandomLike;
}

export interface RestEventsClientOptions {
  apiKey: string;
  policy?: Partial<RestBackfillPolicy>;
  retryPolicy?: Partial<RestHttpRetryPolicy>;
  dependencies?: RestEventsClientDependencies;
}

export interface FetchCollectionEventsPageInput {
  after: number;
  before: number;
  limit?: number;
  cursor?: string | null;
  eventTypes?: readonly string[];
}

export const DEFAULT_REST_BACKFILL_POLICY: RestBackfillPolicy = {
  pageLimit: 200,
  maxPages: 100,
  maxEvents: 20_000,
  requestTimeoutMs: 30_000,
  maxWindowSeconds: 7 * 24 * 60 * 60
};

export const DEFAULT_REST_HTTP_RETRY_POLICY: RestHttpRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2
};

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

export class RestEventsClientError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
    public readonly literalResponseText: string | null = null,
    public readonly rateLimit: RestBackfillRateLimit | null = null,
    public readonly literalResponseSha256: string | null = literalResponseText === null ? null : hashResponseText(literalResponseText),
    public readonly literalResponseByteLength: number | null = literalResponseText === null ? null : Buffer.byteLength(literalResponseText, "utf8")
  ) {
    super(message);
    this.name = "RestEventsClientError";
  }
}

function hashResponseText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireFetch(fetchImpl?: FetchLike): FetchLike {
  const candidate = fetchImpl ?? globalThis.fetch;
  if (typeof candidate !== "function") throw new RestEventsClientError("fetch implementation is not available", false);
  return candidate as FetchLike;
}

export function sanitizeBackfillError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(x-api-key|api[_-]?key|password|connection\s*string)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>")
    .replace(/([?&](?:api_key|key|token)=)[^&\s]+/gi, "$1<redacted>")
    .slice(0, 300);
}

export function validateRestBackfillPolicy(policy: Partial<RestBackfillPolicy> = {}): RestBackfillPolicy {
  const merged = { ...DEFAULT_REST_BACKFILL_POLICY, ...policy };
  if (!Number.isSafeInteger(merged.pageLimit) || merged.pageLimit < 1 || merged.pageLimit > 200) throw new Error("pageLimit must be an integer from 1 to 200");
  if (!Number.isSafeInteger(merged.maxPages) || merged.maxPages < 1 || merged.maxPages > 1_000) throw new Error("maxPages must be an integer from 1 to 1000");
  if (!Number.isSafeInteger(merged.maxEvents) || merged.maxEvents < 1 || merged.maxEvents > 100_000) throw new Error("maxEvents must be an integer from 1 to 100000");
  if (!Number.isSafeInteger(merged.requestTimeoutMs) || merged.requestTimeoutMs < 1_000 || merged.requestTimeoutMs > 300_000) throw new Error("requestTimeoutMs must be an integer from 1000 to 300000");
  if (!Number.isSafeInteger(merged.maxWindowSeconds) || merged.maxWindowSeconds < 1 || merged.maxWindowSeconds > 31 * 24 * 60 * 60) throw new Error("maxWindowSeconds must be an integer from 1 to 2678400");
  return merged;
}

export function validateRestHttpRetryPolicy(policy: Partial<RestHttpRetryPolicy> = {}): RestHttpRetryPolicy {
  const merged = { ...DEFAULT_REST_HTTP_RETRY_POLICY, ...policy };
  if (!Number.isSafeInteger(merged.maxAttempts) || merged.maxAttempts < 1 || merged.maxAttempts > 10) throw new Error("maxAttempts must be an integer from 1 to 10");
  if (!Number.isSafeInteger(merged.baseDelayMs) || merged.baseDelayMs < 0 || merged.baseDelayMs > 300_000) throw new Error("baseDelayMs must be an integer from 0 to 300000");
  if (!Number.isSafeInteger(merged.maxDelayMs) || merged.maxDelayMs < 0 || merged.maxDelayMs > 300_000) throw new Error("maxDelayMs must be an integer from 0 to 300000");
  if (merged.maxDelayMs < merged.baseDelayMs) throw new Error("maxDelayMs must be greater than or equal to baseDelayMs");
  if (typeof merged.jitterRatio !== "number" || !Number.isFinite(merged.jitterRatio) || merged.jitterRatio < 0 || merged.jitterRatio > 1) throw new Error("jitterRatio must be from 0 to 1");
  return merged;
}

function delayForAttempt(attemptIndex: number, retryAfter: string | null, policy: RestHttpRetryPolicy, random: RandomLike): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.trunc(seconds * 1000), policy.maxDelayMs);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), policy.maxDelayMs);
  }
  const exponent = Math.max(0, attemptIndex - 1);
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitter = base * policy.jitterRatio * random();
  return Math.trunc(Math.min(policy.maxDelayMs, base + jitter));
}

function rateLimitFrom(headers: HttpHeadersLike): RestBackfillRateLimit {
  return {
    limit: headers.get("X-RateLimit-Limit") ?? headers.get("x-ratelimit-limit"),
    remaining: headers.get("X-RateLimit-Remaining") ?? headers.get("x-ratelimit-remaining"),
    reset: headers.get("X-RateLimit-Reset") ?? headers.get("x-ratelimit-reset"),
    retryAfter: headers.get("Retry-After") ?? headers.get("retry-after")
  };
}

function validateResponseBody(body: unknown): { events: unknown[]; next: string | null } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new RestEventsClientError("OpenSea events response is not an object", false);
  const record = body as Record<string, unknown>;
  const events = Array.isArray(record.asset_events) ? record.asset_events : Array.isArray(record.events) ? record.events : null;
  if (!events) throw new RestEventsClientError("OpenSea events response has no event array", false);
  if (record.next !== undefined && record.next !== null && typeof record.next !== "string") throw new RestEventsClientError("OpenSea events response next cursor is invalid", false);
  return { events, next: typeof record.next === "string" && record.next.length > 0 ? record.next : null };
}

export class RestEventsClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  private readonly random: RandomLike;
  private readonly policy: RestBackfillPolicy;
  private readonly retryPolicy: RestHttpRetryPolicy;

  constructor(private readonly options: RestEventsClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) throw new Error("OPENSEA_API_KEY is required");
    this.fetchImpl = requireFetch(options.dependencies?.fetch);
    this.sleep = options.dependencies?.sleep ?? (() => Promise.resolve());
    this.random = options.dependencies?.random ?? Math.random;
    this.policy = validateRestBackfillPolicy(options.policy);
    this.retryPolicy = validateRestHttpRetryPolicy(options.retryPolicy);
  }

  async fetchCollectionEventsPage(input: FetchCollectionEventsPageInput): Promise<RestEventsPage> {
    const limit = input.limit ?? this.policy.pageLimit;
    if (!Number.isSafeInteger(input.after) || !Number.isSafeInteger(input.before)) throw new Error("after and before must be safe Unix seconds");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer from 1 to 200");
    const eventTypes = input.eventTypes ?? SUPPORTED_REST_EVENT_TYPES;
    const url = new URL(OPENSEA_REST_COLLECTION_EVENTS_ENDPOINT);
    url.searchParams.set("after", String(input.after));
    url.searchParams.set("before", String(input.before));
    url.searchParams.set("limit", String(limit));
    for (const eventType of eventTypes) url.searchParams.append("event_type", eventType);
    if (input.cursor) url.searchParams.set("next", input.cursor);

    let retries = 0;
    let rateLimitedResponses = 0;
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.policy.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(url.toString(), { method: "GET", headers: { Accept: "application/json", "X-API-KEY": this.options.apiKey }, signal: abort.signal });
        const rateLimit = rateLimitFrom(response.headers);
        let responseText = "";
        try {
          responseText = await response.text();
        } catch (error) {
          throw new RestEventsClientError(`OpenSea REST response body read failed: ${sanitizeBackfillError(error)}`, false, response.status, null, rateLimit);
        }
        if (response.ok) {
          let body: unknown;
          try {
            body = JSON.parse(responseText);
          } catch (error) {
            throw new RestEventsClientError(`OpenSea events response JSON parse failed: ${sanitizeBackfillError(error)}`, false, response.status, responseText, rateLimit);
          }
          const parsed = validateResponseBody(body);
          return {
            ...parsed,
            httpStatus: response.status,
            literalResponseText: responseText,
            literalResponseSha256: hashResponseText(responseText),
            literalResponseByteLength: Buffer.byteLength(responseText, "utf8"),
            rateLimit,
            retries,
            rateLimitedResponses
          };
        }
        if (response.status === 429) rateLimitedResponses += 1;
        const retryable = TRANSIENT_HTTP_STATUSES.has(response.status);
        if (!retryable || attempt === this.retryPolicy.maxAttempts) {
          const text = responseText.slice(0, 120);
          throw new RestEventsClientError(`OpenSea REST request failed with HTTP ${response.status}${text ? `: ${sanitizeBackfillError(text)}` : ""}`, retryable, response.status, responseText, rateLimit);
        }
        retries += 1;
        await this.sleep(delayForAttempt(attempt, rateLimit.retryAfter, this.retryPolicy, this.random));
      } catch (error) {
        if (error instanceof RestEventsClientError) throw error;
        const retryable = error instanceof Error && (error.name === "AbortError" || /ECONNRESET|ETIMEDOUT|EPIPE|network|timeout/i.test(error.message));
        if (!retryable || attempt === this.retryPolicy.maxAttempts) throw new RestEventsClientError(`OpenSea REST request failed: ${sanitizeBackfillError(error)}`, retryable);
        retries += 1;
        await this.sleep(delayForAttempt(attempt, null, this.retryPolicy, this.random));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new RestEventsClientError("OpenSea REST retry loop exhausted", true);
  }
}
