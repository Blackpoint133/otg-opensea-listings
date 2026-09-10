import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@opensea/stream-js";
import { SELECTED_EVENT_TYPES, summarizeEvent } from "../src/eventTypes.js";

test("selects exactly the six required event types", () => assert.deepEqual([...SELECTED_EVENT_TYPES], [EventType.ITEM_LISTED, EventType.ITEM_CANCELLED, EventType.ITEM_SOLD, EventType.ITEM_TRANSFERRED, EventType.ORDER_INVALIDATE, EventType.ORDER_REVALIDATE]));
test("does not select offers or bids", () => assert.equal(SELECTED_EVENT_TYPES.some((x) => String(x).toLowerCase().includes("offer") || String(x).toLowerCase().includes("bid")), false));
test("summary tolerates absent nested fields", () => assert.doesNotThrow(() => summarizeEvent({ event_type: "item_listed", payload: {} })));
