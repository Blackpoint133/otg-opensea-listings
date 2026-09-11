import assert from "node:assert/strict";
import { after, test } from "node:test";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { interpretOpenSeaExactOrderObservation, validateProviderResult } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { makeTrustedContexts, disposeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
after(async () => disposeTrustedContexts(graph.root));

const contract = context.contractAddress;
const token = context.expectedIdentity.tokenId;
const recipient = "0x" + "2".repeat(40);

function canonicalOrder(status = "ACTIVE"): Record<string, any> {
  return {
    order_hash: context.orderHash,
    chain: context.chain,
    protocol_address: context.protocolAddress,
    status,
    type: "basic",
    price: { current: { currency: "ETH", decimals: 18, value: "1" } },
    asset: { contract, identifier: token },
    remaining_quantity: 1,
    protocol_data: { parameters: {
      offerer: recipient,
      offer: [{ itemType: 2, token: contract, identifierOrCriteria: token, startAmount: "1", endAmount: "1" }],
      consideration: [{ itemType: 2, token: contract, identifierOrCriteria: token, startAmount: "1", endAmount: "1", recipient }],
      startTime: "1893455000", endTime: "1893457000", orderType: 0,
      zone: "0x" + "3".repeat(40), zoneHash: "0x" + "0".repeat(64), salt: "1", conduitKey: "0x" + "0".repeat(64),
      totalOriginalConsiderationItems: 1, counter: 0,
    } },
  };
}

function input(order: Record<string, any>, httpStatus = 200) {
  const body = new TextEncoder().encode(JSON.stringify({ order }));
  return {
    context, httpStatus, body,
    timing: { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false },
    headers: [{ name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" }, { name: "Content-Type", value: "application/json" }, { name: "Content-Encoding", value: "identity" }],
  } as const;
}

function provider(order: Record<string, any>) {
  const observation = adaptOpenSeaExactOrder(input(order));
  const result = interpretOpenSeaExactOrderObservation({ context, observation });
  return { observation, result };
}

test("canonical schema-valid order remains ACTIVE_CONFIRMED", () => {
  const { observation, result } = provider(canonicalOrder());
  assert.equal(observation.outcome, "VALID");
  assert.equal(result.status, "ACTIVE_CONFIRMED");
  assert.equal(validateProviderResult(result), true);
});

const requiredMutations: Array<[string, (order: Record<string, any>) => void]> = [
  ["price", (o) => { delete o.price; }],
  ["type", (o) => { delete o.type; }],
  ["counter", (o) => { delete o.protocol_data.parameters.counter; }],
  ["consideration", (o) => { delete o.protocol_data.parameters.consideration; }],
  ["offerer", (o) => { delete o.protocol_data.parameters.offerer; }],
  ["remaining_quantity", (o) => { delete o.remaining_quantity; }],
];
for (const [name, mutate] of requiredMutations) {
  test(`schema admission rejects deleted ${name} without auto-healing`, () => {
    const order = structuredClone(canonicalOrder());
    mutate(order);
    const encoded = new TextDecoder().decode(new TextEncoder().encode(JSON.stringify({ order })));
    assert.equal(encoded.includes(`"${name}"`), false, name);
    const { observation, result } = provider(order);
    assert.notEqual(observation.outcome, "VALID");
    assert.ok(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
    assert.equal(result.status, "MALFORMED_RESPONSE");
    assert.ok(result.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
    assert.equal(validateProviderResult(result), true);
    assert.equal(result.authorityGranted, false);
  });
}

for (const status of ["ACTIVE", "INACTIVE", "FULFILLED", "CANCELLED", "EXPIRED"] as const) {
  test(`missing remaining_quantity fails schema admission for ${status}`, () => {
    const order = canonicalOrder(status);
    delete order.remaining_quantity;
    const { observation, result } = provider(order);
    assert.notEqual(observation.outcome, "VALID");
    assert.deepEqual(observation.reasonCodes, ["OFFICIAL_SCHEMA_INVALID"]);
    assert.equal(result.status, "MALFORMED_RESPONSE");
    assert.ok(result.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
    assert.equal(validateProviderResult(result), true);
  });
}

test("ACTIVE zero quantity remains semantic ACTIVE_QUANTITY_UNPROVEN", () => {
  const { observation, result } = provider({ ...canonicalOrder(), remaining_quantity: 0 });
  assert.notEqual(observation.outcome, "VALID");
  assert.equal(result.status, "UNKNOWN");
  assert.ok(result.reasonCodes.includes("ACTIVE_QUANTITY_UNPROVEN"));
  assert.equal(validateProviderResult(result), true);
});

test("schema-invalid, valid, and non-200 requests do not leak reasons across calls", () => {
  const invalid = canonicalOrder(); delete invalid.price;
  const first = provider(invalid);
  assert.ok(first.result.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
  const second = provider(canonicalOrder());
  assert.equal(second.observation.outcome, "VALID");
  assert.equal(second.result.status, "ACTIVE_CONFIRMED");
  const thirdObservation = adaptOpenSeaExactOrder(input(canonicalOrder(), 404));
  const third = interpretOpenSeaExactOrderObservation({ context, observation: thirdObservation });
  assert.equal(thirdObservation.outcome, "UNKNOWN");
  assert.deepEqual(thirdObservation.reasonCodes, ["HTTP_404_NOT_STATE_PROOF"]);
  assert.ok(third.reasonCodes.includes("HTTP_404_NOT_STATE_PROOF"));
});

for (const [name, mutate] of [
  ["offer missing", (o: any) => { delete o.protocol_data.parameters.offer; }],
  ["offer empty", (o: any) => { o.protocol_data.parameters.offer = []; }],
  ["offer item wrong type", (o: any) => { o.protocol_data.parameters.offer = ["bad"]; }],
  ["parameters missing", (o: any) => { delete o.protocol_data.parameters; }],
  ["asset missing", (o: any) => { delete o.asset; }],
] as const) {
  test(`malformed parseable shape ${name} fails without throw`, () => {
    const order = canonicalOrder(); mutate(order);
    const { observation, result } = provider(order);
    assert.notEqual(observation.outcome, "VALID");
    assert.equal(validateProviderResult(result), true);
  });
}
