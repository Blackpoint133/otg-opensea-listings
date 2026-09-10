import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { finalizeJournalEvent, journalInputFromOrderEvent, insertJournalEvent } from "../src/db/eventJournalRepository.js";
import { REST_TRANSFER_AMBIGUOUS_APPLY_RESULT, applyNormalizedEvent, applyNormalizedEventInTransaction } from "../src/db/eventApplicationService.js";
import { extractInboxJournalEnvelope, persistRawEventToInbox, persistRawEventToInboxInTransaction } from "../src/db/durableInboxRepository.js";
import { applyPendingInboxEvent, applyPendingInboxEventInTransaction, finalizeRestTransferAmbiguousNoState } from "../src/db/pendingInboxApplicationService.js";
import { adaptRestEventToDurableIngress } from "../src/backfill/restEventAdapter.js";
import { acquireOrderTransactionLock, nftAdvisoryLockKey, orderAdvisoryLockKey } from "../src/db/advisoryLocks.js";
import { findActiveOrdersForNftForUpdate, upsertOrderState } from "../src/db/listingRepository.js";
import { upsertNftState } from "../src/db/nftStateRepository.js";
import { normalizeOrderEvent, normalizeTransferEvent, normalizeUnknownRevalidate } from "../src/state/normalizers.js";
import { reduceOrderState } from "../src/state/orderReducer.js";
import { reduceNftState } from "../src/state/nftReducer.js";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import type { NormalizedOrderEvent, OrderState } from "../src/state/types.js";

const root = path.resolve(import.meta.dirname, "fixtures");
const real = (name: string): any => JSON.parse(fs.readFileSync(path.join(root, "real", name), "utf8"));
const synthetic = (): any => JSON.parse(fs.readFileSync(path.join(root, "synthetic_order_revalidate_unknown_shape.json"), "utf8"));
const receivedAt = "2026-08-06T00:00:00.000Z";
const now = "2026-08-06T00:00:00.000Z";

class FakeClient implements TransactionClient {
  calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  duplicate = false;
  failOnUpsert = false;
  activeOrderRows: unknown[] = [];
  nftStateRows: unknown[] = [];
  journalFinalizeRowCount: number | null = 1;

  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [], rowCount: 1 };
    if (/INSERT INTO public\.opensea_listings_events_v2/.test(text)) {
      return { rows: (this.duplicate ? [] : [{ event_id: "1" }]) as Row[], rowCount: this.duplicate ? 0 : 1 };
    }
    if (/FROM public\.opensea_listings_v2/.test(text) && /order_hash = \$1/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM public\.opensea_listings_v2/.test(text) && /chain = \$1/.test(text)) return { rows: this.activeOrderRows as Row[], rowCount: this.activeOrderRows.length };
    if (/FROM public\.opensea_listings_nft_state_v2/.test(text)) return { rows: this.nftStateRows as Row[], rowCount: this.nftStateRows.length };
    if (this.failOnUpsert && /INSERT INTO public\.opensea_listings_v2/.test(text)) throw new Error("upsert failed");
    if (/UPDATE public\.opensea_listings_events_v2/.test(text)) return { rows: [], rowCount: this.journalFinalizeRowCount };
    return { rows: [], rowCount: 1 };
  }

  release(): void {
    this.released = true;
  }
}

class FakePool implements DbPool {
  constructor(public client: FakeClient) {}
  async connect(): Promise<TransactionClient> { return this.client; }
  async query<Row = unknown>(): Promise<QueryResult<Row>> { throw new Error("pool.query should not be used inside event transaction"); }
  async end(): Promise<void> {}
}

class DurableInboxClient implements TransactionClient {
  calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  failInsert = false;
  inserted = true;
  existingStatus = "pending";
  existingAttemptCount = 0;
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    if (this.failInsert && /INSERT INTO public\.opensea_listings_events_v2/.test(text)) throw new Error("inbox insert failed");
    if (/INSERT INTO public\.opensea_listings_events_v2/.test(text)) {
      return { rows: (this.inserted ? [{ event_id: "9001", processing_status: "pending", attempt_count: 0 }] : []) as Row[], rowCount: this.inserted ? 1 : 0 };
    }
    if (/FROM public\.opensea_listings_events_v2/.test(text) && /dedupe_key = \$1/.test(text)) {
      return { rows: [{ event_id: "42", processing_status: this.existingStatus, attempt_count: this.existingAttemptCount }] as Row[], rowCount: 1 };
    }
    return { rows: [] as Row[], rowCount: 1 };
  }
  release(): void { this.released = true; }
}

class DurableInboxPool implements DbPool {
  constructor(public client: DurableInboxClient) {}
  async connect(): Promise<TransactionClient> { return this.client; }
  async query<Row = unknown>(): Promise<QueryResult<Row>> { throw new Error("pool.query should not be used by durable inbox Tx A"); }
  async end(): Promise<void> {}
}

class PendingInboxClient implements TransactionClient {
  calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  failOnStateUpsert = false;
  finalStatus: string | null = null;
  failureMessage: string | null = null;
  restTransferConflictRows: unknown[] = [];
  constructor(public rawPayload: any, public status = "pending", public attemptCount = 0) {}

  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    if (/SELECT event_id::text,[\s\S]*FROM public\.opensea_listings_events_v2[\s\S]*FOR UPDATE/.test(text)) {
      return { rows: [{ event_id: "777", event_type: this.rawPayload?.event_type ?? "unknown", dedupe_key: "dedupe:777", raw_payload: this.rawPayload, processing_status: this.status, attempt_count: this.attemptCount }] as Row[], rowCount: 1 };
    }
    if (/UPDATE public\.opensea_listings_events_v2[\s\S]*SET processing_status = 'processing'/.test(text)) {
      this.status = "processing";
      this.attemptCount += 1;
      return { rows: [{ event_id: "777", event_type: this.rawPayload?.event_type ?? "unknown", dedupe_key: "dedupe:777", raw_payload: this.rawPayload, processing_status: "processing", attempt_count: this.attemptCount }] as Row[], rowCount: 1 };
    }
    if (/event_timestamp >= \$4::timestamptz/.test(text) && /event_timestamp < \(\$4::timestamptz \+ interval '1 second'\)/.test(text) && /transaction_hash <> \$5/.test(text) && /dedupe_key <> \$6/.test(text)) {
      return { rows: this.restTransferConflictRows as Row[], rowCount: this.restTransferConflictRows.length };
    }
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [], rowCount: 1 };
    if (/FROM public\.opensea_listings_v2/.test(text) && /order_hash = \$1/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM public\.opensea_listings_v2/.test(text) && /chain = \$1/.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM public\.opensea_listings_nft_state_v2/.test(text)) return { rows: [], rowCount: 0 };
    if (this.failOnStateUpsert && /INSERT INTO public\.(opensea_listings_v2|opensea_listings_nft_state_v2)/.test(text)) throw new Error("state repository password=secret failed");
    if (/INSERT INTO public\.(opensea_listings_v2|opensea_listings_nft_state_v2)/.test(text)) return { rows: [], rowCount: 1 };
    if (/UPDATE public\.opensea_listings_events_v2[\s\S]*SET processing_status = \$2/.test(text)) {
      this.finalStatus = values[1] as string;
      this.status = values[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE public\.opensea_listings_events_v2[\s\S]*SET processing_status = 'failed'/.test(text)) {
      this.finalStatus = "failed";
      this.failureMessage = values[3] as string;
      this.status = "failed";
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }
  release(): void { this.released = true; }
}

class PendingInboxPool implements DbPool {
  constructor(public client: PendingInboxClient) {}
  async connect(): Promise<TransactionClient> { return this.client; }
  async query<Row = unknown>(): Promise<QueryResult<Row>> { throw new Error("pool.query should not be used by pending inbox Tx B"); }
  async end(): Promise<void> {}
}

function order(name = "item_listed_ordinary.json"): NormalizedOrderEvent {
  const value = normalizeOrderEvent(real(name), receivedAt);
  assert.ok(value);
  return value;
}

function orderState(): OrderState {
  const result = reduceOrderState(null, order(), now);
  assert.ok(result.state);
  return result.state;
}

function orderRow(state: OrderState, orderHash = state.orderHash): Record<string, unknown> {
  return {
    order_hash: orderHash,
    nft_id: state.nft.nftId,
    chain: state.nft.chain,
    contract_address: state.nft.contractAddress,
    token_id: state.nft.tokenId,
    collection_slug: state.collectionSlug,
    seller_address: state.seller,
    price_raw: state.price?.raw ?? null,
    price_normalized: state.price?.normalizedDecimalString ?? null,
    payment_token_address: state.price?.tokenAddress ?? null,
    payment_token_symbol: state.price?.symbol ?? null,
    payment_token_decimals: state.price?.decimals ?? null,
    listing_start_at: state.listingStartAt,
    expiration_at: state.expirationAt,
    status: state.status,
    is_active: state.isActive,
    needs_reconciliation: state.needsReconciliation,
    reconciliation_reason: state.reconciliationReason,
    last_order_event_type: state.lastOrderEventType,
    last_order_event_timestamp: state.lastOrderEventTimestamp,
    last_order_event_version: state.lastOrderEventVersion,
    last_nft_event_timestamp: state.lastNftEventTimestamp,
    last_nft_event_version: state.lastNftEventVersion,
    last_transfer_transaction_hash: state.lastTransferTransactionHash,
    item_name: state.item.name,
    image_url: state.item.imageUrl,
    permalink: state.item.permalink,
    source: state.source,
    last_stream_received_at: state.lastStreamReceivedAt,
    last_reconciled_at: state.lastReconciledAt,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    raw_last_event: state.rawLastEvent
  };
}

function nftRowForTransfer(event: NormalizedOrderEvent | NormalizedTransferEvent, timestamp: string): Record<string, unknown> {
  assert.ok(event.nft);
  return {
    chain: event.nft.chain,
    contract_address: event.nft.contractAddress,
    token_id: event.nft.tokenId,
    nft_id: event.nft.nftId,
    collection_slug: "off-the-grid",
    current_owner_address: "0x0000000000000000000000000000000000000001",
    last_transfer_from_address: "0x0000000000000000000000000000000000000000",
    last_transfer_to_address: "0x0000000000000000000000000000000000000001",
    last_transfer_transaction_hash: "0xolder",
    last_transfer_at: timestamp,
    last_nft_event_timestamp: timestamp,
    last_nft_event_version: "999999999999999999",
    item_name: null,
    image_url: null,
    permalink: null,
    metadata_updated_at: null,
    created_at: now,
    updated_at: now
  };
}

function lockCalls(client: FakeClient): Array<{ text: string; values: readonly unknown[] }> {
  return client.calls.filter((call) => /pg_advisory/.test(call.text));
}

function inboxInsertCall(client: DurableInboxClient): { text: string; values: readonly unknown[] } {
  const call = client.calls.find((candidate) => /INSERT INTO public\.opensea_listings_events_v2/.test(candidate.text));
  assert.ok(call);
  return call;
}

function realShapeRestTransfer(overrides: Record<string, unknown> = {}): any {
  return {
    event_type: "transfer",
    event_timestamp: 1786618497,
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

function adaptedRestTransfer(overrides: Record<string, unknown> = {}): any {
  const result = adaptRestEventToDurableIngress(realShapeRestTransfer(overrides));
  assert.equal(result.outcome, "adapted");
  return result.rawEvent;
}

test("repository SQL references only final V2 table names", () => {
  const dbDir = path.resolve(import.meta.dirname, "..", "src", "db");
  const text = fs.readdirSync(dbDir).filter((name) => name.endsWith(".ts")).map((name) => fs.readFileSync(path.join(dbDir, name), "utf8")).join("\n");
  for (const table of ["public.opensea_listings_v2", "public.opensea_listings_nft_state_v2", "public.opensea_listings_events_v2"]) assert.match(text, new RegExp(table.replaceAll(".", "\\.")));
  assert.doesNotMatch(text, /public\.opensea_nft_state_v2/);
  assert.doesNotMatch(text, /public\.opensea_listing_events_v2/);
  assert.doesNotMatch(text, /public\.opensea_listings(?!_(?:v2|nft_state_v2|events_v2))/);
});

test("journal insert preserves null event_timestamp and separate received_at", async () => {
  const raw = synthetic();
  delete raw.payload.event_timestamp;
  const event = normalizeUnknownRevalidate(raw, receivedAt)!;
  const input = journalInputFromOrderEvent(event);
  const client = new FakeClient();
  const result = await insertJournalEvent(client, input);
  assert.equal(result.inserted, true);
  assert.equal(client.calls[0].values[1], null);
  assert.equal(client.calls[0].values[9], receivedAt);
  assert.notEqual(client.calls[0].values[1], client.calls[0].values[9]);
  assert.equal(client.calls[0].values[12], JSON.stringify(raw));
});

test("advisory lock SQL uses transaction scoped parameterized bigint locks", async () => {
  const client = new FakeClient();
  await acquireOrderTransactionLock(client, "0xABC");
  assert.equal(client.calls[0].text, "SELECT pg_advisory_xact_lock($1::bigint)");
  assert.doesNotMatch(client.calls[0].text, /pg_advisory_lock\(/);
  assert.equal(typeof client.calls[0].values[0], "string");
  assert.match(String(client.calls[0].values[0]), /^-?[0-9]+$/);
});

test("advisory lock keys are deterministic structured signed int64 strings", () => {
  const event = order();
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "db", "advisoryLocks.ts"), "utf8");
  assert.doesNotMatch(source, /\.join\(["']\|["']\)/);
  assert.equal(orderAdvisoryLockKey(event.orderHash!), orderAdvisoryLockKey(event.orderHash!));
  assert.notEqual(orderAdvisoryLockKey("0xabc"), orderAdvisoryLockKey("0xdef"));
  assert.equal(nftAdvisoryLockKey(event.nft!), nftAdvisoryLockKey({ ...event.nft!, contractAddress: event.nft!.contractAddress.toUpperCase() }));
  assert.notEqual(nftAdvisoryLockKey(event.nft!), nftAdvisoryLockKey({ ...event.nft!, tokenId: `${event.nft!.tokenId}1` }));
  assert.equal(typeof nftAdvisoryLockKey({ ...event.nft!, tokenId: "001" }), "string");
});

test("listing and transfer for the same NFT derive the same NFT advisory lock key", () => {
  const event = order();
  const transferEvent = normalizeTransferEvent(real("item_transferred_zero_source.json"), receivedAt)!;
  const sameTransfer = { ...transferEvent, nft: event.nft };
  assert.equal(nftAdvisoryLockKey(event.nft!), nftAdvisoryLockKey(sameTransfer.nft!));
  assert.notEqual(nftAdvisoryLockKey(event.nft!), nftAdvisoryLockKey({ ...event.nft!, tokenId: `${event.nft!.tokenId}9` }));
});

test("duplicate journal event commits no-op and does not reapply state", async () => {
  const client = new FakeClient();
  client.duplicate = true;
  const result = await applyNormalizedEvent(new FakePool(client), order(), now);
  assert.equal(result.result, "duplicate_ignored");
  assert.deepEqual(client.calls.map((c) => c.text.split(/\s+/)[0]), ["BEGIN", "SELECT", "SELECT", "INSERT", "COMMIT"]);
  assert.equal(client.calls.some((c) => /INSERT INTO public\.opensea_listings_v2/.test(c.text)), false);
  assert.equal(client.released, true);
});

test("internal transaction applicator performs no transaction control for duplicate", async () => {
  const client = new FakeClient();
  client.duplicate = true;
  const result = await applyNormalizedEventInTransaction(client, order(), now);
  assert.equal(result.result, "duplicate_ignored");
  assert.deepEqual(client.calls.map((c) => c.text.split(/\s+/)[0]), ["SELECT", "SELECT", "INSERT"]);
  assert.equal(client.calls.some((c) => /ROLLBACK|COMMIT|BEGIN/.test(c.text)), false);
});

test("one event application uses one transaction and finalizes journal", async () => {
  const client = new FakeClient();
  const result = await applyNormalizedEvent(new FakePool(client), order(), now);
  assert.equal(result.result, "applied");
  assert.equal(client.calls[0].text, "BEGIN");
  assert.match(client.calls.at(-1)!.text, /COMMIT/);
  assert.match(client.calls[1].text, /pg_advisory_xact_lock/);
  assert.match(client.calls[2].text, /pg_advisory_xact_lock/);
  assert.equal(client.calls.filter((c) => /INSERT INTO public\.opensea_listings_events_v2/.test(c.text)).length, 1);
  assert.equal(client.calls.filter((c) => /INSERT INTO public\.opensea_listings_v2/.test(c.text)).length, 1);
  assert.equal(client.calls.some((c) => /UPDATE public\.opensea_listings_events_v2/.test(c.text)), true);
});

test("internal transaction applicator performs no begin commit or rollback", async () => {
  const client = new FakeClient();
  const result = await applyNormalizedEventInTransaction(client, order(), now);
  assert.equal(result.result, "applied");
  assert.equal(client.calls.some((c) => c.text === "BEGIN" || c.text === "COMMIT" || c.text === "ROLLBACK"), false);
  assert.equal(lockCalls(client).length, 2);
  assert.equal(client.calls.some((c) => /UPDATE public\.opensea_listings_events_v2/.test(c.text)), true);
});

test("order events acquire NFT lock before order lock before journal insert and state read", async () => {
  const event = order();
  const client = new FakeClient();
  await applyNormalizedEventInTransaction(client, event, now);
  const nftKey = nftAdvisoryLockKey(event.nft!);
  const orderKey = orderAdvisoryLockKey(event.orderHash!);
  const texts = client.calls.map((call) => call.text);
  const nftLock = client.calls.findIndex((call) => call.values[0] === nftKey);
  const orderLock = client.calls.findIndex((call) => call.values[0] === orderKey);
  const journal = texts.findIndex((text) => /INSERT INTO public\.opensea_listings_events_v2/.test(text));
  const stateRead = texts.findIndex((text) => /FROM public\.opensea_listings_v2/.test(text) && /order_hash = \$1/.test(text));
  assert.ok(nftLock > -1);
  assert.ok(orderLock > nftLock);
  assert.ok(journal > orderLock);
  assert.ok(stateRead > journal);
});

test("order advisory lock is acquired before reading a nonexistent order row", async () => {
  const event = order();
  const client = new FakeClient();
  await applyNormalizedEventInTransaction(client, event, now);
  const orderLock = client.calls.findIndex((call) => call.values[0] === orderAdvisoryLockKey(event.orderHash!));
  const stateRead = client.calls.findIndex((call) => /FROM public\.opensea_listings_v2/.test(call.text) && /order_hash = \$1/.test(call.text));
  assert.ok(orderLock > -1 && stateRead > orderLock);
});

test("transaction rollback prevents partial state on repository error", async () => {
  const client = new FakeClient();
  client.failOnUpsert = true;
  await assert.rejects(() => applyNormalizedEvent(new FakePool(client), order(), now), /upsert failed/);
  assert.equal(client.calls[0].text, "BEGIN");
  assert.match(client.calls.at(-1)!.text, /ROLLBACK/);
  assert.equal(client.released, true);
});

test("journal finalization requires exactly one updated row", async () => {
  const ok = new FakeClient();
  await finalizeJournalEvent(ok, "1", "applied");
  const zero = new FakeClient();
  zero.journalFinalizeRowCount = 0;
  await assert.rejects(() => finalizeJournalEvent(zero, "1", "applied"), /expected 1 row, got 0/);
  const many = new FakeClient();
  many.journalFinalizeRowCount = 2;
  await assert.rejects(() => finalizeJournalEvent(many, "1", "applied"), /expected 1 row, got 2/);
});

test("order upsert maps reducer state columns explicitly without numeric Number conversion", async () => {
  const state = orderState();
  const client = new FakeClient();
  await upsertOrderState(client, state);
  const call = client.calls[0];
  assert.match(call.text, /INSERT INTO public\.opensea_listings_v2/);
  assert.doesNotMatch(call.text, /SELECT \*/i);
  assert.equal(call.values[7], state.price?.raw);
  assert.equal(call.values[8], state.price?.normalizedDecimalString);
  assert.equal(typeof call.values[8], "string");
  assert.equal(call.values[32], JSON.stringify(state.rawLastEvent));
});

test("repository SQL receives canonical business timestamps for journal and order state", async () => {
  const event = order("item_listed_ordinary.json");
  const client = new FakeClient();
  await insertJournalEvent(client, journalInputFromOrderEvent(event));
  assert.equal(client.calls[0].values[1], "2026-08-04T23:29:22.578Z");
  const state = reduceOrderState(null, event, now).state!;
  await upsertOrderState(client, state);
  const upsert = client.calls.find((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text))!;
  assert.equal(upsert.values[12], "2026-08-04T23:29:20.000Z");
  assert.equal(upsert.values[13], "2027-01-31T23:29:20.000Z");
  assert.equal(upsert.values[19], "2026-08-04T23:29:22.578Z");
  assert.notEqual(upsert.values[19], real("item_listed_ordinary.json").payload.event_timestamp);
});

test("repository NFT upsert receives normalized transfer timestamp instead of Unix seconds", async () => {
  const raw = real("item_transferred_zero_source.json");
  raw.payload.event_timestamp = "2026-08-11T04:21:07.000000Z";
  raw.payload.transaction.timestamp = "1786422067";
  const event = normalizeTransferEvent(raw, receivedAt)!;
  const state = reduceNftState(null, event, now).state!;
  const client = new FakeClient();
  await upsertNftState(client, state);
  const call = client.calls[0];
  assert.match(call.text, /INSERT INTO public\.opensea_listings_nft_state_v2/);
  assert.equal(call.values[9], "2026-08-11T04:21:07.000Z");
  assert.equal(call.values[10], "2026-08-11T04:21:07.000Z");
  assert.notEqual(call.values[9], "1786422067");
  assert.equal((event.rawPayload as any).payload.transaction.timestamp, "1786422067");
});

test("durable inbox Tx A owns one transaction and explicitly inserts pending lifecycle", async () => {
  const client = new DurableInboxClient();
  const raw = real("item_transferred_zero_source.json");
  raw.payload.event_timestamp = "2026-08-11T04:21:07.000000Z";
  raw.payload.transaction.timestamp = "1786422067";
  const before = structuredClone(raw);
  const result = await persistRawEventToInbox(new DurableInboxPool(client), raw, receivedAt);
  assert.equal(result.outcome, "inserted_pending");
  assert.equal(result.processingStatus, "pending");
  assert.equal(result.attemptCount, 0);
  assert.equal(client.calls[0].text, "BEGIN");
  assert.match(client.calls.at(-1)!.text, /COMMIT/);
  assert.equal(client.calls.some((call) => call.text === "ROLLBACK"), false);
  assert.equal(client.released, true);
  const insert = inboxInsertCall(client);
  assert.match(insert.text, /processing_status/);
  assert.match(insert.text, /attempt_count/);
  assert.match(insert.text, /apply_result,\s*applied_at/);
  assert.match(insert.text, /NULL,\s*NULL,\s*\$14,\s*\$15/);
  assert.equal(insert.values[13], "pending");
  assert.equal(insert.values[14], 0);
  assert.equal(insert.values[1], "2026-08-11T04:21:07.000Z");
  assert.equal(JSON.parse(insert.values[12] as string).payload.transaction.timestamp, "1786422067");
  assert.deepEqual(raw, before);
});

test("durable inbox Tx A rolls back and releases on insert error", async () => {
  const client = new DurableInboxClient();
  client.failInsert = true;
  await assert.rejects(() => persistRawEventToInbox(new DurableInboxPool(client), real("item_listed_ordinary.json"), receivedAt), /inbox insert failed/);
  assert.equal(client.calls[0].text, "BEGIN");
  assert.equal(client.calls.at(-1)!.text, "ROLLBACK");
  assert.equal(client.calls.some((call) => call.text === "COMMIT"), false);
  assert.equal(client.released, true);
});

test("durable inbox internal helper performs no transaction control", async () => {
  const client = new DurableInboxClient();
  await persistRawEventToInboxInTransaction(client, real("item_listed_ordinary.json"), receivedAt);
  assert.equal(client.calls.some((call) => call.text === "BEGIN" || call.text === "COMMIT" || call.text === "ROLLBACK"), false);
  assert.equal(client.released, false);
});

test("durable inbox duplicate preserves existing lifecycle metadata for every status", async () => {
  const statuses = ["pending", "processing", "applied", "reconciliation_required", "failed", "ignored_duplicate", "ignored_older"];
  for (const [index, status] of statuses.entries()) {
    const client = new DurableInboxClient();
    client.inserted = false;
    client.existingStatus = status;
    client.existingAttemptCount = index;
    const result = await persistRawEventToInbox(new DurableInboxPool(client), real("item_listed_ordinary.json"), receivedAt);
    assert.equal(result.outcome, "duplicate_existing");
    assert.equal(result.eventId, "42");
    assert.equal(result.processingStatus, status);
    assert.equal(result.attemptCount, index);
    assert.equal(client.calls.filter((call) => /INSERT INTO public\.opensea_listings_events_v2/.test(call.text)).length, 1);
    assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_v2|INSERT INTO public\.opensea_listings_nft_state_v2|pg_advisory_xact_lock|FOR UPDATE/.test(call.text)), false);
  }
});

test("durable inbox envelope accepts all contracted families and rejects unsupported family", () => {
  const fixtures = [
    real("item_listed_ordinary.json"),
    real("item_cancelled_1.json"),
    real("item_sold_1.json"),
    real("item_transferred_zero_source.json"),
    real("order_invalidate_1.json"),
    synthetic()
  ];
  const seen = new Map<string, string>();
  for (const fixture of fixtures) {
    const envelope = extractInboxJournalEnvelope(fixture, receivedAt);
    assert.ok(envelope);
    assert.equal(envelope.eventType, fixture.event_type);
    assert.equal(envelope.rawPayload, fixture);
    assert.equal(extractInboxJournalEnvelope(structuredClone(fixture), receivedAt)?.payloadHash, envelope.payloadHash);
    assert.equal(extractInboxJournalEnvelope(structuredClone(fixture), receivedAt)?.dedupeKey, envelope.dedupeKey);
    seen.set(envelope.eventType, envelope.dedupeKey);
  }
  assert.deepEqual([...seen.keys()].sort(), ["item_cancelled", "item_listed", "item_sold", "item_transferred", "order_invalidate", "order_revalidate"].sort());
  assert.equal(extractInboxJournalEnvelope({ event_type: "item_received_offer", payload: {} }, receivedAt), null);
});

test("durable inbox fallback dedupe is deterministic for incomplete identity", () => {
  const raw = real("item_listed_ordinary.json");
  delete raw.payload.order_hash;
  delete raw.payload.item.nft_id;
  const first = extractInboxJournalEnvelope(raw, receivedAt)!;
  const second = extractInboxJournalEnvelope(structuredClone(raw), "2030-01-01T00:00:00.000Z")!;
  assert.match(first.dedupeKey, /^order-fallback:v1:[a-f0-9]{64}$/);
  assert.equal(first.dedupeKey, second.dedupeKey);
});

test("durable inbox keeps EventVersion bigint-safe and does not use transfer transaction timestamp as state", () => {
  const raw = real("item_transferred_zero_source.json");
  raw.version = "9007199254740993";
  raw.payload.event_timestamp = "2026-08-11T04:21:07.000000Z";
  raw.payload.transaction.timestamp = "1786422067";
  const envelope = extractInboxJournalEnvelope(raw, receivedAt)!;
  assert.equal(envelope.eventVersion, "9007199254740993");
  assert.equal(envelope.eventTimestamp, "2026-08-11T04:21:07.000Z");
  assert.equal((envelope.rawPayload as any).payload.transaction.timestamp, "1786422067");
  assert.notEqual(envelope.eventTimestamp, "1786422067");
});

test("pending inbox Tx B owns one transaction and finalizes transfer reconciliation", async () => {
  const raw = real("item_transferred_zero_source.json");
  raw.payload.event_timestamp = "2026-08-11T04:21:07.000000Z";
  raw.payload.transaction.timestamp = "1786422067";
  const before = structuredClone(raw);
  const client = new PendingInboxClient(raw);
  const result = await applyPendingInboxEvent(new PendingInboxPool(client), "777", now);
  assert.equal(result.outcome, "reconciliation_required");
  assert.equal(result.processingStatus, "reconciliation_required");
  assert.equal(result.attemptCount, 1);
  assert.equal(result.applyResult, "inserted_nft_transfer;suppressed_orders=0");
  assert.equal(client.calls[0].text, "BEGIN");
  assert.equal(client.calls.at(-1)!.text, "COMMIT");
  assert.equal(client.calls.some((call) => call.text === "ROLLBACK"), false);
  assert.equal(client.released, true);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_events_v2/.test(call.text)), false);
  const processing = client.calls.find((call) => /processing_status = 'processing'/.test(call.text))!;
  assert.ok(processing);
  const finalize = client.calls.find((call) => /SET processing_status = \$2/.test(call.text))!;
  assert.equal(finalize.values[1], "reconciliation_required");
  assert.equal(finalize.values[3], "inserted_nft_transfer;suppressed_orders=0");
  assert.deepEqual(raw, before);
});

test("pending inbox Tx B gates ambiguous REST same-second null-version transfer before NFT state or order suppression", async () => {
  const raw = adaptedRestTransfer();
  const before = structuredClone(raw);
  const client = new PendingInboxClient(raw);
  client.restTransferConflictRows = [{ event_id: "778" }];
  const result = await applyPendingInboxEvent(new PendingInboxPool(client), "777", now);
  assert.equal(result.outcome, "reconciliation_required");
  assert.equal(result.processingStatus, "reconciliation_required");
  assert.equal(result.applyResult, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT);
  assert.equal(client.finalStatus, "reconciliation_required");
  const conflictSelect = client.calls.find((call) => /event_timestamp >= \$4::timestamptz/.test(call.text) && /event_timestamp < \(\$4::timestamptz \+ interval '1 second'\)/.test(call.text) && /transaction_hash <> \$5/.test(call.text) && /dedupe_key <> \$6/.test(call.text));
  assert.ok(conflictSelect);
  assert.equal(conflictSelect.values[0], "gunzilla");
  assert.equal(conflictSelect.values[3], "2026-08-13T10:54:57.000Z");
  assert.equal(conflictSelect.values[4], realShapeRestTransfer().transaction);
  assert.doesNotMatch(conflictSelect.text, /event_timestamp = \$4::timestamptz/);
  assert.equal(client.calls.some((call) => /FROM public\.opensea_listings_nft_state_v2/.test(call.text)), false);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_nft_state_v2/.test(call.text)), false);
  assert.equal(client.calls.some((call) => /FROM public\.opensea_listings_v2[\s\S]*is_active = true/.test(call.text)), false);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text)), false);
  assert.deepEqual(raw, before);
});

test("explicit REST ambiguous no-state finalization never reads NFT state or suppresses orders", async () => {
  const raw = adaptedRestTransfer();
  const client = new PendingInboxClient(raw);
  const result = await finalizeRestTransferAmbiguousNoState(new PendingInboxPool(client), "777", now);
  assert.equal(result.outcome, "reconciliation_required");
  assert.equal(result.applyResult, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT);
  assert.equal(client.finalStatus, "reconciliation_required");
  assert.equal(client.calls[0].text, "BEGIN");
  assert.match(client.calls.at(-1)!.text, /COMMIT/);
  assert.equal(client.calls.some((call) => /FROM public\.opensea_listings_nft_state_v2/.test(call.text)), false);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_nft_state_v2/.test(call.text)), false);
  assert.equal(client.calls.some((call) => /FROM public\.opensea_listings_v2[\s\S]*is_active = true/.test(call.text)), false);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text)), false);
});

test("pending inbox Tx B applies unambiguous REST transfer through normal NFT state path", async () => {
  const raw = adaptedRestTransfer();
  const client = new PendingInboxClient(raw);
  const result = await applyPendingInboxEvent(new PendingInboxPool(client), "777", now);
  assert.equal(result.outcome, "reconciliation_required");
  assert.equal(result.applyResult, "inserted_nft_transfer;suppressed_orders=0");
  assert.equal(client.calls.some((call) => /FROM public\.opensea_listings_nft_state_v2/.test(call.text)), true);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_nft_state_v2/.test(call.text)), true);
  assert.equal(client.calls.some((call) => /FROM public\.opensea_listings_v2[\s\S]*is_active = true/.test(call.text)), true);
});

test("ignored older NFT transfer skips active-order suppression entirely", async () => {
  const raw = real("item_transferred_zero_source.json");
  const active = orderState();
  raw.payload.item.nft_id = active.nft.nftId;
  const event = normalizeTransferEvent(raw, receivedAt)!;
  const client = new FakeClient();
  client.nftStateRows = [nftRowForTransfer(event, "2026-08-05T00:00:00.000Z")];
  client.activeOrderRows = [orderRow({ ...active, nft: event.nft! })];

  const result = await applyNormalizedEventInTransaction(client, event, now);

  assert.equal(result.applyResult, "ignored_older_transfer;suppressed_orders=0");
  assert.equal(client.calls.some((call) => /FROM public\.opensea_listings_v2[\s\S]*chain = \$1/.test(call.text)), false);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text)), false);
  assert.equal(client.calls.filter((call) => /FROM public\.opensea_listings_nft_state_v2/.test(call.text)).length, 1);
});

test("current transfer still suppresses one active order with exact fields", async () => {
  const raw = real("item_transferred_zero_source.json");
  const active = orderState();
  raw.payload.item.nft_id = active.nft.nftId;
  raw.payload.event_timestamp = "2026-08-06T00:00:02.000000Z";
  const event = normalizeTransferEvent(raw, receivedAt)!;
  const client = new FakeClient();
  client.activeOrderRows = [orderRow({ ...active, nft: event.nft! })];

  const result = await applyNormalizedEventInTransaction(client, event, now);
  const orderUpsert = client.calls.find((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text));

  assert.equal(result.applyResult, "inserted_nft_transfer;suppressed_orders=1");
  assert.ok(orderUpsert);
  assert.equal(orderUpsert.values[14], "active");
  assert.equal(orderUpsert.values[15], false);
  assert.equal(orderUpsert.values[16], true);
  assert.equal(orderUpsert.values[17], "transfer_observed");
  assert.equal(orderUpsert.values[21], event.eventTimestamp);
  assert.equal(orderUpsert.values[23], event.transactionHash);
  assert.equal(orderUpsert.values[6], active.seller);
});

test("current transfer suppresses two active orders and preserves zero-order result", async () => {
  const raw = real("item_transferred_wallet_to_wallet.json");
  const active = orderState();
  raw.payload.item.nft_id = active.nft.nftId;
  raw.payload.event_timestamp = "2026-08-06T00:00:03.000000Z";
  const event = normalizeTransferEvent(raw, receivedAt)!;
  const client = new FakeClient();
  client.activeOrderRows = [
    orderRow({ ...active, nft: event.nft! }, "order-1"),
    orderRow({ ...active, nft: event.nft! }, "order-2")
  ];

  const result = await applyNormalizedEventInTransaction(client, event, now);
  assert.equal(result.applyResult, "inserted_nft_transfer;suppressed_orders=2");
  assert.equal(client.calls.filter((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text)).length, 2);

  const zeroOrders = new FakeClient();
  const zeroResult = await applyNormalizedEventInTransaction(zeroOrders, normalizeTransferEvent(real("item_transferred_zero_source.json"), receivedAt)!, now);
  assert.equal(zeroResult.applyResult, "inserted_nft_transfer;suppressed_orders=0");
  assert.equal(zeroOrders.calls.some((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text)), false);
});

test("pending inbox Tx B applies listing with NFT lock before ORDER lock and before state read", async () => {
  const raw = real("item_listed_ordinary.json");
  const event = normalizeOrderEvent(raw, now)!;
  const client = new PendingInboxClient(raw);
  const result = await applyPendingInboxEvent(new PendingInboxPool(client), "777", now);
  assert.equal(result.outcome, "applied");
  assert.equal(client.finalStatus, "applied");
  const nftLock = client.calls.findIndex((call) => call.values[0] === nftAdvisoryLockKey(event.nft!));
  const orderLock = client.calls.findIndex((call) => call.values[0] === orderAdvisoryLockKey(event.orderHash!));
  const stateRead = client.calls.findIndex((call) => /FROM public\.opensea_listings_v2/.test(call.text) && /order_hash = \$1/.test(call.text));
  const stateUpsert = client.calls.findIndex((call) => /INSERT INTO public\.opensea_listings_v2/.test(call.text));
  assert.ok(nftLock > -1);
  assert.ok(orderLock > nftLock);
  assert.ok(stateRead > orderLock);
  assert.ok(stateUpsert > stateRead);
  assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_events_v2/.test(call.text)), false);
});

test("pending inbox internal helper performs no transaction ownership", async () => {
  const client = new PendingInboxClient(real("item_listed_ordinary.json"));
  await applyPendingInboxEventInTransaction(client, "777", now);
  assert.equal(client.calls.some((call) => call.text === "BEGIN" || call.text === "COMMIT" || call.text === "ROLLBACK"), false);
  assert.equal(client.released, false);
});

test("pending inbox Tx B rolls back infrastructure errors and leaves conceptual pending durable", async () => {
  const client = new PendingInboxClient(real("item_listed_ordinary.json"));
  client.failOnStateUpsert = true;
  await assert.rejects(() => applyPendingInboxEvent(new PendingInboxPool(client), "777", now), /state repository password=secret failed/);
  assert.equal(client.calls[0].text, "BEGIN");
  assert.equal(client.calls.at(-1)!.text, "ROLLBACK");
  assert.equal(client.calls.some((call) => call.text === "COMMIT"), false);
  assert.equal(client.released, true);
  assert.equal(client.calls.some((call) => /SET processing_status = 'failed'/.test(call.text)), false);
});

test("pending inbox Tx B returns deterministic non-claim results for non-pending statuses", async () => {
  const cases = [
    ["processing", "already_processing"],
    ["applied", "already_finalized"],
    ["reconciliation_required", "already_finalized"],
    ["failed", "already_finalized"],
    ["ignored_duplicate", "already_finalized"],
    ["ignored_older", "already_finalized"]
  ] as const;
  for (const [status, outcome] of cases) {
    const client = new PendingInboxClient(real("item_listed_ordinary.json"), status, 4);
    const result = await applyPendingInboxEvent(new PendingInboxPool(client), "777", now);
    assert.equal(result.outcome, outcome);
    assert.equal(result.processingStatus, status);
    assert.equal(result.attemptCount, 4);
    assert.equal(client.calls.some((call) => /processing_status = 'processing'|INSERT INTO public\.opensea_listings_v2|INSERT INTO public\.opensea_listings_nft_state_v2|pg_advisory_xact_lock/.test(call.text)), false);
  }
});

test("pending inbox Tx B commits failed lifecycle for corrupt stored raw payload with sanitized error", async () => {
  const client = new PendingInboxClient({ event_type: "item_received_offer", password: "secret" });
  const result = await applyPendingInboxEvent(new PendingInboxPool(client), "777", now);
  assert.equal(result.outcome, "failed");
  assert.equal(result.processingStatus, "failed");
  assert.equal(result.errorCode, "normalization_failed");
  assert.equal(client.finalStatus, "failed");
  assert.equal(client.failureMessage, "stored raw event could not be normalized for state application");
  assert.doesNotMatch(client.failureMessage!, /secret/);
  assert.equal(client.calls.at(-1)!.text, "COMMIT");
});

test("pending inbox Tx B reconstructs all six contracted raw families from journal payload", async () => {
  const fixtures = [
    real("item_listed_ordinary.json"),
    real("item_cancelled_1.json"),
    real("item_sold_1.json"),
    real("item_transferred_zero_source.json"),
    real("order_invalidate_1.json"),
    synthetic()
  ];
  const outcomes = new Map<string, string>();
  for (const fixture of fixtures) {
    const client = new PendingInboxClient(structuredClone(fixture));
    const result = await applyPendingInboxEventInTransaction(client, "777", now);
    outcomes.set(fixture.event_type, result.outcome);
    assert.equal(client.calls.some((call) => /INSERT INTO public\.opensea_listings_events_v2/.test(call.text)), false);
  }
  assert.deepEqual([...outcomes.keys()].sort(), ["item_cancelled", "item_listed", "item_sold", "item_transferred", "order_invalidate", "order_revalidate"].sort());
});

test("pending inbox Tx B has no live wiring, retry loop, or recovery service", () => {
  const dbSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "db", "pendingInboxApplicationService.ts"), "utf8");
  const liveWriter = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "writer", "liveEventWriter.ts"), "utf8");
  const canary = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "liveCanary.ts"), "utf8");
  const streamProbe = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "streamProbe.ts"), "utf8");
  const index = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.doesNotMatch(`${liveWriter}\n${canary}\n${streamProbe}\n${index}`, /applyPendingInboxEvent|pendingInboxApplicationService/);
  assert.doesNotMatch(dbSource, /setInterval|setTimeout|while\s*\(|for\s*\(\s*;\s*;\s*\)|backoff|reclaim|startup/i);
});

test("DB bigint version mapper keeps event versions as strings without Number conversion", () => {
  const listingSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "db", "listingRepository.ts"), "utf8");
  const nftSource = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "db", "nftStateRepository.ts"), "utf8");
  assert.doesNotMatch(listingSource, /Number\(row\.last_(?:order|nft)_event_version\)/);
  assert.doesNotMatch(nftSource, /Number\(row\.last_nft_event_version\)/);
  assert.match(listingSource, /last_order_event_version::text AS last_order_event_version/);
  assert.match(nftSource, /last_nft_event_version::text AS last_nft_event_version/);
});

test("transfer active-order lookup is exact NFT scoped, not broad collection scoped", async () => {
  const client = new FakeClient();
  await findActiveOrdersForNftForUpdate(client, { chain: "gunzilla", contractAddress: "0xabc", tokenId: "123" });
  const call = client.calls[0];
  assert.match(call.text, /WHERE chain = \$1\s+AND contract_address = \$2\s+AND token_id = \$3/);
  assert.match(call.text, /status = 'active'/);
  assert.match(call.text, /is_active = true/);
  assert.match(call.text, /FOR UPDATE/);
  assert.doesNotMatch(call.text, /collection_slug =/);
});

test("transfer application updates NFT state and only exact active order query in one transaction", async () => {
  const event = normalizeTransferEvent(real("item_transferred_zero_source.json"), receivedAt)!;
  const client = new FakeClient();
  const result = await applyNormalizedEvent(new FakePool(client), event, now);
  assert.equal(result.result, "journaled_reconciliation_required");
  assert.equal(client.calls[0].text, "BEGIN");
  assert.match(client.calls[1].text, /pg_advisory_xact_lock/);
  assert.match(client.calls.at(-1)!.text, /COMMIT/);
  assert.equal(client.calls.some((c) => /INSERT INTO public\.opensea_listings_nft_state_v2/.test(c.text)), true);
  assert.equal(client.calls.some((c) => /chain = \$1\s+AND contract_address = \$2\s+AND token_id = \$3/.test(c.text)), true);
});

test("transfer acquires NFT lock before journal insert and NFT state read", async () => {
  const event = normalizeTransferEvent(real("item_transferred_zero_source.json"), receivedAt)!;
  const client = new FakeClient();
  await applyNormalizedEventInTransaction(client, event, now);
  const nftLock = client.calls.findIndex((call) => call.values[0] === nftAdvisoryLockKey(event.nft!));
  const journal = client.calls.findIndex((call) => /INSERT INTO public\.opensea_listings_events_v2/.test(call.text));
  const nftRead = client.calls.findIndex((call) => /FROM public\.opensea_listings_nft_state_v2/.test(call.text));
  assert.ok(nftLock > -1);
  assert.ok(journal > nftLock);
  assert.ok(nftRead > journal);
});

test("invalidate-only event can persist reducer tombstone when identity satisfies V2 NOT NULL columns", async () => {
  const event = order("order_invalidate_1.json");
  const client = new FakeClient();
  const result = await applyNormalizedEvent(new FakePool(client), event, now);
  assert.equal(result.result, "journaled_reconciliation_required");
  const upsert = client.calls.find((c) => /INSERT INTO public\.opensea_listings_v2/.test(c.text));
  assert.ok(upsert);
  assert.equal(upsert.values[0], event.orderHash);
  assert.equal(upsert.values[1], event.nft?.nftId);
  assert.equal(upsert.values[5], "off-the-grid");
  assert.equal(upsert.values[14], "invalidated");
});

test("revalidate remains conservative and can be journal-only when state identity is insufficient", async () => {
  const raw = synthetic();
  delete raw.payload.event_timestamp;
  raw.payload.order_hash = null;
  const event = normalizeUnknownRevalidate(raw, receivedAt)!;
  const client = new FakeClient();
  const result = await applyNormalizedEvent(new FakePool(client), event, now);
  assert.equal(result.result, "journaled_reconciliation_required");
  assert.equal(result.stateChanged, false);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(client.calls.some((c) => /INSERT INTO public\.opensea_listings_v2/.test(c.text)), false);
});
