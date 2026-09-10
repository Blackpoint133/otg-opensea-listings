import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@opensea/stream-js";
import { loadConfig, parseNonNegativeNumber } from "../src/config.js";
import { eventTypesForProfile, parseNftId, PROFILE_EVENT_TYPES, summarizeEvent } from "../src/eventTypes.js";
import { CaptureCounters, createEventWrapper, shouldLogEvent } from "../src/streamProbe.js";

test("default profile selects all six existing event types", () => {
  const config = loadConfig([], { OPENSEA_API_KEY: "test-key" });
  assert.deepEqual(config.selectedEventTypes, [...PROFILE_EVENT_TYPES.all]);
  assert.deepEqual(eventTypesForProfile("all"), [EventType.ITEM_LISTED, EventType.ITEM_CANCELLED, EventType.ITEM_SOLD, EventType.ITEM_TRANSFERRED, EventType.ORDER_INVALIDATE, EventType.ORDER_REVALIDATE]);
});

test("orders profile selects exactly five order event types", () => assert.deepEqual(eventTypesForProfile("orders"), [EventType.ITEM_LISTED, EventType.ITEM_CANCELLED, EventType.ITEM_SOLD, EventType.ORDER_INVALIDATE, EventType.ORDER_REVALIDATE]));
test("orders profile excludes item_transferred", () => assert.equal(eventTypesForProfile("orders").includes(EventType.ITEM_TRANSFERRED), false));
test("transfers profile selects only item_transferred", () => assert.deepEqual(eventTypesForProfile("transfers"), [EventType.ITEM_TRANSFERRED]));
test("offers and bids are excluded from every profile", () => assert.equal(Object.values(PROFILE_EVENT_TYPES).flat().some((x) => String(x).includes("offer") || String(x).includes("bid")), false));
test("invalid profile is rejected", () => assert.throws(() => loadConfig(["--profile", "invalid"], { OPENSEA_API_KEY: "test-key" }), /profile must be/));
test("per-type max zero means unlimited", () => { const c = new CaptureCounters(0, 0); assert.equal(c.observe("item_listed").store, true); assert.equal(c.observe("item_listed").store, true); });
test("one type cap does not stop the probe", () => { const c = new CaptureCounters(0, 1); assert.equal(c.observe("item_listed").store, true); const skipped = c.observe("item_listed"); assert.equal(skipped.store, false); assert.equal(skipped.skipped_due_to_type_cap, true); assert.equal(c.observe("item_cancelled").store, true); });
test("capped events are observed and skipped, not stored", () => { const c = new CaptureCounters(0, 1); c.observe("item_listed"); c.observe("item_listed"); const snapshot = c.snapshot(); assert.equal(snapshot.total_observed_events, 2); assert.equal(snapshot.total_stored_events, 1); assert.equal(snapshot.skipped_due_to_type_cap.item_listed, 1); });
test("other types continue storing after one type reaches cap", () => { const c = new CaptureCounters(0, 1); c.observe("item_listed"); c.observe("item_listed"); c.observe("item_sold"); assert.equal(c.snapshot().stored_by_type.item_sold, 1); });
test("global max counts stored events only", () => { const c = new CaptureCounters(2, 1); c.observe("item_listed"); c.observe("item_listed"); assert.equal(c.observe("item_cancelled").store, true); const after = c.observe("item_sold"); assert.equal(after.global_limit_reached, true); assert.equal(c.snapshot().total_observed_events, 4); assert.equal(c.snapshot().total_stored_events, 2); });
test("stored sequence numbers remain contiguous and wrapper has profile", () => { const c = new CaptureCounters(0, 1); const first = c.observe("item_listed"); c.observe("item_listed"); const second = c.observe("item_cancelled"); assert.equal(first.store, true); assert.equal(second.store, true); const wrapper = createEventWrapper({ event_type: "item_cancelled" }, "2026-01-01T00:00:00.000Z", 2, c.totalObserved, "off-the-grid", "orders"); assert.equal(wrapper.sequence_number, 2); assert.equal(wrapper.capture_profile, "orders"); assert.equal("full_event" in wrapper, true); });
test("config output filenames include capture profile and zero limits are valid", () => { const config = loadConfig(["--profile", "orders", "--max-events", "0", "--per-type-max-events", "0"], { OPENSEA_API_KEY: "test-key" }); assert.match(config.eventsPath, /opensea_stream_probe_orders_/); assert.match(config.logPath, /stream_probe_orders_/); assert.equal(parseNonNegativeNumber("0", "max", 1), 0); });
test("nft_id parser extracts chain, contract and string token id", () => { const parsed = parseNftId("gunzilla/0xabc/47710245"); assert.deepEqual(parsed, { valid: true, chain: "gunzilla", contract_address: "0xabc", token_id_text: "47710245" }); assert.equal(typeof parsed.token_id_text, "string"); });
test("malformed nft_id is rejected safely", () => { assert.equal(parseNftId("gunzilla/0xabc/not-a-number").valid, false); assert.equal(parseNftId("gunzilla/0xabc/1/extra").token_id_text, null); });
test("transfer summary includes from, to and transaction fields", () => { const summary = summarizeEvent({ event_type: "item_transferred", version: 1, payload: { chain: "gunzilla", event_timestamp: "2026-01-01T00:00:00Z", from_account: { address: "0xfrom" }, to_account: { address: "0xto" }, quantity: 1, item: { nft_id: "gunzilla/0xabc/47710245", metadata: { name: "#47710245" }, permalink: "https://opensea.io/item/x" }, transaction: { hash: "0xtx", timestamp: "1" } } }); assert.equal(summary.token_id_text, "47710245"); assert.equal(summary.from_address, "0xfrom"); assert.equal(summary.to_address, "0xto"); assert.equal(summary.transaction_hash, "0xtx"); assert.equal(summary.transfer_classification_hint, "wallet_to_wallet"); });
test("event log sampling does not affect JSONL storage", () => { const c = new CaptureCounters(0, 0); assert.equal(c.observe("item_transferred").store, true); assert.equal(c.observe("item_transferred").store, true); assert.equal(c.snapshot().total_stored_events, 2); assert.equal(shouldLogEvent(2, 10), false); });
test("first event of every type is always logged", () => { assert.equal(shouldLogEvent(1, 10), true); assert.equal(shouldLogEvent(2, 10), false); assert.equal(shouldLogEvent(10, 10), true); });
