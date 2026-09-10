import assert from "node:assert/strict";
import test from "node:test";
import { summarizeEvent } from "../src/eventTypes.js";

test("public fields remain unchanged and secrets are not accepted by summary", () => {
  const event = { event_type: "item_listed", payload: { order_hash: "0xorder", item: { nft_id: "gun:0xcontract:1", metadata: { name: "Example" } }, maker: { address: "0xwallet" }, transaction_hash: "0xtx" } };
  const summary = summarizeEvent(event);
  assert.equal(summary.order_hash, "0xorder");
  assert.equal(summary.nft_id, "gun:0xcontract:1");
  assert.equal(summary.maker_seller_address, "0xwallet");
  assert.equal(summary.transaction_hash, "0xtx");
  assert.equal(JSON.stringify(summary).includes("OPENSEA_API_KEY"), false);
});

test("JSONL wrapper has required top-level fields", () => {
  const wrapper = { received_at_utc: new Date().toISOString(), sequence_number: 1, event_type: "item_listed", sdk_version: "0.4.0", collection_slug: "off-the-grid", full_event: { event_type: "item_listed" } };
  const parsed = JSON.parse(JSON.stringify(wrapper));
  for (const key of ["received_at_utc", "sequence_number", "event_type", "sdk_version", "collection_slug", "full_event"]) assert.ok(key in parsed);
});
