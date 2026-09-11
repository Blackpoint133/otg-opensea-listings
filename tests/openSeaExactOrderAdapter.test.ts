import assert from "node:assert/strict";
import { after, test } from "node:test";
import { adaptOpenSeaExactOrder, isTrustedOpenSeaExactOrderObservation } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { interpretOpenSeaExactOrderObservation } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { makeTrustedContexts, disposeTrustedContexts } from "./helpers/trustedVerifierContexts.js";
const hash = "0x"+"a".repeat(64), contract = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", protocol = "0x"+"1".repeat(40);
const fixture = await makeTrustedContexts();
const context = fixture.contexts[0];
after(async () => { await disposeTrustedContexts(fixture.root); });
function raw(extra: Record<string, unknown> = {}) { return new TextEncoder().encode(JSON.stringify({ order: { order_hash: hash, chain: "gunzilla", protocol_address: protocol, status: "ACTIVE", asset: { contract, identifier: "1" }, remaining_quantity: 1, protocol_data: { parameters: { orderType: 0, startTime: "1893455000", endTime: "1893457000", offer: [{ itemType: 2, token: contract, identifierOrCriteria: "1", startAmount: "1", endAmount: "1" }] } }, ...extra } })); }
function input(body: Uint8Array | null = raw(), extra: Record<string, unknown> = {}) { return { context, httpStatus: 200, body, timing: { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.500Z", responseCompletedAt: "2030-01-01T00:00:01.000Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false }, headers: [{ name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" }, { name: "Content-Type", value: "application/json" }, { name: "Content-Encoding", value: "identity" }], ...extra }; }
test("valid wrapped Listing is adapted and trusted", () => { const o = adaptOpenSeaExactOrder(input()); assert.equal(o.outcome, "VALID"); assert.equal(o.assetIdentifier, "1"); assert.equal(o.offerIdentifier, "1"); assert.equal(isTrustedOpenSeaExactOrderObservation(o), true); });
test("normalizer consumes adapter observation", () => { const o = adaptOpenSeaExactOrder(input()); const p = interpretOpenSeaExactOrderObservation({ context, observation: o }); assert.equal(p.authorityGranted, false); });
test("root itself without order wrapper fails", () => { const o = adaptOpenSeaExactOrder(input(new TextEncoder().encode(JSON.stringify({ order_hash: hash })))); assert.notEqual(o.outcome, "VALID"); });
test("missing order fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(new TextEncoder().encode("{}"))).outcome, "VALID"));
test("array root fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(new TextEncoder().encode("[]"))).outcome, "VALID"));
test("wrong identity fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ order_hash: "0x"+"b".repeat(64) }))).outcome, "VALID"));
test("asset offer mismatch fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ asset: { contract, identifier: "8" } }))).outcome, "VALID"));
test("criteria item fails", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ protocol_data: { parameters: { order_type: 0, offer: [{ item_type: 4, token: contract, identifier_or_criteria: "7", start_amount: "1", end_amount: "1" }] } } }))).outcome, "VALID"));
test("multiple offers fail", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw({ protocol_data: { parameters: { order_type: 0, offer: [] } } }))).outcome, "VALID"));
test("wrong content encoding fails", () => assert.equal(adaptOpenSeaExactOrder(input(raw(), { headers: [{ name: "Content-Encoding", value: "gzip" }] })).outcome, "UNSUPPORTED"));
test("BOM fails", () => assert.equal(adaptOpenSeaExactOrder(input(new Uint8Array([0xef,0xbb,0xbf,...raw()]))).outcome, "MALFORMED"));
test("malformed utf8 fails", () => assert.equal(adaptOpenSeaExactOrder(input(new Uint8Array([0xff,0xfe]))).outcome, "MALFORMED"));
test("404 is unknown", () => assert.equal(adaptOpenSeaExactOrder({ ...input(null), httpStatus: 404 }).outcome, "UNKNOWN"));
test("body hash mismatch fails", () => assert.equal(adaptOpenSeaExactOrder(input(raw(), { responseBodySha256: "0".repeat(64) })).outcome, "MALFORMED"));
test("body cap fails", () => assert.equal(adaptOpenSeaExactOrder(input(new Uint8Array(1048577))).outcome, "MALFORMED"));
test("age header invalidates time", () => assert.notEqual(adaptOpenSeaExactOrder(input(raw(), { headers: [{ name: "Age", value: "0" }] })).outcome, "VALID"));
test("inactive status remains provider state", () => { const o = adaptOpenSeaExactOrder(input(raw({ status: "INACTIVE" }))); assert.equal(o.providerStatus, "INACTIVE"); });
test("huge decimal token is preserved lexically", () => { const token = "9".repeat(100); const b = new TextEncoder().encode(JSON.stringify({ order: { order_hash: hash, chain: "gunzilla", protocol_address: protocol, status: "ACTIVE", asset: { contract, identifier: token }, remaining_quantity: 1, protocol_data: { parameters: { orderType: 0, startTime: "1893455000", endTime: "1893457000", offer: [{ itemType: 2, token: contract, identifierOrCriteria: token, startAmount: "1", endAmount: "1" }] } } } })); const o = adaptOpenSeaExactOrder({ ...input(b), context }); assert.notEqual(o.outcome, "VALID"); });

test("adapter preserves numeric type before item-type schema checks", () => {
  const source = new TextDecoder().decode(raw());
  for (const token of ['"2"', '2.0', '2e0', '-0', '2147483648', '{"kind":"number","raw":"2"}']) {
    const bytes = new TextEncoder().encode(source.replace('"itemType":2', '"itemType":' + token));
    assert.notEqual(adaptOpenSeaExactOrder(input(bytes)).outcome, "VALID", token);
  }
  assert.equal(adaptOpenSeaExactOrder(input()).outcome, "VALID");
});
test("adapter preserves numeric type before order-type and string identity checks", () => {
  const source = new TextDecoder().decode(raw());
  for (const token of ['"0"', '0.0', '0e0', '-0', '{"kind":"number","raw":"0"}']) {
    assert.notEqual(adaptOpenSeaExactOrder(input(new TextEncoder().encode(source.replace('"orderType":0', '"orderType":' + token)))).outcome, "VALID", token);
  }
  for (const field of ['"identifier":"1"', '"identifierOrCriteria":"1"', '"startAmount":"1"', '"endAmount":"1"']) {
    assert.notEqual(adaptOpenSeaExactOrder(input(new TextEncoder().encode(source.replace(field, field.replace(':"1"', ':1'))))).outcome, "VALID", field);
  }
});
const duplicateMutations: [string, string, string][] = [
  ["root.order", '{"order":', '{"order":{},"order":'],
  ["order.status", '"status":"ACTIVE"', '"status":"CANCELLED","status":"ACTIVE"'],
  ["order.order_hash", '"order_hash":', '"order_hash":"wrong","order_hash":'],
  ["asset.identifier", '"identifier":"1"', '"identifier":"2","identifier":"1"'],
  ["protocol_data", '"protocol_data":', '"protocol_data":{},"protocol_data":'],
  ["parameters.offer", '"offer":[', '"offer":[],"offer":['],
  ["offer.token", '"token":', '"token":"wrong","token":'],
  ["offer.identifier", '"identifierOrCriteria":"1"', '"identifierOrCriteria":"2","identifierOrCriteria":"1"'],
  ["unknown nested", '"status":"ACTIVE"', '"extra":{"x":1,"x":2},"status":"ACTIVE"']
];
for (const [name, from, to] of duplicateMutations) {
  test("adapter exact bytes reject duplicate " + name, () => {
    const bytes = new TextEncoder().encode(new TextDecoder().decode(raw()).replace(from, to));
    const observation = adaptOpenSeaExactOrder(input(bytes));
    assert.equal(observation.outcome, "MALFORMED");
    const provider = interpretOpenSeaExactOrderObservation({ context, observation });
    assert.equal(provider.status, "MALFORMED_RESPONSE");
    assert.equal(provider.authorityGranted, false);
  });
}
test("only original context and observation can enter trusted normalizer path", () => {
  const observation = adaptOpenSeaExactOrder(input());
  for (const clone of [{ ...context }, Object.freeze({ ...context }), structuredClone(context), JSON.parse(JSON.stringify(context))]) {
    assert.throws(() => adaptOpenSeaExactOrder({ ...input(), context: clone }), /UNTRUSTED_TARGETED_VERIFIER_CONTEXT/);
  }
  for (const clone of [{ ...observation }, Object.freeze({ ...observation }), structuredClone(observation), JSON.parse(JSON.stringify(observation))]) {
    assert.equal(isTrustedOpenSeaExactOrderObservation(clone), false);
    assert.equal(interpretOpenSeaExactOrderObservation({ context, observation: clone }).status, "PROVENANCE_MISMATCH");
  }
  assert.equal(interpretOpenSeaExactOrderObservation({ context: fixture.contexts[1], observation }).status, "PROVENANCE_MISMATCH");
  assert.equal(interpretOpenSeaExactOrderObservation({ context, observation }).status, "ACTIVE_CONFIRMED");
});
test("runtime normalizer has no public raw JSON trust entry point", async () => {
  const module = await import("../src/reconciliation/verifier/targetedVerifierNormalizer.js");
  assert.deepEqual(Object.keys(module).sort(), ["interpretOpenSeaExactOrderObservation", "validateProviderResult"]);
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/reconciliation/verifier/targetedVerifierNormalizer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /interpretTargetedOrderResponse|parseJson\(|normalizeOrder\(|rawBody|RawBody|JSON\.parse/);
  assert.equal((source.match(/RUNTIME_PROVIDER_PROOF\.add\(/g) ?? []).length, 1);
});

test("same order hash with different trusted token provenance cannot reuse an observation", async () => {
  const other = await makeTrustedContexts({ tokenId: "2" });
  try {
    const otherContext = other.contexts[0];
    assert.equal(otherContext.orderHash, context.orderHash);
    assert.notEqual(otherContext.expectedIdentity.tokenId, context.expectedIdentity.tokenId);
    const source = new TextDecoder().decode(raw())
      .replace('"identifier":"1"', '"identifier":"2"')
      .replace('"identifierOrCriteria":"1"', '"identifierOrCriteria":"2"');
    const observation = adaptOpenSeaExactOrder({ ...input(new TextEncoder().encode(source)), context: otherContext });
    assert.equal(observation.outcome, "VALID");
    assert.equal(interpretOpenSeaExactOrderObservation({ context: otherContext, observation }).status, "ACTIVE_CONFIRMED");
    assert.equal(interpretOpenSeaExactOrderObservation({ context, observation }).status, "PROVENANCE_MISMATCH");
  } finally { await disposeTrustedContexts(other.root); }
});
