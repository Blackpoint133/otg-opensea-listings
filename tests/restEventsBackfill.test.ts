import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { extractInboxJournalEnvelope } from "../src/db/durableInboxRepository.js";
import { adaptRestEventToDurableIngress } from "../src/backfill/restEventAdapter.js";
import { PRODUCTION_REST_TRANSFER_EVENT_TYPES, backfillWindowWithOverlap, runRestEventsBackfillWindow, validateBackfillWindow } from "../src/backfill/restEventsBackfill.js";
import { DEFAULT_REST_BACKFILL_POLICY, RestEventsClient, RestEventsClientError } from "../src/backfill/restEventsClient.js";
import { OPENSEA_REST_COLLECTION_EVENTS_ENDPOINT, type RestEventsPage } from "../src/backfill/types.js";
import type { DurableInboxPersistResult } from "../src/db/types.js";
import { normalizeTransferEvent } from "../src/state/normalizers.js";
import { reduceNftState } from "../src/state/nftReducer.js";
import { isSameSecondRestTransferAmbiguity, restTransferAmbiguityKey } from "../src/db/eventApplicationService.js";

const receivedAt = "2026-08-13T12:00:00.000Z";
const root = path.resolve(import.meta.dirname, "fixtures", "real");
const real = (name: string): any => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

class HeadersMap {
  constructor(private readonly values: Record<string, string> = {}) {}
  get(name: string): string | null {
    return this.values[name] ?? this.values[name.toLowerCase()] ?? null;
  }
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new HeadersMap(headers),
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function page(events: unknown[], next: string | null = null): RestEventsPage {
  return {
    events,
    next,
    httpStatus: 200,
    literalResponseText: JSON.stringify({ asset_events: events, next }),
    literalResponseSha256: "test-sha",
    literalResponseByteLength: Buffer.byteLength(JSON.stringify({ asset_events: events, next }), "utf8"),
    rateLimit: { limit: null, remaining: null, reset: null, retryAfter: null },
    retries: 0,
    rateLimitedResponses: 0
  };
}

function persist(outcome: "inserted_pending" | "duplicate_existing", calls: unknown[]): (rawEvent: unknown, at: string) => Promise<DurableInboxPersistResult> {
  return async (rawEvent, at) => {
    calls.push({ rawEvent, at });
    const envelope = extractInboxJournalEnvelope(rawEvent, at)!;
    return { outcome, eventId: String(calls.length), dedupeKey: envelope.dedupeKey, eventType: envelope.eventType, orderHash: envelope.orderHash, nftId: envelope.nftId, processingStatus: "pending", attemptCount: 0 };
  };
}

function streamListing(): any {
  const event = real("item_listed_ordinary.json");
  event.payload.item.nft_id = "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/9007199254740993";
  event.payload.order_hash = "0x1111111111111111111111111111111111111111111111111111111111111111";
  event.version = "1786422067000";
  event.payload.event_timestamp = "2026-08-11T04:21:07.000Z";
  event.payload.maker.address = "0x2222222222222222222222222222222222222222";
  event.payload.base_price = "1234500000000000000";
  event.payload.payment_token.decimals = 18;
  event.payload.listing_date = "2026-08-11T04:21:07.000Z";
  event.payload.expiration_date = "2026-08-12T04:21:07.000Z";
  return event;
}

function streamSale(): any {
  const event = real("item_sold_1.json");
  event.payload.item.nft_id = "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/9007199254740994";
  event.payload.order_hash = "0x3333333333333333333333333333333333333333333333333333333333333333";
  event.version = "1786422068000";
  event.payload.event_timestamp = "2026-08-11T04:21:08.000Z";
  event.payload.maker.address = "0x4444444444444444444444444444444444444444";
  event.payload.taker = { address: "0x5555555555555555555555555555555555555555" };
  event.payload.sale_price = "2000000000000000000";
  event.payload.payment_token.decimals = 18;
  event.payload.transaction = { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  return event;
}

function streamTransfer(): any {
  const event = real("item_transferred_zero_source.json");
  event.payload.item.nft_id = "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/9007199254740995";
  event.version = "1786422069000";
  event.payload.event_timestamp = "2026-08-11T04:21:09.000Z";
  event.payload.from_account.address = "0x0000000000000000000000000000000000000000";
  event.payload.to_account.address = "0x6666666666666666666666666666666666666666";
  event.payload.transaction.hash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  event.payload.transaction.timestamp = "1786422069";
  return event;
}

function restListing(): any {
  return {
    event_type: "listing",
    version: "1786422067000",
    event_timestamp: "2026-08-11T04:21:07.000Z",
    order_hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    nft: { identifier: "9007199254740993", contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", name: "OTG #1" },
    seller: { address: "0x2222222222222222222222222222222222222222" },
    price: "1234500000000000000",
    payment_token: { address: "0x7777777777777777777777777777777777777777", symbol: "GUN", decimals: 18 },
    listing_date: "2026-08-11T04:21:07.000Z",
    expiration_date: "2026-08-12T04:21:07.000Z"
  };
}

function restSale(): any {
  return {
    event_type: "sale",
    version: "1786422068000",
    event_timestamp: "2026-08-11T04:21:08.000Z",
    order_hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
    nft: { identifier: "9007199254740994", contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" },
    seller: { address: "0x4444444444444444444444444444444444444444" },
    buyer: { address: "0x5555555555555555555555555555555555555555" },
    sale_price: "2000000000000000000",
    payment_token: { decimals: 18 },
    transaction: { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  };
}

function restTransfer(): any {
  return {
    event_type: "transfer",
    version: "1786422069000",
    event_timestamp: "2026-08-11T04:21:09.000Z",
    chain: "gunzilla",
    transfer_type: "transfer",
    nft: { identifier: "9007199254740995", contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" },
    from: { address: "0x0000000000000000000000000000000000000000" },
    to: { address: "0x6666666666666666666666666666666666666666" },
    transaction: { hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", timestamp: "1786422069" }
  };
}

function realShapeRestTransfer(overrides: Record<string, unknown> = {}): any {
  return {
    event_type: "transfer",
    event_timestamp: 1786618795,
    transaction: "0x3af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3",
    chain: "gunzilla",
    transfer_type: "transfer",
    from_address: "0xb93a9f4a1b41cb81b023b4efa7b6790c42f0437b",
    to_address: "0xf825620abf4f5e1d501dfc6f8f836846b5d7a3fc",
    nft: {
      identifier: "26224807",
      collection: "off-the-grid",
      contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271",
      token_standard: "erc721"
    },
    quantity: 1,
    ...overrides
  };
}

function streamTransferEquivalentToRealShape(): any {
  const event = real("item_transferred_zero_source.json");
  event.payload.item.nft_id = "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/26224807";
  event.version = "1786618795000";
  event.payload.event_timestamp = "2026-08-13T10:59:55.000Z";
  event.payload.from_account.address = "0xb93a9f4a1b41cb81b023b4efa7b6790c42f0437b";
  event.payload.to_account.address = "0xf825620abf4f5e1d501dfc6f8f836846b5d7a3fc";
  event.payload.transaction.hash = "0x3af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3";
  event.payload.transaction.timestamp = "1786618795";
  return event;
}

function adapted(rawRest: unknown): any {
  const result = adaptRestEventToDurableIngress(rawRest);
  assert.equal(result.outcome, "adapted");
  return result.rawEvent;
}

test("REST client uses collection endpoint, query window, event filters, header API key, and no URL secret", async () => {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const client = new RestEventsClient({
    apiKey: "secret-key",
    dependencies: {
      fetch: async (url, init) => {
        urls.push(url);
        headers.push(init.headers);
        return response(200, { asset_events: [], next: null });
      }
    }
  });
  await client.fetchCollectionEventsPage({ after: 10, before: 20, limit: 200, cursor: "abc" });
  const url = new URL(urls[0]);
  assert.equal(`${url.origin}${url.pathname}`, OPENSEA_REST_COLLECTION_EVENTS_ENDPOINT);
  assert.equal(url.searchParams.get("after"), "10");
  assert.equal(url.searchParams.get("before"), "20");
  assert.equal(url.searchParams.get("limit"), "200");
  assert.equal(url.searchParams.get("next"), "abc");
  assert.deepEqual(url.searchParams.getAll("event_type"), ["listing", "sale", "transfer"]);
  assert.equal(headers[0]["X-API-KEY"], "secret-key");
  assert.doesNotMatch(urls[0], /secret-key/);
});

test("REST client validates responses, retries 429 Retry-After and 500/network timeouts without secret leakage", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new RestEventsClient({
    apiKey: "secret-key",
    retryPolicy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1_000, jitterRatio: 0 },
    dependencies: {
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: async () => {
        calls += 1;
        if (calls === 1) return response(429, { error: "password=bad" }, { "Retry-After": "2" });
        if (calls === 2) return response(500, { error: "temporary" });
        return response(200, { asset_events: [restTransfer()], next: null }, { "X-RateLimit-Remaining": "9" });
      }
    }
  });
  const page = await client.fetchCollectionEventsPage({ after: 1, before: 2 });
  assert.equal(page.events.length, 1);
  assert.equal(page.retries, 2);
  assert.equal(page.rateLimitedResponses, 1);
  assert.deepEqual(sleeps, [1000, 20]);
  await assert.rejects(
    () => new RestEventsClient({ apiKey: "secret-key", dependencies: { fetch: async () => response(200, { next: 123 }) } }).fetchCollectionEventsPage({ after: 1, before: 2 }),
    /event array/
  );
  await assert.rejects(
    () => new RestEventsClient({ apiKey: "secret-key", retryPolicy: { maxAttempts: 1 }, dependencies: { fetch: async () => { throw new Error("ETIMEDOUT api_key=secret-key"); } } }).fetchCollectionEventsPage({ after: 1, before: 2 }),
    (error: any) => error instanceof RestEventsClientError && !/secret-key/.test(error.message)
  );
});

test("window validation and overlap are bounded and second-based", () => {
  assert.deepEqual(backfillWindowWithOverlap(1_000, 2_000), { after: 700, before: 2_000 });
  assert.deepEqual(backfillWindowWithOverlap(100, 200, 300), { after: 0, before: 200 });
  assert.throws(() => validateBackfillWindow({ after: 1, before: 1 }, DEFAULT_REST_BACKFILL_POLICY), /after must be lower/);
  assert.throws(() => validateBackfillWindow({ after: -1, before: 1 }, DEFAULT_REST_BACKFILL_POLICY), /non-negative/);
  assert.throws(() => validateBackfillWindow({ after: 0, before: Number.MAX_SAFE_INTEGER }, DEFAULT_REST_BACKFILL_POLICY), /exceeds/);
});

test("coverage matrix is conservative for unsupported cancellation, invalidation, offers, mint and unknown", () => {
  for (const event_type of ["cancel", "order_invalidate", "order_revalidate", "offer", "trait_offer", "collection_offer", "mint", "unknown"]) {
    const result = adaptRestEventToDurableIngress({ event_type });
    assert.equal(result.outcome, "unsupported");
  }
  const malformed = adaptRestEventToDurableIngress({ event_type: "transfer", nft: { identifier: "1" } });
  assert.equal(malformed.outcome, "malformed");
});

test("REST adapter preserves raw source evidence and bigint-safe token/version strings", () => {
  const raw = restTransfer();
  const event = adapted(raw);
  assert.equal(event.event_type, "item_transferred");
  assert.equal(event.version, "1786422069000");
  assert.equal(typeof event.version, "string");
  assert.equal(event.payload.item.nft_id, "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/9007199254740995");
  assert.equal(event.payload.rest_backfill_source.source, "opensea_rest_events_backfill");
  assert.deepEqual(event.payload.rest_backfill_source.raw_event, raw);
  assert.doesNotMatch(JSON.stringify(event), /secret-key|api_key=/);
});

test("real-shape-derived REST transfer without version adapts with structured transfer dedupe", () => {
  const raw = realShapeRestTransfer();
  const event = adapted(raw);
  assert.equal(event.event_type, "item_transferred");
  assert.equal("version" in event, false);
  assert.equal(event.payload.event_timestamp, "2026-08-13T10:59:55.000Z");
  assert.equal(event.payload.item.nft_id, "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/26224807");
  assert.equal(event.payload.from_account.address, raw.from_address);
  assert.equal(event.payload.to_account.address, raw.to_address);
  assert.equal(event.payload.transaction.hash, raw.transaction);
  assert.equal(event.payload.transaction.timestamp, "2026-08-13T10:59:55.000Z");
  assert.deepEqual(event.payload.rest_backfill_source.raw_event, raw);
  assert.equal(event.payload.rest_backfill_source.raw_event.transfer_type, "transfer");
  const envelope = extractInboxJournalEnvelope(event, receivedAt)!;
  assert.equal(envelope.eventVersion, null);
  assert.equal(envelope.transactionHash, raw.transaction);
  assert.match(envelope.dedupeKey, /^transfer:v1:/);
  assert.doesNotMatch(envelope.dedupeKey, /fallback/);
});

test("real-shape-derived REST mint transfer canonicalizes from to zero while preserving raw owner-as-from evidence", () => {
  const raw = realShapeRestTransfer({
    transfer_type: "mint",
    from_address: "0x103853a69a3d954f07a6c2b0e2478abe71fa9d8d",
    to_address: "0x103853a69a3d954f07a6c2b0e2478abe71fa9d8d"
  });
  const event = adapted(raw);
  assert.equal(event.event_type, "item_transferred");
  assert.equal("version" in event, false);
  assert.equal(event.payload.from_account.address, "0x0000000000000000000000000000000000000000");
  assert.equal(event.payload.to_account.address, raw.to_address);
  assert.equal(event.payload.rest_backfill_source.raw_event.from_address, raw.from_address);
  assert.equal(event.payload.rest_backfill_source.canonical_mint_from_zero_source, true);
  assert.equal(event.payload.rest_backfill_source.transaction_timestamp_derived_from_event_timestamp, true);
  assert.equal(event.payload.rest_backfill_source.raw_event.transfer_type, "mint");
  const envelope = extractInboxJournalEnvelope(event, receivedAt)!;
  assert.match(envelope.dedupeKey, /^transfer:v1:/);
  assert.doesNotMatch(envelope.dedupeKey, /fallback/);
});

test("real-shape-derived REST transfer validates chain contract transaction transfer type and present version", () => {
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ chain: undefined })).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ chain: "ethereum" })).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ nft: { ...realShapeRestTransfer().nft, contract: undefined } })).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ nft: { ...realShapeRestTransfer().nft, contract: "0x1111111111111111111111111111111111111111" } })).outcome, "malformed");
  for (const transaction of [null, "abc", { value: realShapeRestTransfer().transaction }]) {
    const result = adaptRestEventToDurableIngress(realShapeRestTransfer({ transaction }));
    assert.equal(result.outcome, "malformed");
  }
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ transfer_type: "airdrop" })).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ transfer_type: undefined })).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ transfer_type: "mint", from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ version: "not-a-version" })).outcome, "malformed");
  const withVersion = adapted(realShapeRestTransfer({ version: "1786618795000" }));
  assert.equal(withVersion.version, "1786618795000");
});

test("real-shape-derived REST transfer keeps bigint token ids exact and rejects invalid timestamps", () => {
  const raw = realShapeRestTransfer({ nft: { ...realShapeRestTransfer().nft, identifier: "9007199254740995" } });
  const event = adapted(raw);
  assert.equal(event.payload.item.nft_id, "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/9007199254740995");
  assert.equal(extractInboxJournalEnvelope(event, receivedAt)!.tokenId, "9007199254740995");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ event_timestamp: "not-a-date" })).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress(realShapeRestTransfer({ event_timestamp: 9_007_199_254_740_995 })).outcome, "malformed");
});

test("supported REST listing, sale and transfer derive same dedupe identity as Stream equivalents", () => {
  const pairs = [
    [streamListing(), adapted(restListing())],
    [streamSale(), adapted(restSale())],
    [streamTransfer(), adapted(restTransfer())]
  ];
  for (const [stream, rest] of pairs) {
    const streamEnvelope = extractInboxJournalEnvelope(stream, receivedAt);
    const restEnvelope = extractInboxJournalEnvelope(rest, receivedAt);
    assert.ok(streamEnvelope);
    assert.ok(restEnvelope);
    assert.equal(restEnvelope.dedupeKey, streamEnvelope.dedupeKey);
    assert.equal(restEnvelope.rawPayload, rest);
  }
});

test("Stream version-present and real-shape REST version-absent transfer derive same structured dedupe key", () => {
  const stream = streamTransferEquivalentToRealShape();
  const rest = adapted(realShapeRestTransfer());
  const streamEnvelope = extractInboxJournalEnvelope(stream, receivedAt)!;
  const restEnvelope = extractInboxJournalEnvelope(rest, receivedAt)!;
  assert.match(restEnvelope.dedupeKey, /^transfer:v1:/);
  assert.equal(restEnvelope.eventVersion, null);
  assert.equal(streamEnvelope.eventVersion, "1786618795000");
  assert.equal(restEnvelope.dedupeKey, streamEnvelope.dedupeKey);
});

test("real-style Stream zero-source mint and REST owner-as-from mint canonicalize to equivalent event and dedupe", () => {
  const owner = "0xf825620abf4f5e1d501dfc6f8f836846b5d7a3fc";
  const stream = streamTransferEquivalentToRealShape();
  stream.payload.from_account.address = "0x0000000000000000000000000000000000000000";
  stream.payload.to_account.address = owner;
  const rest = adapted(realShapeRestTransfer({ transfer_type: "mint", from_address: owner, to_address: owner }));
  assert.equal(rest.payload.from_account.address, stream.payload.from_account.address);
  assert.equal(rest.payload.to_account.address, stream.payload.to_account.address);
  assert.equal(rest.payload.transaction.hash, stream.payload.transaction.hash);
  assert.equal(rest.payload.item.nft_id, stream.payload.item.nft_id);
  assert.equal(rest.payload.event_timestamp, stream.payload.event_timestamp);
  assert.equal(extractInboxJournalEnvelope(rest, receivedAt)!.dedupeKey, extractInboxJournalEnvelope(stream, receivedAt)!.dedupeKey);
});

test("query-profile source metadata does not affect real-shape transfer dedupe", () => {
  const keys = ["unfiltered", "transfer", "mint"].map((profile) => {
    const raw = realShapeRestTransfer({ probe_profile: profile });
    const event = adapted(raw);
    return extractInboxJournalEnvelope(event, receivedAt)!.dedupeKey;
  });
  assert.deepEqual([...new Set(keys)], [keys[0]]);
});

test("REST same-second null-version ambiguity classifier distinguishes different transactions from duplicates and unrelated events", () => {
  const a = normalizeTransferEvent(adapted(realShapeRestTransfer()), receivedAt)!;
  const differentTx = normalizeTransferEvent(adapted(realShapeRestTransfer({ transaction: "0x4af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" })), receivedAt)!;
  const differentTime = normalizeTransferEvent(adapted(realShapeRestTransfer({ event_timestamp: 1786618796, transaction: "0x5af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" })), receivedAt)!;
  const differentNft = normalizeTransferEvent(adapted(realShapeRestTransfer({ nft: { ...realShapeRestTransfer().nft, identifier: "26224808" }, transaction: "0x6af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" })), receivedAt)!;
  const withVersion = normalizeTransferEvent(adapted(realShapeRestTransfer({ version: "1786618795000", transaction: "0x7af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" })), receivedAt)!;
  const key = restTransferAmbiguityKey(a)!;
  assert.equal(isSameSecondRestTransferAmbiguity(key, restTransferAmbiguityKey(differentTx)!), true);
  assert.equal(isSameSecondRestTransferAmbiguity(key, restTransferAmbiguityKey(a)!), false);
  assert.equal(isSameSecondRestTransferAmbiguity(key, restTransferAmbiguityKey(differentTime)!), false);
  assert.equal(isSameSecondRestTransferAmbiguity(key, restTransferAmbiguityKey(differentNft)!), false);
  assert.equal(restTransferAmbiguityKey(withVersion), null);
});

test("future production transfer query plan uses only event_type transfer while diagnostic probe plan remains separate", () => {
  assert.deepEqual(PRODUCTION_REST_TRANSFER_EVENT_TYPES, ["transfer"]);
});

test("REST listing and sale still require version", () => {
  assert.equal(adaptRestEventToDurableIngress({ ...restListing(), version: undefined }).outcome, "malformed");
  assert.equal(adaptRestEventToDurableIngress({ ...restSale(), version: undefined }).outcome, "malformed");
});

test("REST-derived null-version transfer reduces NFT state deterministically with equal timestamps", () => {
  const firstRaw = adapted(realShapeRestTransfer());
  const first = normalizeTransferEvent(firstRaw, receivedAt)!;
  assert.equal(first.eventVersion, null);
  const firstResult = reduceNftState(null, first, "2026-08-13T12:00:01.000Z");
  assert.equal(firstResult.ignored, false);
  assert.equal(firstResult.state?.currentOwnerAddress, "0xf825620abf4f5e1d501dfc6f8f836846b5d7a3fc");
  assert.equal(firstResult.state?.lastNftEventVersion, null);
  assert.equal(firstResult.state?.lastTransferTransactionHash, realShapeRestTransfer().transaction);

  const secondRaw = adapted(realShapeRestTransfer({
    transaction: "0x4af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3",
    to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }));
  const second = normalizeTransferEvent(secondRaw, receivedAt)!;
  const secondResult = reduceNftState(firstResult.state, second, "2026-08-13T12:00:02.000Z");
  assert.equal(secondResult.ignored, false);
  assert.equal(secondResult.applyResult, "updated_nft_transfer");
  assert.equal(secondResult.state?.currentOwnerAddress, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(secondResult.state?.lastNftEventVersion, null);
});

test("Stream-first/REST-second and REST-first/Stream-second share one durable business identity", async () => {
  const stream = streamTransfer();
  const rest = adapted(restTransfer());
  const streamKey = extractInboxJournalEnvelope(stream, receivedAt)!.dedupeKey;
  const restKey = extractInboxJournalEnvelope(rest, receivedAt)!.dedupeKey;
  assert.equal(streamKey, restKey);
  const calls: unknown[] = [];
  const first = await persist("inserted_pending", calls)(stream, receivedAt);
  const second = await persist("duplicate_existing", calls)(rest, receivedAt);
  assert.equal(first.dedupeKey, second.dedupeKey);
  const reverseCalls: unknown[] = [];
  const reverseFirst = await persist("inserted_pending", reverseCalls)(rest, receivedAt);
  const reverseSecond = await persist("duplicate_existing", reverseCalls)(stream, receivedAt);
  assert.equal(reverseFirst.dedupeKey, reverseSecond.dedupeKey);
});

test("backfill paginates, detects cursor cycles and max bounds without claiming transport completion", async () => {
  const calls: unknown[] = [];
  const pages: RestEventsPage[] = [page([restTransfer()], "cursor-1"), { ...page([restTransfer()], "cursor-1"), retries: 1 }];
  const summary = await runRestEventsBackfillWindow({ window: { after: 1, before: 2 } }, { client: { fetchCollectionEventsPage: async () => pages.shift()! }, persistEvent: persist("inserted_pending", calls), now: () => receivedAt });
  assert.equal(summary.transportComplete, false);
  assert.equal(summary.cursorCycles, 1);
  assert.equal(summary.result, "BACKFILL_PARTIAL");
  assert.equal(summary.httpRetries, 1);

  const bounded = await runRestEventsBackfillWindow(
    { window: { after: 1, before: 2 }, policy: { maxEvents: 1 } },
    { client: { fetchCollectionEventsPage: async () => page([restTransfer(), restTransfer()], "more") }, persistEvent: persist("inserted_pending", []), now: () => receivedAt }
  );
  assert.equal(bounded.transportComplete, false);
  assert.match(bounded.errors.join("\n"), /maxEvents/);
});

test("same window rerun is idempotent through durable Tx A duplicate_existing results", async () => {
  const onePage = page([restListing(), restSale(), restTransfer()]);
  const firstCalls: unknown[] = [];
  const first = await runRestEventsBackfillWindow({ window: { after: 1, before: 2 } }, { client: { fetchCollectionEventsPage: async () => onePage }, persistEvent: persist("inserted_pending", firstCalls), now: () => receivedAt });
  assert.equal(first.result, "BACKFILL_COMPLETE");
  assert.equal(first.persistInsertedPending, 3);
  const secondCalls: unknown[] = [];
  const second = await runRestEventsBackfillWindow({ window: { after: 1, before: 2 } }, { client: { fetchCollectionEventsPage: async () => onePage }, persistEvent: persist("duplicate_existing", secondCalls), now: () => receivedAt });
  assert.equal(second.result, "BACKFILL_COMPLETE");
  assert.equal(second.persistDuplicateExisting, 3);
});

test("partial page failure keeps admitted evidence and returns partial transport result", async () => {
  const calls: unknown[] = [];
  let pageIndex = 0;
  const summary = await runRestEventsBackfillWindow(
    { window: { after: 1, before: 2 } },
    {
      client: {
        fetchCollectionEventsPage: async () => {
          pageIndex += 1;
          if (pageIndex === 1) return page([restTransfer()], "next");
          throw new Error("HTTP 500 api_key=secret-key");
        }
      },
      persistEvent: persist("inserted_pending", calls),
      now: () => receivedAt
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(summary.transportComplete, false);
  assert.equal(summary.result, "BACKFILL_PARTIAL");
  assert.doesNotMatch(summary.errors.join("\n"), /secret-key/);
});

test("transport complete and semantic coverage complete are separate dimensions", async () => {
  const calls: unknown[] = [];
  const summary = await runRestEventsBackfillWindow(
    { window: { after: 1, before: 2 } },
    { client: { fetchCollectionEventsPage: async () => page([restTransfer(), { event_type: "mint" }]) }, persistEvent: persist("inserted_pending", calls), now: () => receivedAt }
  );
  assert.equal(summary.transportComplete, true);
  assert.equal(summary.semanticCoverageComplete, false);
  assert.equal(summary.result, "BACKFILL_PARTIAL");
  assert.equal(summary.unsupportedTypeDistribution.mint, 1);
});

test("backfill source ends at durable Tx A boundary and does not import reducers or legacy atomic writer", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "backfill", "restEventsBackfill.ts"), "utf8")
    + fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "backfill", "restEventAdapter.ts"), "utf8");
  assert.doesNotMatch(source, /applyNormalizedEvent|upsertOrderState|upsertNftState|reduceOrderState|reduceNftState|LiveEventWriter|OpenSeaStreamClient/);
  assert.match(source, /persistRawEventToInbox/);
});
