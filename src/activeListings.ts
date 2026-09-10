import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { Agent, request } from "node:https";

export const ACTIVE_LISTINGS_ENDPOINT = "https://api.opensea.io/api/v2/listings/collection/off-the-grid/all";
export const ACTIVE_LISTINGS_CHAIN = "gunzilla";
export const ACTIVE_LISTINGS_COLLECTION = "off-the-grid";
export const ACTIVE_LISTINGS_CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271";
/** Direct-test-only seam; the production CLI never supplies this symbol. */
export const ACTIVE_LISTINGS_LOCAL_TEST_ENDPOINT = Symbol("activeListingsLocalTestEndpoint");

export interface ActiveListingsHeaders { get(name: string): string | null; }
export interface ActiveListingsResponse { ok: boolean; status: number; headers: ActiveListingsHeaders; text(): Promise<string>; }
export type ActiveListingsFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<ActiveListingsResponse>;
export interface ActiveListingsClientDependencies { fetch?: ActiveListingsFetch; sleep?: (ms: number) => Promise<void>; random?: () => number; close?: () => Promise<void> | void; }
export interface ActiveListingsPolicy { pageLimit: number; maxPages: number; maxListings: number; requestTimeoutMs: number; interPageDelayMs: number; }
export interface ActiveListingsRetryPolicy { maxRetries: number; baseDelayMs: number; maxDelayMs: number; jitterRatio: number; }
export interface ActiveListingsClientOptions { apiKey: string; policy?: Partial<ActiveListingsPolicy>; retryPolicy?: Partial<ActiveListingsRetryPolicy>; dependencies?: ActiveListingsClientDependencies; [ACTIVE_LISTINGS_LOCAL_TEST_ENDPOINT]?: string; }

export interface NormalizedActiveListing {
  orderHash: string;
  nftId: string;
  chain: typeof ACTIVE_LISTINGS_CHAIN;
  contractAddress: typeof ACTIVE_LISTINGS_CONTRACT;
  tokenId: string;
  collectionSlug: typeof ACTIVE_LISTINGS_COLLECTION;
  sellerAddress: string;
  price: { raw: string; normalizedDecimalString: string; currency: string | null; decimals: number | null };
  listingStartAt: string;
  expirationAt: string;
  orderCreatedAt: string;
  protocolAddress: string | null;
  protocolName: string | null;
  isPrivate: boolean;
  rawListing: unknown;
}

export interface ActiveListingsCounters { observed: number; normalized: number; malformed: number; unsupported: number; duplicates: number; conflicts: number; }
export interface ActiveListingsPageAttemptEvidence { logicalPage: number; httpAttempts: number; retryAttempts: number; successful: boolean; finalStatus: number | null; error: string | null; retryAfterUsed: boolean; waitMs: number[]; }
export interface ActiveListingsSnapshotEvidence {
  result: "COMPLETE" | "PARTIAL" | "FAILED" | "UNSAFE";
  startedAt: string;
  completedAt: string;
  endpoint: string;
  collectionSlug: typeof ACTIVE_LISTINGS_COLLECTION;
  expectedChain: typeof ACTIVE_LISTINGS_CHAIN;
  expectedContract: typeof ACTIVE_LISTINGS_CONTRACT;
  pageAttempts: number;
  pagesFetched: number;
  httpAttempts: number;
  retryAttempts: number;
  pageAttemptDetails: ActiveListingsPageAttemptEvidence[];
  counters: ActiveListingsCounters;
  paginationExhausted: boolean;
  cursorCycleDetected: boolean;
  repeatedPageDetected: boolean;
  truncatedByPageLimit: boolean;
  truncatedByListingLimit: boolean;
  listings: NormalizedActiveListing[];
  rawPages: unknown[];
  nextCursor: string | null;
  warnings: string[];
  errors: string[];
  responseHashes: string[];
  sourceProvenance: Record<string, string>;
}

export const DEFAULT_ACTIVE_LISTINGS_POLICY: ActiveListingsPolicy = { pageLimit: 200, maxPages: 100, maxListings: 20_000, requestTimeoutMs: 30_000, interPageDelayMs: 0 };
export const DEFAULT_ACTIVE_LISTINGS_RETRY_POLICY: ActiveListingsRetryPolicy = { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 30_000, jitterRatio: 0.2 };
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_EPOCH_SECONDS = 8_640_000_000_000n;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ActiveListingsError extends Error { constructor(message: string, public readonly retryable = false, public readonly status: number | null = null) { super(message); this.name = "ActiveListingsError"; } }
class ActiveListingsPageError extends ActiveListingsError { constructor(message: string, retryable: boolean, status: number | null, public readonly httpAttempts: number, public readonly retryAttempts: number, public readonly detail: ActiveListingsPageAttemptEvidence = { logicalPage: 0, httpAttempts, retryAttempts, successful: false, finalStatus: status, error: message, retryAfterUsed: false, waitMs: [] }) { super(message, retryable, status); this.name = "ActiveListingsPageError"; } }
function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function requireFetch(fetchImpl?: ActiveListingsFetch): ActiveListingsFetch { const fetcher = fetchImpl ?? globalThis.fetch; if (typeof fetcher !== "function") throw new ActiveListingsError("fetch_implementation_unavailable"); return fetcher as ActiveListingsFetch; }

function validatePolicy(value: Partial<ActiveListingsPolicy> = {}): ActiveListingsPolicy {
  const policy = { ...DEFAULT_ACTIVE_LISTINGS_POLICY, ...value };
  if (!Number.isSafeInteger(policy.pageLimit) || policy.pageLimit < 1 || policy.pageLimit > 200) throw new Error("pageLimit must be 1..200");
  if (!Number.isSafeInteger(policy.maxPages) || policy.maxPages < 1 || policy.maxPages > 1_000) throw new Error("maxPages must be 1..1000");
  if (!Number.isSafeInteger(policy.maxListings) || policy.maxListings < 1 || policy.maxListings > 100_000) throw new Error("maxListings must be 1..100000");
  if (!Number.isSafeInteger(policy.requestTimeoutMs) || policy.requestTimeoutMs < 1_000 || policy.requestTimeoutMs > 300_000) throw new Error("requestTimeoutMs must be 1000..300000");
  if (!Number.isSafeInteger(policy.interPageDelayMs) || policy.interPageDelayMs < 0 || policy.interPageDelayMs > 60_000) throw new Error("interPageDelayMs must be 0..60000");
  return policy;
}
function validateRetryPolicy(value: Partial<ActiveListingsRetryPolicy> = {}): ActiveListingsRetryPolicy {
  const policy = { ...DEFAULT_ACTIVE_LISTINGS_RETRY_POLICY, ...value };
  if (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 10) throw new Error("maxRetries must be 0..10");
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 0 || policy.baseDelayMs > 300_000) throw new Error("baseDelayMs must be 0..300000");
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs || policy.maxDelayMs > 300_000) throw new Error("maxDelayMs must be >= baseDelayMs and <= 300000");
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) throw new Error("jitterRatio must be 0..1");
  return policy;
}
function resolveEndpoint(options: ActiveListingsClientOptions): string {
  const candidate = options[ACTIVE_LISTINGS_LOCAL_TEST_ENDPOINT];
  if (candidate === undefined) return ACTIVE_LISTINGS_ENDPOINT;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) throw new Error("local_test_endpoint_must_be_https_loopback");
  return parsed.toString().replace(/\/$/, "");
}
function normalizeEpochSeconds(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new ActiveListingsError(`${field}_invalid_epoch_seconds`);
  const seconds = BigInt(value);
  if (seconds <= 0n || seconds > MAX_EPOCH_SECONDS) throw new ActiveListingsError(`${field}_out_of_range`);
  return new Date(Number(seconds) * 1_000).toISOString();
}
function normalizeCreatedEpoch(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || BigInt(value) > MAX_EPOCH_SECONDS) throw new ActiveListingsError(`${field}_invalid_epoch_seconds`);
  return new Date(value * 1_000).toISOString();
}
function normalizeAddress(value: unknown, field: string): string { const address = text(value)?.toLowerCase(); if (!address || !/^0x[0-9a-f]{40}$/.test(address)) throw new ActiveListingsError(`${field}_invalid`); return address; }
function normalizeToken(value: unknown): string { const token = text(value); if (!token || !/^(0|[1-9]\d*)$/.test(token)) throw new ActiveListingsError("token_id_invalid"); return token; }
function decimalPrice(raw: string, decimals: number): string { const digits = raw.replace(/^0+(?=\d)/, "") || "0"; if (decimals === 0) return digits; const padded = digits.padStart(decimals + 1, "0"); return `${padded.slice(0, -decimals)}.${padded.slice(-decimals).replace(/0+$/, "") || "0"}`; }
function unsupported(reason: string): never { throw new ActiveListingsError(`unsupported_${reason}`); }
function exactDecimalAmount(value: unknown, field: string): bigint { if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new ActiveListingsError(`${field}_invalid`); return BigInt(value); }
function validateConsideration(value: unknown, expectedPrice: bigint): void {
  if (!Array.isArray(value) || value.length === 0) throw new ActiveListingsError("consideration_missing_or_empty");
  let total = 0n;
  for (const [index, item] of value.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new ActiveListingsError(`consideration_${index}_invalid`);
    const row = item as Record<string, unknown>;
    const start = exactDecimalAmount(row.startAmount, `consideration_${index}_start_amount`);
    const end = exactDecimalAmount(row.endAmount, `consideration_${index}_end_amount`);
    if (start !== end) throw new ActiveListingsError(`consideration_${index}_amount_range_mismatch`);
    total += start;
  }
  if (total !== expectedPrice) throw new ActiveListingsError("consideration_price_mismatch");
}

export function normalizeActiveListing(raw: unknown): NormalizedActiveListing {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ActiveListingsError("listing_row_not_object");
  const listing = raw as Record<string, any>;
  const orderHash = text(listing.order_hash)?.toLowerCase(); if (!orderHash) throw new ActiveListingsError("order_hash_missing");
  if (text(listing.chain)?.toLowerCase() !== ACTIVE_LISTINGS_CHAIN) throw new ActiveListingsError("listing_chain_mismatch");
  const asset = listing.asset; if (asset === null || typeof asset !== "object" || Array.isArray(asset)) throw new ActiveListingsError("asset_missing_or_invalid");
  const tokenId = normalizeToken(asset.identifier); const assetContract = normalizeAddress(asset.contract, "asset_contract"); if (assetContract !== ACTIVE_LISTINGS_CONTRACT) throw new ActiveListingsError("listing_contract_mismatch");
  const parameters = listing.protocol_data?.parameters; if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) throw new ActiveListingsError("protocol_parameters_missing_or_invalid");
  const offer = parameters.offer; if (!Array.isArray(offer) || offer.length !== 1) return unsupported("offer_shape");
  const item = offer[0]; if (item === null || typeof item !== "object" || Array.isArray(item)) return unsupported("offer_item_invalid");
  if (item.itemType !== 2) return unsupported("offer_item_type");
  if (text(item.token)?.toLowerCase() !== assetContract) return unsupported("offer_token_mismatch");
  if (text(item.identifierOrCriteria) !== tokenId) return unsupported("offer_identifier_mismatch");
  if (item.startAmount !== "1") return unsupported("offer_start_amount");
  if (item.endAmount !== "1") return unsupported("offer_end_amount");
  const sellerAddress = normalizeAddress(parameters.offerer, "offerer");
  const current = listing.price?.current; const rawPrice = current?.value; if (typeof rawPrice !== "string" || !/^(0|[1-9]\d*)$/.test(rawPrice)) throw new ActiveListingsError("price_value_invalid");
  const currency = current?.currency; if (currency !== "GUN") throw new ActiveListingsError("price_currency_invalid");
  const decimals = current?.decimals; if (!Number.isSafeInteger(decimals) || decimals !== 18) throw new ActiveListingsError("price_decimals_invalid");
  const priceValue = BigInt(rawPrice); validateConsideration(parameters.consideration, priceValue);
  const listingStartAt = normalizeEpochSeconds(parameters.startTime, "start_time"); const expirationAt = normalizeEpochSeconds(parameters.endTime, "end_time");
  if (BigInt(parameters.startTime) > BigInt(parameters.endTime)) throw new ActiveListingsError("start_time_after_end_time");
  const orderCreatedAt = normalizeCreatedEpoch(listing.order_created_at, "order_created_at");
  if (listing.status !== "ACTIVE") return unsupported("status"); if (listing.type !== "basic") return unsupported("type"); if (listing.remaining_quantity !== 1) return unsupported("remaining_quantity");
  const isPrivate = listing.is_private === true || listing.private_listing === true; if (isPrivate) throw new ActiveListingsError("private_listing_not_in_public_snapshot");
  return { orderHash, nftId: `${ACTIVE_LISTINGS_CHAIN}/${ACTIVE_LISTINGS_CONTRACT}/${tokenId}`, chain: ACTIVE_LISTINGS_CHAIN, contractAddress: ACTIVE_LISTINGS_CONTRACT, tokenId, collectionSlug: ACTIVE_LISTINGS_COLLECTION, sellerAddress, price: { raw: rawPrice, normalizedDecimalString: decimalPrice(rawPrice, decimals), currency, decimals }, listingStartAt, expirationAt, orderCreatedAt, protocolAddress: text(listing.protocol_address), protocolName: typeof parameters.orderType === "string" ? text(parameters.orderType) : text(parameters.protocol_name), isPrivate, rawListing: raw };
}

function parsePage(body: unknown): { listings: unknown[]; next: string | null } { if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ActiveListingsError("response_not_object"); const record = body as Record<string, unknown>; if (!Array.isArray(record.listings)) throw new ActiveListingsError("response_listings_array_missing"); if (record.next !== undefined && record.next !== null && typeof record.next !== "string") throw new ActiveListingsError("response_next_cursor_invalid"); return { listings: record.listings, next: typeof record.next === "string" && record.next.length > 0 ? record.next : null }; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(x-api-key|api[_-]?key|authorization)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 300); }
function duplicateFingerprint(listing: NormalizedActiveListing): string { return JSON.stringify({ orderHash: listing.orderHash, nftId: listing.nftId, chain: listing.chain, contractAddress: listing.contractAddress, tokenId: listing.tokenId, collectionSlug: listing.collectionSlug, sellerAddress: listing.sellerAddress, price: listing.price, listingStartAt: listing.listingStartAt, expirationAt: listing.expirationAt, orderCreatedAt: listing.orderCreatedAt, protocolAddress: listing.protocolAddress, protocolName: listing.protocolName, isPrivate: listing.isPrivate }); }

class NodeHttpsTransport {
  private readonly agent: Agent;
  private closed = false;
  constructor(options: { rejectUnauthorized?: boolean } = {}) { this.agent = new Agent({ keepAlive: false, ...options }); }
  async fetch(url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }): Promise<ActiveListingsResponse> {
    if (this.closed) throw new ActiveListingsError("http_transport_closed");
    const target = new URL(url);
    return await new Promise<ActiveListingsResponse>((resolve, reject) => {
      const requestHandle = request(target, { method: init.method, headers: init.headers, agent: this.agent, signal: init.signal }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            headers: { get: (name: string) => { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(", ") : value ?? null; } },
            text: async () => body,
          });
        });
        response.on("error", reject);
      });
      requestHandle.on("error", reject);
      requestHandle.end();
    });
  }
  close(): void { if (!this.closed) { this.closed = true; this.agent.destroy(); } }
}

export class ActiveListingsClient {
  private readonly fetchImpl: ActiveListingsFetch; private readonly sleep: (ms: number) => Promise<void>; private readonly random: () => number; private readonly policy: ActiveListingsPolicy; private readonly retryPolicy: ActiveListingsRetryPolicy; private readonly ownedTransport: NodeHttpsTransport | null; private readonly endpoint: string; private closed = false;
  constructor(private readonly options: ActiveListingsClientOptions) { if (!text(options.apiKey)) throw new Error("OPENSEA_API_KEY is required"); this.policy = validatePolicy(options.policy); this.retryPolicy = validateRetryPolicy(options.retryPolicy); this.endpoint = resolveEndpoint(options); const localTest = options[ACTIVE_LISTINGS_LOCAL_TEST_ENDPOINT] !== undefined; this.ownedTransport = options.dependencies?.fetch ? null : new NodeHttpsTransport(localTest ? { rejectUnauthorized: false } : {}); this.fetchImpl = requireFetch(options.dependencies?.fetch ?? this.ownedTransport?.fetch.bind(this.ownedTransport)); this.sleep = options.dependencies?.sleep ?? defaultSleep; this.random = options.dependencies?.random ?? Math.random; }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; let firstError: unknown = null; try { if (this.options.dependencies?.close) await this.options.dependencies.close(); } catch (error) { firstError = error; } try { this.ownedTransport?.close(); } catch (error) { if (firstError === null) firstError = error; } if (firstError !== null) throw firstError; }
  async fetchSnapshot(startedAt = new Date().toISOString(), sourceProvenance: Record<string, string> = {}): Promise<ActiveListingsSnapshotEvidence> {
    const completedAt = () => new Date().toISOString();
    const listings: NormalizedActiveListing[] = [];
    const rawPages: unknown[] = [];
    const seenHashes = new Map<string, NormalizedActiveListing>();
    const seenCursors = new Set<string>();
    const seenPageHashes = new Set<string>();
    const responseHashes: string[] = [];
    const pageAttemptDetails: ActiveListingsPageAttemptEvidence[] = [];
    const counters: ActiveListingsCounters = { observed: 0, normalized: 0, malformed: 0, unsupported: 0, duplicates: 0, conflicts: 0 };
    const errors: string[] = [];
    const warnings: string[] = [];
    let cursor: string | null = null;
    let pageAttempts = 0;
    let pagesFetched = 0;
    let httpAttempts = 0;
    let retryAttempts = 0;
    let nextCursor: string | null = null;

    while (pageAttempts < this.policy.maxPages && counters.observed < this.policy.maxListings) {
      if (pagesFetched > 0 && cursor !== null && this.policy.interPageDelayMs > 0) await this.sleep(this.policy.interPageDelayMs);
      pageAttempts += 1;
      try {
        const page = await this.fetchPageDetailed(cursor, pageAttempts);
        httpAttempts += page.httpAttempts;
        retryAttempts += page.retryAttempts;
        pagesFetched += 1;
        pageAttemptDetails.push(page.attemptDetail);
        rawPages.push(page.body);
        responseHashes.push(page.responseHash);
        if (seenPageHashes.has(page.pageFingerprint)) {
          errors.push("repeated_page_detected");
          return this.makeEvidence("PARTIAL", startedAt, completedAt(), pageAttempts, pagesFetched, httpAttempts, retryAttempts, counters, false, false, true, false, false, listings, rawPages, page.next, warnings, errors, responseHashes, sourceProvenance, pageAttemptDetails);
        }
        seenPageHashes.add(page.pageFingerprint);

        const remaining = this.policy.maxListings - counters.observed;
        const overflow = page.listings.length > remaining;
        const rows = overflow ? page.listings.slice(0, Math.max(0, remaining)) : page.listings;
        counters.observed += page.listings.length;
        for (const raw of rows) {
          try {
            const normalized = normalizeActiveListing(raw);
            counters.normalized += 1;
            const previous = seenHashes.get(normalized.orderHash);
            if (previous) {
              if (duplicateFingerprint(previous) === duplicateFingerprint(normalized)) {
                counters.duplicates += 1;
                warnings.push("duplicate_equivalent_order_hash");
              } else {
                counters.conflicts += 1;
                errors.push("duplicate_conflicting_order_hash");
              }
              continue;
            }
            seenHashes.set(normalized.orderHash, normalized);
            listings.push(normalized);
          } catch (error) {
            const reason = safeError(error);
            if (reason.includes("unsupported_non_item_or_criteria") || reason.includes("private_listing")) counters.unsupported += 1;
            else counters.malformed += 1;
            errors.push(reason);
          }
        }
        nextCursor = page.next;
        if (counters.conflicts > 0 || counters.malformed > 0 || counters.unsupported > 0) return this.makeEvidence("UNSAFE", startedAt, completedAt(), pageAttempts, pagesFetched, httpAttempts, retryAttempts, counters, false, false, false, false, false, listings, rawPages, nextCursor, warnings, errors, responseHashes, sourceProvenance, pageAttemptDetails);
        if (overflow) {
          errors.push("maxListings_reached_before_api_exhaustion");
          return this.makeEvidence("PARTIAL", startedAt, completedAt(), pageAttempts, pagesFetched, httpAttempts, retryAttempts, counters, false, false, false, false, true, listings, rawPages, nextCursor, warnings, errors, responseHashes, sourceProvenance, pageAttemptDetails);
        }
        if (!page.next) return this.makeEvidence("COMPLETE", startedAt, completedAt(), pageAttempts, pagesFetched, httpAttempts, retryAttempts, counters, true, false, false, false, false, listings, rawPages, null, warnings, errors, responseHashes, sourceProvenance, pageAttemptDetails);
        if (seenCursors.has(page.next)) {
          errors.push("cursor_cycle_detected");
          return this.makeEvidence("PARTIAL", startedAt, completedAt(), pageAttempts, pagesFetched, httpAttempts, retryAttempts, counters, false, true, false, false, false, listings, rawPages, page.next, warnings, errors, responseHashes, sourceProvenance, pageAttemptDetails);
        }
        seenCursors.add(page.next);
        cursor = page.next;
      } catch (error) {
        if (error instanceof ActiveListingsPageError) { httpAttempts += error.httpAttempts; retryAttempts += error.retryAttempts; pageAttemptDetails.push(error.detail); }
        errors.push(safeError(error));
        return this.makeEvidence(pagesFetched === 0 ? "FAILED" : "PARTIAL", startedAt, completedAt(), pageAttempts, pagesFetched, httpAttempts, retryAttempts, counters, false, false, false, false, false, listings, rawPages, nextCursor, warnings, errors, responseHashes, sourceProvenance, pageAttemptDetails);
      }
    }
    const byPages = pageAttempts >= this.policy.maxPages && Boolean(nextCursor);
    const byListings = counters.observed >= this.policy.maxListings && Boolean(nextCursor);
    errors.push(byPages ? "maxPages_reached_before_api_exhaustion" : "maxListings_reached_before_api_exhaustion");
    return this.makeEvidence("PARTIAL", startedAt, completedAt(), pageAttempts, pagesFetched, httpAttempts, retryAttempts, counters, false, false, false, byPages, byListings, listings, rawPages, nextCursor, warnings, errors, responseHashes, sourceProvenance, pageAttemptDetails);
  }
  private makeEvidence(result: ActiveListingsSnapshotEvidence["result"], startedAt: string, completedAt: string, pageAttempts: number, pagesFetched: number, httpAttempts: number, retryAttempts: number, counters: ActiveListingsCounters, paginationExhausted: boolean, cursorCycleDetected: boolean, repeatedPageDetected: boolean, truncatedByPageLimit: boolean, truncatedByListingLimit: boolean, listings: NormalizedActiveListing[], rawPages: unknown[], nextCursor: string | null, warnings: string[], errors: string[], responseHashes: string[], sourceProvenance: Record<string, string>, pageAttemptDetails: ActiveListingsPageAttemptEvidence[]): ActiveListingsSnapshotEvidence { return { result, startedAt, completedAt, endpoint: ACTIVE_LISTINGS_ENDPOINT, collectionSlug: ACTIVE_LISTINGS_COLLECTION, expectedChain: ACTIVE_LISTINGS_CHAIN, expectedContract: ACTIVE_LISTINGS_CONTRACT, pageAttempts, pagesFetched, httpAttempts, retryAttempts, pageAttemptDetails, counters, paginationExhausted, cursorCycleDetected, repeatedPageDetected, truncatedByPageLimit, truncatedByListingLimit, listings, rawPages, nextCursor, warnings, errors, responseHashes, sourceProvenance }; }
  private async fetchPageDetailed(cursor: string | null, logicalPage: number): Promise<{ listings: unknown[]; next: string | null; body: unknown; responseHash: string; pageFingerprint: string; httpAttempts: number; retryAttempts: number; attemptDetail: ActiveListingsPageAttemptEvidence }> {
    const url = new URL(this.endpoint);
    url.searchParams.set("limit", String(this.policy.pageLimit));
    url.searchParams.set("include_private_listings", "false");
    if (cursor) url.searchParams.set("next", cursor);
    let httpAttempts = 0;
    let retryAttempts = 0;
    let retryAfterUsed = false;
    const waitMs: number[] = [];
    const detail = (successful: boolean, finalStatus: number | null, error: string | null): ActiveListingsPageAttemptEvidence => ({ logicalPage, httpAttempts, retryAttempts, successful, finalStatus, error, retryAfterUsed, waitMs: [...waitMs] });
    for (let retry = 0; retry <= this.retryPolicy.maxRetries; retry += 1) {
      httpAttempts += 1;
      if (retry > 0) retryAttempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.policy.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(url.toString(), { method: "GET", headers: { Accept: "application/json", "X-API-KEY": this.options.apiKey }, signal: controller.signal });
        const bodyText = await response.text();
        if (response.ok) {
          let body: unknown;
          try { body = JSON.parse(bodyText); } catch { throw new ActiveListingsError("response_json_invalid"); }
          const parsed = parsePage(body);
          return { ...parsed, body, responseHash: sha256(bodyText), pageFingerprint: sha256(JSON.stringify(parsed.listings)), httpAttempts, retryAttempts, attemptDetail: detail(true, response.status, null) };
        }
        const retryable = TRANSIENT_STATUSES.has(response.status);
        if (!retryable || retry === this.retryPolicy.maxRetries) throw new ActiveListingsError(`http_${response.status}`, retryable, response.status);
        const retryAfter = response.headers.get("retry-after") ?? response.headers.get("Retry-After");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const base = Math.min(this.retryPolicy.maxDelayMs, this.retryPolicy.baseDelayMs * 2 ** retry);
        const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.min(this.retryPolicy.maxDelayMs, Math.trunc(seconds * 1000)) : Math.trunc(Math.min(this.retryPolicy.maxDelayMs, base + base * this.retryPolicy.jitterRatio * this.random()));
        if (Number.isFinite(seconds) && seconds >= 0) retryAfterUsed = true;
        waitMs.push(delay);
        await this.sleep(delay);
      } catch (error) {
        if (error instanceof ActiveListingsError && (!error.retryable || retry === this.retryPolicy.maxRetries)) throw new ActiveListingsPageError(error.message, error.retryable, error.status, httpAttempts, retryAttempts, detail(false, error.status, error.message));
        if (retry === this.retryPolicy.maxRetries) throw new ActiveListingsPageError("network_or_timeout_failure", true, null, httpAttempts, retryAttempts, detail(false, null, "network_or_timeout_failure"));
        const delay = this.retryPolicy.baseDelayMs;
        waitMs.push(delay);
        await this.sleep(delay);
      } finally { clearTimeout(timer); }
    }
    throw new ActiveListingsPageError("retry_exhausted", true, null, httpAttempts, retryAttempts, detail(false, null, "retry_exhausted"));
  }
}

export interface ActiveListingsSourceFile { path: string; sha256: string; }
export async function writeActiveListingsEvidenceExclusive(path: string, evidence: ActiveListingsSnapshotEvidence, sourceFiles: readonly ActiveListingsSourceFile[]): Promise<void> {
  const sorted = [...sourceFiles].sort((left, right) => left.path.localeCompare(right.path));
  const seen = new Set<string>();
  for (const file of sorted) {
    if (!file.path || seen.has(file.path)) throw new Error("duplicate_or_empty_source_path");
    if (!/^[0-9a-f]{64}$/i.test(file.sha256)) throw new Error("invalid_source_sha256");
    let actualSha256: string;
    try { actualSha256 = await sha256File(file.path); } catch { throw new Error("source_file_missing_or_hash_mismatch"); }
    if (actualSha256 !== file.sha256.toLowerCase()) throw new Error("source_file_missing_or_hash_mismatch");
    seen.add(file.path);
  }
  const output = { ...evidence, sourceProvenance: Object.fromEntries(sorted.map((file) => [file.path, file.sha256.toLowerCase()])) };
  const handle = await open(path, "wx");
  try { await handle.writeFile(`${JSON.stringify(output, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
}
export async function sha256File(path: string): Promise<string> { return sha256(await readFile(path, "utf8")); }
