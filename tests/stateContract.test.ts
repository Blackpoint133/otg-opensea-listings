import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compareEventVersions, normalizeBusinessTimestamp, normalizeDecimal, normalizeEventVersion, normalizeOrderEvent, normalizeTransferEvent, normalizeUnknownRevalidate } from "../src/state/normalizers.js";
import { orderDedupeKey, payloadHash, transferDedupeKey } from "../src/state/eventIdentity.js";
import { applyTransferToOrder, expireOrderState, isVisibleLiveListing, reduceOrderState } from "../src/state/orderReducer.js";
import { reduceNftState } from "../src/state/nftReducer.js";
import type { NormalizedOrderEvent, OrderState } from "../src/state/types.js";

const root = path.resolve(import.meta.dirname, "fixtures");
const real = (name: string): any => JSON.parse(fs.readFileSync(path.join(root, "real", name), "utf8"));
const synthetic = (): any => JSON.parse(fs.readFileSync(path.join(root, "synthetic_order_revalidate_unknown_shape.json"), "utf8"));
const receivedAt = "2026-08-06T00:00:00.000Z";
const now = "2026-08-06T00:00:00.000Z";
function order(name = "item_listed_ordinary.json"): NormalizedOrderEvent { const value = normalizeOrderEvent(real(name), receivedAt); assert.ok(value); return value; }
function transfer(name: string) { const value = normalizeTransferEvent(real(name), receivedAt); assert.ok(value); return value; }
function state(name = "item_listed_ordinary.json"): OrderState { const result = reduceOrderState(null, order(name), now); assert.ok(result.state); return result.state; }
function related(event: any, source: any): any { const copy = structuredClone(event); copy.payload.order_hash = source.payload.order_hash; copy.payload.item ??= {}; copy.payload.item.nft_id = source.payload.item.nft_id; return copy; }
function withTimestamp(event: any, timestamp: string): any { const copy = structuredClone(event); copy.payload.event_timestamp = timestamp; return copy; }
function migrationSql(): string { return fs.readFileSync(path.resolve(import.meta.dirname, "..", "sql", "001_create_v2_schema.sql"), "utf8"); }
function lifecycleMigrationSql(): string { return fs.readFileSync(path.resolve(import.meta.dirname, "..", "sql", "002_add_journal_processing_lifecycle.sql"), "utf8"); }
function pgHarnessSource(): string { return fs.readFileSync(path.resolve(import.meta.dirname, "..", "scripts", "testDurableInboxPg.ts"), "utf8"); }

test("SQL migration file exists", () => assert.equal(fs.existsSync(path.resolve(import.meta.dirname, "..", "sql", "001_create_v2_schema.sql")), true));
test("migration contains exactly the three required table names", () => { const sql = migrationSql(); for (const table of ["public.opensea_listings_v2", "public.opensea_listings_nft_state_v2", "public.opensea_listings_events_v2"]) assert.equal((sql.match(new RegExp(`CREATE TABLE ${table.replaceAll(".", "\\.")}`, "g")) ?? []).length, 1); });
test("migration excludes both obsolete table names", () => { const sql = migrationSql(); assert.doesNotMatch(sql, /public\.opensea_nft_state_v2/); assert.doesNotMatch(sql, /public\.opensea_listing_events_v2/); });
test("migration contains no DROP TABLE", () => assert.doesNotMatch(migrationSql(), /DROP\s+TABLE/i));
test("migration remains wrapped in BEGIN and COMMIT", () => assert.match(migrationSql(), /^\s*BEGIN;\s[\s\S]*COMMIT;\s*$/));
test("migration documents reviewed one-shot behavior", () => assert.match(migrationSql(), /Reviewed one-shot migration/));
test("migration does not mutate V1 table", () => assert.doesNotMatch(migrationSql(), /public\.opensea_listings\s+(INSERT|UPDATE|DELETE)/i));
test("order_hash is primary key", () => assert.match(migrationSql(), /order_hash\s+text\s+PRIMARY KEY/));
test("NFT state has compound primary key", () => assert.match(migrationSql(), /PRIMARY KEY \(chain, contract_address, token_id\)/));
test("journal dedupe_key is unique", () => assert.match(migrationSql(), /dedupe_key\s+text\s+NOT NULL UNIQUE/));
test("journal event_timestamp is nullable while received_at remains required", () => { const sql = migrationSql(); assert.match(sql, /event_timestamp\s+timestamptz\s*,/); assert.doesNotMatch(sql, /event_timestamp\s+timestamptz\s+NOT NULL/i); assert.match(sql, /received_at\s+timestamptz\s+NOT NULL/); });
test("token_id is text in all state contracts", () => assert.match(migrationSql(), /token_id text NOT NULL/));
test("journal lifecycle migration is additive and targets only the V2 event journal", () => {
  const sql = lifecycleMigrationSql();
  assert.equal(fs.existsSync(path.resolve(import.meta.dirname, "..", "sql", "002_add_journal_processing_lifecycle.sql")), true);
  assert.match(sql, /^\s*BEGIN;\s[\s\S]*COMMIT;\s*$/);
  assert.match(sql, /ALTER TABLE public\.opensea_listings_events_v2/);
  assert.doesNotMatch(sql, /CREATE\s+TABLE/i);
  assert.doesNotMatch(sql, /DROP\s+TABLE/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /public\.opensea_listings\s+(INSERT|UPDATE|DELETE|ALTER|TRUNCATE|DROP)/i);
});
test("journal lifecycle migration adds reviewed columns and constraints", () => {
  const sql = lifecycleMigrationSql();
  for (const column of ["processing_status text", "attempt_count integer", "processing_started_at timestamptz", "last_attempt_at timestamptz", "next_retry_at timestamptz", "last_error_code text", "last_error_message text"]) assert.match(sql, new RegExp(column.replace(" ", "\\s+"), "i"));
  assert.match(sql, /ALTER COLUMN processing_status SET NOT NULL/i);
  assert.match(sql, /ALTER COLUMN attempt_count SET NOT NULL/i);
  assert.match(sql, /opensea_listings_events_v2_processing_status_check/);
  assert.match(sql, /opensea_listings_events_v2_attempt_count_check/);
  assert.match(sql, /CHECK \(attempt_count >= 0\)/);
});
test("journal lifecycle status check contains exactly reviewed statuses", () => {
  const sql = lifecycleMigrationSql();
  const statuses = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const reviewed = ["pending", "processing", "applied", "reconciliation_required", "failed", "ignored_duplicate", "ignored_older"];
  const inConstraint = statuses.slice(statuses.lastIndexOf("pending"), statuses.lastIndexOf("ignored_older") + 1);
  assert.deepEqual([...new Set(inConstraint)], reviewed);
});
test("journal lifecycle migration has deterministic backfill preserving finalized semantics", () => {
  const sql = lifecycleMigrationSql();
  assert.match(sql, /UPDATE public\.opensea_listings_events_v2\s+SET processing_status = CASE/i);
  assert.match(sql, /event_type = 'item_transferred' THEN 'reconciliation_required'/);
  assert.match(sql, /apply_result LIKE '%reconciliation%' THEN 'reconciliation_required'/);
  assert.match(sql, /apply_result LIKE 'ignored_older%' THEN 'ignored_older'/);
  assert.match(sql, /ELSE 'applied'/);
  assert.match(sql, /attempt_count = CASE[\s\S]*ELSE 1[\s\S]*END/i);
  assert.match(sql, /last_attempt_at = CASE[\s\S]*ELSE applied_at[\s\S]*END/i);
  assert.doesNotMatch(sql, /\bSET\s+raw_payload\s*=/i);
  assert.doesNotMatch(sql, /\bSET\s+dedupe_key\s*=/i);
  assert.doesNotMatch(sql, /\bSET\s+payload_hash\s*=/i);
  assert.doesNotMatch(sql, /\bSET\s+apply_result\s*=/i);
  assert.doesNotMatch(sql, /\bSET\s+applied_at\s*=/i);
});
test("durable inbox PG harness supports pre-created disposable DB without backend termination", () => {
  const source = pgHarnessSource();
  assert.doesNotMatch(source, /pg_terminate_backend/);
  assert.match(source, /const DISPOSABLE_DB = "server_otg_opensea_v2_durable_inbox_test"/);
  assert.match(source, /return \{ preExisting: true, created: false \}/);
  assert.match(source, /inspectDisposableDatabase\(pool\)/);
  assert.match(source, /schema_present_empty[\s\S]*refusing to reuse without manual recreation/);
});
test("durable inbox PG harness fails closed for absent DB create denial and does not target server_otg DDL", () => {
  const source = pgHarnessSource();
  assert.match(source, /CREATE DATABASE \$\{quoteIdent\(DISPOSABLE_DB\)\}/);
  assert.match(source, /disposable DB does not exist and CREATE DATABASE failed/);
  assert.doesNotMatch(source, /CREATE DATABASE \$\{quoteIdent\(PRODUCTION_DB\)\}/);
  assert.doesNotMatch(source, /DROP DATABASE \$\{quoteIdent\(PRODUCTION_DB\)\}/);
  assert.doesNotMatch(source, /server_otg["'`][\s\S]{0,120}(CREATE|DROP|TRUNCATE|DELETE|INSERT|UPDATE)/i);
});
test("durable inbox PG harness reports drop failure without broad termination", () => {
  const source = pgHarnessSource();
  assert.match(source, /catch \(error\)[\s\S]*return \{ dropped: false, error:/);
  assert.match(source, /cleanup = cleanupResult\.dropped \? "dropped" : cleanupResult\.error \? `failed:/);
  assert.match(source, /await pool\.end\(\);\s*const cleanupResult = await dropDisposableDatabase\(\)/);
});
test("real fixture inventory is exact and valid", () => {
  const expected = { item_listed: 4, item_cancelled: 3, item_sold: 2, order_invalidate: 8, item_transferred: 5 };
  const files = fs.readdirSync(path.join(root, "real")).filter((name) => name.endsWith(".json")).sort();
  assert.equal(files.length, 22);
  const counts: Record<string, number> = {};
  for (const name of files) {
    const value = real(name);
    const family = name.startsWith("item_listed") ? "item_listed" : name.startsWith("item_cancelled") ? "item_cancelled" : name.startsWith("item_sold") ? "item_sold" : name.startsWith("order_invalidate") ? "order_invalidate" : name.startsWith("item_transferred") ? "item_transferred" : null;
    assert.ok(family, `unexpected fixture family: ${name}`);
    assert.equal(value.event_type, family);
    counts[value.event_type] = (counts[value.event_type] ?? 0) + 1;
  }
  assert.deepEqual(counts, expected);
  assert.deepEqual(files, [
    "item_cancelled_1.json",
    "item_cancelled_2.json",
    "item_cancelled_3.json",
    "item_listed_high_price.json",
    "item_listed_ordinary.json",
    "item_listed_reprice_new.json",
    "item_listed_reprice_old.json",
    "item_sold_1.json",
    "item_sold_2.json",
    "item_transferred_real_3.json",
    "item_transferred_real_4.json",
    "item_transferred_real_5.json",
    "item_transferred_wallet_to_wallet.json",
    "item_transferred_zero_source.json",
    "order_invalidate_1.json",
    "order_invalidate_2.json",
    "order_invalidate_3.json",
    "order_invalidate_4.json",
    "order_invalidate_5.json",
    "order_invalidate_related_1.json",
    "order_invalidate_related_2.json",
    "order_invalidate_related_3.json"
  ]);
});
test("synthetic revalidate fixture remains separate", () => { assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith("synthetic_")).sort(), ["synthetic_order_revalidate_unknown_shape.json"]); assert.equal(synthetic().event_type, "order_revalidate"); });
test("GUN decimal normalization is exact", () => assert.equal(normalizeDecimal("16000000000000000000000", 18), "16000.0"));
test("seller maps from maker", () => assert.equal(order("item_listed_ordinary.json").seller, real("item_listed_ordinary.json").payload.maker.address));
test("maker and offerer disagreement requires reconciliation", () => { const raw = real("item_listed_ordinary.json"); raw.payload.protocol_data.parameters.offerer = "0x0000000000000000000000000000000000000001"; const event = normalizeOrderEvent(raw, receivedAt); assert.ok(event); assert.equal(event.mappingSuspicious, true); assert.match(event.mappingIssues.join(" "), /maker/); });
test("strict nft_id parser maps the observed identity", () => { const event = order("item_listed_ordinary.json"); assert.deepEqual(event.nft, { nftId: event.nft?.nftId, chain: "gunzilla", contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", tokenId: event.nft?.tokenId }); });
test("malformed nft_id is rejected", () => { const raw = real("item_listed_ordinary.json"); raw.payload.item.nft_id = "gunzilla/not-an-id"; assert.equal(normalizeOrderEvent(raw, receivedAt)?.nft, null); });
test("real listing creates active state", () => { const result = reduceOrderState(null, order(), now); assert.equal(result.state?.status, "active"); assert.equal(result.state?.isActive, true); assert.equal(result.requiresReconciliation, false); });
test("missing critical listing field is not exposed active", () => { const raw = real("item_listed_ordinary.json"); raw.payload.expiration_date = null; const event = normalizeOrderEvent(raw, receivedAt)!; const result = reduceOrderState(null, event, now); assert.equal(result.state?.isActive, false); assert.equal(result.state?.status, "unknown"); assert.equal(result.requiresReconciliation, true); });
test("cancellation creates cancelled state", () => { const listing = state(); const cancelRaw = related(real("item_cancelled_1.json"), real("item_listed_ordinary.json")); const result = reduceOrderState(listing, normalizeOrderEvent(cancelRaw, receivedAt)!, now); assert.equal(result.state?.status, "cancelled"); assert.equal(result.state?.isActive, false); });
test("cancellation preserves prior price and seller metadata", () => { const listing = state(); const cancelRaw = related(real("item_cancelled_1.json"), real("item_listed_ordinary.json")); cancelRaw.payload.base_price = null; cancelRaw.payload.maker = null; const result = reduceOrderState(listing, normalizeOrderEvent(cancelRaw, receivedAt)!, now); assert.equal(result.state?.price?.raw, listing.price?.raw); assert.equal(result.state?.seller, listing.seller); });
test("sale creates sold state", () => { const soldRaw = related(real("item_sold_1.json"), real("item_listed_ordinary.json")); const result = reduceOrderState(state(), normalizeOrderEvent(soldRaw, receivedAt)!, now); assert.equal(result.state?.status, "sold"); assert.equal(result.state?.isActive, false); });
test("sold has precedence over invalidate", () => { const soldRaw = real("item_sold_1.json"); const invalidateRaw = related(real("order_invalidate_related_1.json"), soldRaw); const listedRaw = related(real("item_listed_ordinary.json"), soldRaw); const afterInvalidate = reduceOrderState(null, normalizeOrderEvent(listedRaw, receivedAt)!, now).state; const invalidated = reduceOrderState(afterInvalidate, normalizeOrderEvent(invalidateRaw, receivedAt)!, now).state; const sold = reduceOrderState(invalidated, normalizeOrderEvent(soldRaw, receivedAt)!, now).state; assert.equal(sold?.status, "sold"); });
test("cancelled has precedence over invalidate", () => { const cancelRaw = real("item_cancelled_1.json"); const listedRaw = related(real("item_listed_ordinary.json"), cancelRaw); const invalidateRaw = related(real("order_invalidate_related_3.json"), cancelRaw); const listed = reduceOrderState(null, normalizeOrderEvent(listedRaw, receivedAt)!, now).state; const cancelled = reduceOrderState(listed, normalizeOrderEvent(cancelRaw, receivedAt)!, now).state; const result = reduceOrderState(cancelled, normalizeOrderEvent(invalidateRaw, receivedAt)!, now); assert.equal(result.state?.status, "cancelled"); });
test("invalidate-only event creates reconciliation tombstone", () => { const result = reduceOrderState(null, order("order_invalidate_1.json"), now); assert.equal(result.state?.status, "invalidated"); assert.equal(result.state?.needsReconciliation, true); });
test("invalidate does not invent price or seller", () => { const result = reduceOrderState(null, order("order_invalidate_1.json"), now); assert.equal(result.state?.price, null); assert.equal(result.state?.seller, null); });
test("expiration converts active order to expired", () => { const current = state(); const result = expireOrderState(current, "2027-02-01T00:00:00.000Z"); assert.equal(result.state?.status, "expired"); assert.equal(result.state?.isActive, false); });
test("expiration does not overwrite sold", () => { const soldRaw = related(real("item_sold_1.json"), real("item_listed_ordinary.json")); const sold = reduceOrderState(state(), normalizeOrderEvent(soldRaw, receivedAt)!, now).state!; assert.equal(expireOrderState(sold, "2030-01-01T00:00:00Z").state?.status, "sold"); });
test("transfer suppresses active listing pending reconciliation", () => { const current = state(); const raw = real("item_transferred_zero_source.json"); raw.payload.item.nft_id = current.nft.nftId; const result = applyTransferToOrder(current, normalizeTransferEvent(raw, receivedAt)!, now); assert.equal(result.state?.isActive, false); assert.equal(result.state?.reconciliationReason, "transfer_observed"); });
test("transfer does not overwrite terminal sold state", () => { const soldRaw = related(real("item_sold_1.json"), real("item_listed_ordinary.json")); const sold = reduceOrderState(state(), normalizeOrderEvent(soldRaw, receivedAt)!, now).state!; const transferRaw = real("item_transferred_wallet_to_wallet.json"); transferRaw.payload.item.nft_id = sold.nft.nftId; const result = applyTransferToOrder(sold, normalizeTransferEvent(transferRaw, receivedAt)!, now); assert.equal(result.state?.status, "sold"); });
test("transfer back does not automatically reactivate", () => { const current = state(); const first = real("item_transferred_zero_source.json"); first.payload.item.nft_id = current.nft.nftId; const suppressed = applyTransferToOrder(current, normalizeTransferEvent(first, receivedAt)!, now).state!; const back = real("item_transferred_wallet_to_wallet.json"); back.payload.item.nft_id = current.nft.nftId; assert.equal(applyTransferToOrder(suppressed, normalizeTransferEvent(back, receivedAt)!, now).state?.isActive, false); });
test("revalidate never automatically activates", () => { const result = reduceOrderState(state(), normalizeUnknownRevalidate(synthetic(), receivedAt)!, now); assert.equal(result.state?.status, "active"); assert.equal(result.state?.isActive, false); assert.equal(result.state?.needsReconciliation, true); assert.equal(result.applyResult, "journal_only_revalidate"); });
test("revalidate with null business timestamp remains journal-safe and conservative", () => {
  const raw = synthetic();
  delete raw.payload.event_timestamp;
  const event = normalizeUnknownRevalidate(raw, receivedAt)!;
  assert.equal(event.eventTimestamp, null);
  assert.equal(event.receivedAt, receivedAt);
  assert.notEqual(event.eventTimestamp, event.receivedAt);
  assert.match(orderDedupeKey(event), /^order-fallback:v1:[a-f0-9]{64}$/);
  const result = reduceOrderState(state(), event, now);
  assert.equal(result.state?.isActive, false);
  assert.equal(result.state?.needsReconciliation, true);
  assert.equal(isVisibleLiveListing(result.state!, now), false);
});
test("missing business timestamp cannot create visible active listing", () => {
  const raw = real("item_listed_ordinary.json");
  delete raw.payload.event_timestamp;
  const event = normalizeOrderEvent(raw, receivedAt)!;
  const result = reduceOrderState(null, event, now);
  assert.equal(event.eventTimestamp, null);
  assert.equal(result.state?.isActive, false);
  assert.equal(result.state?.needsReconciliation, true);
  assert.equal(isVisibleLiveListing(result.state!, now), false);
  assert.equal(result.state?.lastOrderEventTimestamp, null);
});
test("older item_listed cannot override newer terminal state", () => { const current = state(); const cancel = related(real("item_cancelled_1.json"), real("item_listed_ordinary.json")); const cancelled = reduceOrderState(current, normalizeOrderEvent(cancel, receivedAt)!, now).state!; const older = real("item_listed_ordinary.json"); older.payload.event_timestamp = "2020-01-01T00:00:00Z"; assert.equal(reduceOrderState(cancelled, normalizeOrderEvent(older, receivedAt)!, now).state?.status, "cancelled"); });
test("business timestamp wins over arrival order", () => { const current = state(); const older = withTimestamp(related(real("order_invalidate_related_3.json"), real("item_listed_ordinary.json")), "2020-01-01T00:00:00Z"); const result = reduceOrderState(current, normalizeOrderEvent(older, receivedAt)!, now); assert.equal(result.ignored, true); assert.equal(result.reason, "older_business_timestamp"); });
test("equal timestamp terminal precedence works", () => { const current = state(); const invalid = related(real("order_invalidate_related_3.json"), real("item_listed_ordinary.json")); invalid.payload.event_timestamp = current.lastOrderEventTimestamp; const invalidated = reduceOrderState(current, normalizeOrderEvent(invalid, receivedAt)!, now).state!; const cancel = related(real("item_cancelled_1.json"), real("item_listed_ordinary.json")); cancel.payload.event_timestamp = current.lastOrderEventTimestamp; assert.equal(reduceOrderState(invalidated, normalizeOrderEvent(cancel, receivedAt)!, now).state?.status, "cancelled"); });
test("versions from different families are not used as global order", () => { const current = state(); const invalid = related(real("order_invalidate_related_3.json"), real("item_listed_ordinary.json")); invalid.version = 1; invalid.payload.event_timestamp = "2026-08-06T00:00:01Z"; assert.equal(reduceOrderState(current, normalizeOrderEvent(invalid, receivedAt)!, now).state?.status, "invalidated"); });
test("repricing creates independent states for two order hashes", () => { const oldState = state("item_listed_reprice_old.json"); const newState = state("item_listed_reprice_new.json"); assert.notEqual(oldState.orderHash, newState.orderHash); assert.notEqual(oldState.price?.raw, newState.price?.raw); });
test("old repriced order cancellation does not affect new hash", () => { const old = state("item_listed_reprice_old.json"); const newer = state("item_listed_reprice_new.json"); const cancelRaw = related(real("item_cancelled_1.json"), real("item_listed_reprice_old.json")); const oldCancelled = reduceOrderState(old, normalizeOrderEvent(cancelRaw, receivedAt)!).state!; assert.equal(oldCancelled.status, "cancelled"); assert.equal(newer.status, "active"); });
test("order journal key is deterministic", () => { const event = order(); assert.match(orderDedupeKey(event), /^order:v1:[a-f0-9]{64}$/); assert.equal(orderDedupeKey(event), orderDedupeKey(structuredClone(event))); });
test("duplicate order event produces same dedupe key", () => { const event = order(); assert.equal(orderDedupeKey(event), orderDedupeKey(event)); });
test("transfer journal key is deterministic", () => { const event = transfer("item_transferred_zero_source.json"); assert.match(transferDedupeKey(event), /^transfer:v1:[a-f0-9]{64}$/); assert.equal(transferDedupeKey(event), transferDedupeKey(structuredClone(event))); });
test("canonical payload hash is deterministic", () => assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 })));
test("received_at does not affect dedupe key", () => { const a = order(); const b = { ...a, receivedAt: "2030-01-01T00:00:00Z" }; assert.equal(orderDedupeKey(a), orderDedupeKey(b)); });
test("structured order key avoids delimiter collision", () => {
  const base = order();
  const a = { ...base, nft: { ...base.nft!, chain: "a|b", contractAddress: "c" }, orderHash: "d", eventTimestamp: "e", eventVersion: 1 };
  const b = { ...base, nft: { ...base.nft!, chain: "a", contractAddress: "b|c" }, orderHash: "d", eventTimestamp: "e", eventVersion: 1 };
  assert.equal(["item_listed", "a|b", "c", "d", "e", "1"].join("|"), ["item_listed", "a", "b|c", "d", "e", "1"].join("|"));
  assert.notEqual(orderDedupeKey(a), orderDedupeKey(b));
});
test("structured identity distinguishes null from empty string", () => {
  const base = order();
  const empty = { ...base, orderHash: "", rawPayload: { kind: "empty" } };
  const missing = { ...base, orderHash: null, rawPayload: { kind: "empty" } };
  assert.match(orderDedupeKey(empty), /^order:v1:[a-f0-9]{64}$/);
  assert.match(orderDedupeKey(missing), /^order-fallback:v1:[a-f0-9]{64}$/);
  assert.notEqual(orderDedupeKey(empty), orderDedupeKey(missing));
});
test("structured order key changes with event_type and order_hash", () => { const event = order(); assert.notEqual(orderDedupeKey(event), orderDedupeKey({ ...event, eventType: "item_cancelled" })); assert.notEqual(orderDedupeKey(event), orderDedupeKey({ ...event, orderHash: `${event.orderHash}-other` })); });
test("structured transfer key changes with transaction_hash and ignores received_at", () => { const event = transfer("item_transferred_zero_source.json"); assert.notEqual(transferDedupeKey(event), transferDedupeKey({ ...event, transactionHash: `${event.transactionHash}-other` })); assert.equal(transferDedupeKey(event), transferDedupeKey({ ...event, receivedAt: "2030-01-01T00:00:00Z" })); });
test("fallback dedupe keys are family-specific and structured", () => { const orderEvent = { ...order(), eventTimestamp: null }; const transferEvent = { ...transfer("item_transferred_zero_source.json"), transactionHash: null }; assert.match(orderDedupeKey(orderEvent), /^order-fallback:v1:[a-f0-9]{64}$/); assert.match(transferDedupeKey(transferEvent), /^transfer-fallback:v1:[a-f0-9]{64}$/); assert.notEqual(orderDedupeKey(orderEvent), transferDedupeKey(transferEvent)); });
test("raw payload is preserved by normalization and reducer", () => { const raw = real("item_listed_ordinary.json"); const event = normalizeOrderEvent(raw, receivedAt)!; const result = reduceOrderState(null, event, now); assert.equal(result.state?.rawLastEvent, raw); });
test("null terminal metadata does not erase good metadata", () => { const current = state(); const cancel = related(real("item_cancelled_1.json"), real("item_listed_ordinary.json")); cancel.payload.item.metadata.image_url = null; cancel.payload.item.metadata.name = null; const result = reduceOrderState(current, normalizeOrderEvent(cancel, receivedAt)!, now).state!; assert.equal(result.item.imageUrl, current.item.imageUrl); assert.equal(result.item.name, current.item.name); });
test("synthetic revalidate fixture is explicitly unverified", () => { const event = normalizeUnknownRevalidate(synthetic(), receivedAt)!; assert.equal(event.mappingSuspicious, true); assert.deepEqual(event.mappingIssues, ["order_revalidate_payload_unverified"]); });
test("live view requires active status", () => { const current = state(); assert.equal(isVisibleLiveListing(current, now), true); const inactive = { ...current, status: "stale" as const }; assert.equal(isVisibleLiveListing(inactive, now), false); });
test("live view requires is_active", () => { const current = state(); assert.equal(isVisibleLiveListing({ ...current, isActive: false }, now), false); });
test("live view requires no reconciliation", () => { const current = state(); assert.equal(isVisibleLiveListing({ ...current, needsReconciliation: true }, now), false); });
test("live view requires future expiration", () => { const current = state(); assert.equal(isVisibleLiveListing({ ...current, expirationAt: "2020-01-01T00:00:00Z" }, now), false); });
test("NULL expiration is not live", () => { const current = state(); assert.equal(isVisibleLiveListing({ ...current, expirationAt: null }, now), false); });
test("NFT transfer reducer creates NFT state from real payload", () => { const result = reduceNftState(null, transfer("item_transferred_zero_source.json"), now); assert.equal(result.state?.identity.chain, "gunzilla"); assert.equal(result.state?.lastTransferTransactionHash, transfer("item_transferred_zero_source.json").transactionHash); });
test("NFT transfer reducer keeps newest transfer", () => { const event = transfer("item_transferred_zero_source.json"); const first = reduceNftState(null, event, now).state!; const older = { ...event, eventTimestamp: "2020-01-01T00:00:00Z" }; assert.equal(reduceNftState(first, older, now).ignored, true); });
test("seller address is not invented for invalidate", () => assert.equal(order("order_invalidate_1.json").seller, null));
test("sale buyer remains a candidate rather than owner state", () => assert.ok(order("item_sold_1.json").buyerCandidate));
test("transfer summary source and destination are preserved", () => { const event = transfer("item_transferred_wallet_to_wallet.json"); assert.ok(event.from); assert.ok(event.to); assert.ok(event.transactionHash); });
test("price raw remains a string", () => { const price = order("item_listed_ordinary.json").price; assert.equal(typeof price?.raw, "string"); assert.equal(typeof price?.normalizedDecimalString, "string"); });
test("business timestamp normalizer accepts observed ISO and epoch forms strictly", () => {
  assert.equal(normalizeBusinessTimestamp("1786422067"), "2026-08-11T04:21:07.000Z");
  assert.equal(normalizeBusinessTimestamp("1785890722"), "2026-08-05T00:45:22.000Z");
  assert.equal(normalizeBusinessTimestamp(1786422067), "2026-08-11T04:21:07.000Z");
  assert.equal(normalizeBusinessTimestamp("1786422067000"), "2026-08-11T04:21:07.000Z");
  assert.equal(normalizeBusinessTimestamp("2026-08-04T02:21:24.000000Z"), "2026-08-04T02:21:24.000Z");
  assert.equal(normalizeBusinessTimestamp(""), null);
  assert.equal(normalizeBusinessTimestamp("not-a-date"), null);
  assert.equal(normalizeBusinessTimestamp("1.786422067e9"), null);
  assert.equal(normalizeBusinessTimestamp("1786422067.5"), null);
  assert.equal(normalizeBusinessTimestamp("-1786422067"), null);
  assert.equal(normalizeBusinessTimestamp(9007199254740993), null);
  assert.equal(normalizeBusinessTimestamp("946684799"), null);
  assert.equal(normalizeBusinessTimestamp("4102444801"), null);
  assert.equal(normalizeBusinessTimestamp(null), null);
  assert.equal(normalizeBusinessTimestamp(undefined), null);
});
test("canary failure timestamp is normalized for transfer state without mutating raw payload or event version", () => {
  const raw = real("item_transferred_zero_source.json");
  raw.version = "1786422067000";
  raw.payload.event_timestamp = "2026-08-11T04:21:07.000000Z";
  raw.payload.transaction.timestamp = "1786422067";
  const event = normalizeTransferEvent(raw, receivedAt)!;
  assert.equal(event.transactionTimestamp, "2026-08-11T04:21:07.000Z");
  assert.equal(event.eventTimestamp, "2026-08-11T04:21:07.000Z");
  assert.equal(event.eventVersion, "1786422067000");
  assert.equal((event.rawPayload as any).payload.transaction.timestamp, "1786422067");
  const result = reduceNftState(null, event, now);
  assert.equal(result.state?.lastTransferAt, "2026-08-11T04:21:07.000Z");
  assert.equal(result.state?.lastNftEventTimestamp, "2026-08-11T04:21:07.000Z");
  assert.equal(result.state?.lastNftEventVersion, "1786422067000");
});
test("order business timestamps are canonicalized while preserving lifecycle behavior", () => {
  const listed = order("item_listed_ordinary.json");
  assert.equal(listed.eventTimestamp, "2026-08-04T23:29:22.578Z");
  assert.equal(listed.listingStartAt, "2026-08-04T23:29:20.000Z");
  assert.equal(listed.expirationAt, "2027-01-31T23:29:20.000Z");
  assert.equal(reduceOrderState(null, listed, now).state?.status, "active");
  assert.equal(order("item_cancelled_1.json").eventTimestamp, "2026-08-05T01:59:38.146Z");
  assert.equal(order("item_sold_1.json").eventTimestamp, "2026-08-05T00:45:22.000Z");
  assert.equal(order("order_invalidate_1.json").eventTimestamp, "2026-07-05T17:26:50.570Z");
  const revalidateRaw = synthetic();
  revalidateRaw.payload.event_timestamp = "1786422067";
  assert.equal(normalizeUnknownRevalidate(revalidateRaw, receivedAt)?.eventTimestamp, "2026-08-11T04:21:07.000Z");
});
test("invalid business timestamp fails safe and cannot create visible active listing", () => {
  const raw = real("item_listed_ordinary.json");
  raw.payload.event_timestamp = "1.786422067e9";
  raw.payload.listing_date = "not-a-date";
  raw.payload.expiration_date = "1786422067.5";
  const event = normalizeOrderEvent(raw, receivedAt)!;
  const result = reduceOrderState(null, event, now);
  assert.equal(event.eventTimestamp, null);
  assert.equal(event.listingStartAt, null);
  assert.equal(event.expirationAt, null);
  assert.equal(result.state?.status, "unknown");
  assert.equal(result.state?.isActive, false);
  assert.equal(isVisibleLiveListing(result.state!, now), false);
});
test("event versions normalize to bigint-safe decimal strings", () => {
  assert.equal(normalizeEventVersion("1785890722000"), "1785890722000");
  assert.equal(normalizeEventVersion("9007199254740993"), "9007199254740993");
  assert.equal(normalizeEventVersion(123), "123");
  assert.equal(normalizeEventVersion(9007199254740993), null);
  assert.equal(normalizeEventVersion("9223372036854775807"), "9223372036854775807");
  assert.equal(normalizeEventVersion("9223372036854775808"), null);
  assert.equal(normalizeEventVersion("-1"), null);
  assert.equal(normalizeEventVersion("1e3"), null);
  assert.equal(normalizeEventVersion("1.5"), null);
});
test("normalized event version remains string and raw payload is unchanged", () => {
  const raw = real("item_transferred_zero_source.json");
  raw.version = "9007199254740993";
  const event = normalizeTransferEvent(raw, receivedAt)!;
  assert.equal(event.eventVersion, "9007199254740993");
  assert.equal(event.rawPayload, raw);
  assert.equal((event.rawPayload as any).version, "9007199254740993");
});
test("unsafe numeric event version fails safely with mapping warning", () => {
  const raw = real("item_listed_ordinary.json");
  raw.version = 9007199254740993;
  const event = normalizeOrderEvent(raw, receivedAt)!;
  assert.equal(event.eventVersion, null);
  assert.equal(event.mappingSuspicious, true);
  assert.match(event.mappingIssues.join(" "), /event_version_invalid_or_unsafe/);
});
test("family-local version comparison uses exact bigint semantics", () => {
  assert.equal(compareEventVersions("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareEventVersions("9007199254740992", "9007199254740993"), -1);
  const current = state();
  const incoming = normalizeOrderEvent(withTimestamp(real("item_listed_ordinary.json"), current.lastOrderEventTimestamp!), receivedAt)!;
  const high = { ...current, lastOrderEventVersion: "9007199254740993" };
  const lowerIncoming = { ...incoming, eventVersion: "9007199254740992" };
  const result = reduceOrderState(high, lowerIncoming, now);
  assert.equal(result.ignored, true);
});
test("zero source is not converted into a business mint status", () => { const event = transfer("item_transferred_zero_source.json"); assert.equal(event.from?.toLowerCase(), "0x0000000000000000000000000000000000000000"); });
test("unknown order event does not create active state", () => { const event = normalizeUnknownRevalidate(synthetic(), receivedAt)!; assert.equal(reduceOrderState(null, event, now).state, null); });
