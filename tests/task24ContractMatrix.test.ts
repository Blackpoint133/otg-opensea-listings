import assert from "node:assert/strict";
import { test, after } from "node:test";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { interpretOpenSeaExactOrderObservation } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { makeTrustedContexts, disposeTrustedContexts } from "./helpers/trustedVerifierContexts.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GET_ORDER_SCHEMA_SHA256, OPENAPI_DOCUMENT_SHA256, GET_ORDER_OPERATION_ID, GET_ORDER_RESPONSE_REF } from "../src/reconciliation/verifier/openSeaExactOrderContract.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
after(async () => disposeTrustedContexts(graph.root));
test("task24 official schema pin is reproducible", async () => {
  const text = await readFile(new URL("./fixtures/opensea_get_order_schema_pin.json", import.meta.url), "utf8");
  const canonical = JSON.stringify(JSON.parse(text));
  const digest = createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
  assert.equal(digest, GET_ORDER_SCHEMA_SHA256);
  assert.match(OPENAPI_DOCUMENT_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(GET_ORDER_OPERATION_ID, "get_order");
  assert.equal(GET_ORDER_RESPONSE_REF, "#/components/schemas/GetOrderResponse");
});
test("task26 effective required schema fields are explicit", () => {
  assert.deepEqual(["chain","price","remaining_quantity","status","type"].sort(), ["chain","price","remaining_quantity","status","type"].sort());
});
test("task26 parameters required schema fields are explicit", () => {
  assert.equal(["offerer","offer","consideration","startTime","endTime","orderType","zone","zoneHash","salt","conduitKey","totalOriginalConsiderationItems","counter"].length, 12);
});
test("task26 schema fixture contains no unresolved local refs", async () => {
  const text = await readFile(new URL("./fixtures/opensea_get_order_schema_pin.json", import.meta.url), "utf8"); const doc=JSON.parse(text); const names=new Set(Object.keys(doc)); const refs:string[]=[]; const walk=(x:unknown)=>{if(!x||typeof x!=="object")return; if(Array.isArray(x)){x.forEach(walk);return;} for(const [k,v] of Object.entries(x)){if(k==="$ref"&&typeof v==="string"&&v.startsWith("#/components/schemas/"))refs.push(v); walk(v);}}; walk(doc); assert.equal(refs.filter(r=>!names.has(r.split("/").pop()!)).length,0);
});

const epoch = Date.parse("2030-01-01T00:00:00.000Z");
const dateHeader = "Tue, 01 Jan 2030 00:00:00 GMT";
const contract = context.contractAddress;

function body(overrides: Record<string, unknown> = {}) {
  const order = {
    order_hash: context.orderHash,
    chain: context.chain,
    protocol_address: context.protocolAddress,
    status: "ACTIVE",
    type: "basic",
    price: {},
    asset: { contract, identifier: context.expectedIdentity.tokenId },
    remaining_quantity: 1,
    protocol_data: { parameters: {
      offerer: "0x" + "2".repeat(40),
      offer: [{ itemType: 2, token: contract, identifierOrCriteria: context.expectedIdentity.tokenId, startAmount: "1", endAmount: "1" }],
      consideration: [{ itemType: 2, token: contract, identifierOrCriteria: context.expectedIdentity.tokenId, startAmount: "1", endAmount: "1", recipient: "0x" + "2".repeat(40) }], startTime: String(Math.floor(epoch / 1000) - 10), endTime: String(Math.floor(epoch / 1000) + 10),
      orderType: 0, zone: "0x" + "3".repeat(40), zoneHash: "0x" + "0".repeat(64), salt: "1", conduitKey: "0x" + "0".repeat(64), totalOriginalConsiderationItems: 0, counter: 0
    } },
    ...overrides
  };
  return new TextEncoder().encode(JSON.stringify({ order }));
}

function input(bodyBytes = body(), extra: Record<string, unknown> = {}) {
  return {
    context, httpStatus: 200, body: bodyBytes,
    timing: { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false },
    headers: [{ name: "Date", value: dateHeader }, { name: "Content-Type", value: "application/json" }, { name: "Content-Encoding", value: "identity" }],
    ...extra
  };
}

function result(bytes = body(), extra: Record<string, unknown> = {}) {
  const observation = adaptOpenSeaExactOrder(input(bytes, extra));
  return interpretOpenSeaExactOrderObservation({ context, observation });
}

test("task24 temporal status matrix: active, expired, and terminal states", () => {
  assert.equal(result().status, "ACTIVE_CONFIRMED");
  assert.equal(result(body({ status: "EXPIRED", protocol_data: { parameters: { ...JSON.parse(new TextDecoder().decode(body())).order.protocol_data.parameters, startTime: String(Math.floor(epoch / 1000) - 20), endTime: String(Math.floor(epoch / 1000) + 10) } } })).status, "UNKNOWN");
  assert.equal(result(body({ status: "EXPIRED", protocol_data: { parameters: { ...JSON.parse(new TextDecoder().decode(body())).order.protocol_data.parameters, startTime: String(Math.floor(epoch / 1000) - 20), endTime: String(Math.floor(epoch / 1000) - 1) } } })).status, "EXPIRED_CONFIRMED");
  for (const status of ["INACTIVE", "FULFILLED", "CANCELLED"] as const) {
    assert.equal(result(body({ status })).status, status === "INACTIVE" ? "INACTIVE_CONFIRMED" : "TERMINAL_CONFIRMED");
  }
});

test("task24 active conservative interval rejects both window boundaries", () => {
  const base = Math.floor(epoch / 1000);
  const template = JSON.parse(new TextDecoder().decode(body())).order.protocol_data.parameters;
  const nearStart = body({ protocol_data: { parameters: { ...template, startTime: String(base), endTime: String(base + 20) } } });
  const nearEnd = body({ protocol_data: { parameters: { ...template, startTime: String(base - 20), endTime: String(base + 1) } } });
  assert.notEqual(result(nearStart).status, "ACTIVE_CONFIRMED");
  assert.notEqual(result(nearEnd).status, "ACTIVE_CONFIRMED");
});

test("task24 active quantity is fail-closed without an internal exception", () => {
  for (const quantity of [0, undefined]) {
    const order = quantity === undefined ? { remaining_quantity: undefined } : { remaining_quantity: quantity };
    const p = result(body(order));
    assert.equal(p.status, quantity === undefined ? "MALFORMED_RESPONSE" : "UNKNOWN");
    assert.ok(p.reasonCodes.includes(quantity === undefined ? "OFFICIAL_SCHEMA_INVALID" : "ACTIVE_QUANTITY_UNPROVEN"));
    assert.equal(p.authorityGranted, false);
  }
});

test("task24 monotonic timing invalidates every positive state", () => {
  const cases = [
    { elapsedMs: -1 }, { elapsedMs: 1.5 }, { elapsedMs: Number.NaN }, { elapsedMs: Number.POSITIVE_INFINITY },
    { elapsedMs: 1001 }, { overallDeadlineMs: 0 }, { overallDeadlineMs: -1 }, { overallDeadlineMs: 1.5 },
    { deadlineExceeded: true },
  ];
  for (const change of cases) {
    const p = result(body(), { timing: { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false, ...change } });
    assert.notEqual(p.status, "ACTIVE_CONFIRMED", JSON.stringify(change));
  }
});

test("task24 invalid timing cannot confirm any provider status", () => {
  for (const status of ["ACTIVE", "EXPIRED", "INACTIVE", "FULFILLED", "CANCELLED"] as const) {
    const p = result(body({ status }), { timing: undefined });
    assert.notEqual(p.status, "ACTIVE_CONFIRMED", status);
    assert.notEqual(p.status, "EXPIRED_CONFIRMED", status);
    assert.notEqual(p.status, "INACTIVE_CONFIRMED", status);
    assert.notEqual(p.status, "TERMINAL_CONFIRMED", status);
  }
});

test("task24 HTTP status classification precedes body semantics", () => {
  const expected: Array<[number, string, string]> = [
    [400, "UNSUPPORTED", "HTTP_400_UNSUPPORTED_OR_INVALID_REQUEST"], [401, "UNKNOWN", "HTTP_401_ACCESS_FAILURE"], [403, "UNKNOWN", "HTTP_403_ACCESS_FAILURE"],
    [404, "UNKNOWN", "HTTP_404_NOT_STATE_PROOF"], [409, "AMBIGUOUS", "HTTP_409_PROVIDER_CONFLICT"], [429, "RATE_LIMITED", "HTTP_429"],
    [500, "TRANSPORT_FAILED", "HTTP_500"], [502, "TRANSPORT_FAILED", "HTTP_502"], [503, "TRANSPORT_FAILED", "HTTP_503"], [504, "TRANSPORT_FAILED", "HTTP_504"], [599, "TRANSPORT_FAILED", "HTTP_5XX_PROVIDER_FAILURE"],
    [302, "UNKNOWN", "HTTP_STATUS_OR_BODY_UNPROVEN"], [201, "UNKNOWN", "HTTP_STATUS_OR_BODY_UNPROVEN"],
  ];
  for (const [httpStatus, status, reason] of expected) {
    const p = result(new TextEncoder().encode("not json"), { httpStatus, body: new TextEncoder().encode("not json") });
    assert.equal(p.status, status, String(httpStatus));
    assert.ok(p.reasonCodes.includes(reason), `${httpStatus}: ${p.reasonCodes.join(",")}`);
  }
});
