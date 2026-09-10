import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptOpenSeaExactOrder, isTrustedOpenSeaExactOrderObservation } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { interpretOpenSeaExactOrderObservation } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
const hash = "0x"+"a".repeat(64), contract = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", protocol = "0x"+"1".repeat(40);
const context: any = { orderHash: hash, chain: "gunzilla", contractAddress: contract, protocolAddress: protocol, collectionSlug: "off-the-grid", expectedIdentity: { orderHash: hash, chain: "gunzilla", contractAddress: contract, protocolAddress: protocol, collectionSlug: "off-the-grid", tokenId: "7" } };
function raw(extra: Record<string, unknown> = {}) { return new TextEncoder().encode(JSON.stringify({ order: { order_hash: hash, chain: "gunzilla", protocol_address: protocol, status: "ACTIVE", asset: { contract, identifier: "7" }, remaining_quantity: "1", protocol_data: { parameters: { order_type: 0, start_time: "1700000000", end_time: "2000000000", offer: [{ item_type: 2, token: contract, identifier_or_criteria: "7", start_amount: "1", end_amount: "1" }] } }, ...extra } })); }
function input(body: Uint8Array | null = raw(), extra: Record<string, unknown> = {}) { return { context, httpStatus: 200, body, headers: { date: "Tue, 01 Jan 2030 00:00:00 GMT", "content-encoding": "identity" }, ...extra }; }
test("valid wrapped Listing is adapted and trusted", () => { const o = adaptOpenSeaExactOrder(input()); assert.equal(o.outcome, "VALID"); assert.equal(o.assetIdentifier, "7"); assert.equal(o.offerIdentifier, "7"); assert.equal(isTrustedOpenSeaExactOrderObservation(o), true); });
test("normalizer consumes adapter observation", () => { const o = adaptOpenSeaExactOrder(input()); const p = interpretOpenSeaExactOrderObservation({ context, observation: o }); assert.equal(p.authorityGranted, false); });
test("root itself without order wrapper fails", () => { const o = adaptOpenSeaExactOrder(input(new TextEncoder().encode(JSON.stringify({ order_hash: hash })))); assert.notEqual(o.outcome, "VALID"); });
test("missing order fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(new TextEncoder().encode("{}"))).outcome, "VALID"));
test("array root fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(new TextEncoder().encode("[]"))).outcome, "VALID"));
test("wrong identity fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ order_hash: "0x"+"b".repeat(64) }))).outcome, "VALID"));
test("asset offer mismatch fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ asset: { contract, identifier: "8" } }))).outcome, "VALID"));
test("criteria item fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ protocol_data: { parameters: { order_type: 0, offer: [{ item_type: 4, token: contract, identifier_or_criteria: "7", start_amount: "1", end_amount: "1" }] } } }))).outcome, "VALID"));
test("multiple offers fail", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ protocol_data: { parameters: { order_type: 0, offer: [] } } }))).outcome, "VALID"));
test("wrong content encoding fails", () => assert.equal(adaptOpenSeaExactOrder(input(raw(), { headers: { "content-encoding": "gzip" } })).outcome, "UNSUPPORTED"));
test("BOM fails", () => assert.equal(adaptOpenSeaExactOrder(input(new Uint8Array([0xef,0xbb,0xbf,...raw()]))).outcome, "MALFORMED"));
test("malformed utf8 fails", () => assert.equal(adaptOpenSeaExactOrder(input(new Uint8Array([0xff,0xfe]))).outcome, "MALFORMED"));
test("404 is unknown", () => assert.equal(adaptOpenSeaExactOrder({ ...input(null), httpStatus: 404 }).outcome, "UNKNOWN"));
test("body hash mismatch fails", () => assert.equal(adaptOpenSeaExactOrder(input(raw(), { responseBodySha256: "0".repeat(64) })).outcome, "MALFORMED"));
test("body cap fails", () => assert.equal(adaptOpenSeaExactOrder(input(new Uint8Array(1048577))).outcome, "MALFORMED"));
test("age header invalidates time", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw(), { headers: { age: "0" } })).outcome, "VALID"));
test("inactive status remains provider state", () => { const o = adaptOpenSeaExactOrder(input(raw({ status: "INACTIVE" }))); assert.equal(o.providerStatus, "INACTIVE"); });
test("huge decimal token is preserved lexically", () => { const token = "9".repeat(100); const c = { ...context, expectedIdentity: { ...context.expectedIdentity, tokenId: token } }; const b = new TextEncoder().encode(JSON.stringify({ order: { order_hash: hash, chain: "gunzilla", protocol_address: protocol, status: "ACTIVE", asset: { contract, identifier: token }, protocol_data: { parameters: { order_type: 0, offer: [{ item_type: 2, token: contract, identifier_or_criteria: token, start_amount: "1", end_amount: "1" }] } } } })); const o = adaptOpenSeaExactOrder({ ...input(b), context: c }); assert.equal(o.assetIdentifier, token); });
