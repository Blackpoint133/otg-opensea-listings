import assert from "node:assert/strict";
import { after, test } from "node:test";
import { adaptOpenSeaExactOrder, OPENSEA_EXACT_ORDER_ADAPTER_VERSION } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { officialJsonInt64Value, validateOfficialListingRequired } from "../src/reconciliation/verifier/openSeaSchemaAdmission.js";
import { isJsonObject, parseLosslessJson, type LosslessJsonValue } from "../src/reconciliation/verifier/losslessJson.js";
import { interpretOpenSeaExactOrderObservation, validateProviderResult } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { encodeCanonicalOrder, makeCanonicalOfficialOrder } from "./helpers/openSeaCanonicalOrder.js";
import { disposeTrustedContexts, makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
after(async () => disposeTrustedContexts(graph.root));

function parsed(order: Record<string, any>): Record<string, LosslessJsonValue> {
  const root = parseLosslessJson(new TextDecoder().decode(encodeCanonicalOrder(order)));
  assert.equal(isJsonObject(root), true);
  const value = (root as Record<string, LosslessJsonValue>).order;
  assert.equal(isJsonObject(value), true);
  return value as Record<string, LosslessJsonValue>;
}

function input(order: Record<string, any>) {
  return {
    context, httpStatus: 200, body: encodeCanonicalOrder(order),
    timing: { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false },
    headers: [
      { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" },
      { name: "Content-Type", value: "application/json" },
      { name: "Content-Encoding", value: "identity" },
    ],
  } as const;
}

function withCreatedRaw(raw: string): Uint8Array {
  const source = new TextDecoder().decode(encodeCanonicalOrder(makeCanonicalOfficialOrder(context)));
  return new TextEncoder().encode(source.replace('"type":"basic"', '"order_created_at":' + raw + ',"type":"basic"'));
}

function parsedBytes(bytes: Uint8Array): Record<string, LosslessJsonValue> {
  const root = parseLosslessJson(new TextDecoder().decode(bytes)) as Record<string, LosslessJsonValue>;
  return root.order as Record<string, LosslessJsonValue>;
}

function fullPath(order: Record<string, any>) {
  const observation = adaptOpenSeaExactOrder(input(order));
  const result = interpretOpenSeaExactOrderObservation({ context, observation });
  assert.equal(validateProviderResult(result), true);
  return { observation, result };
}

test("optional schema fields are absent by default and canonical order remains valid", () => {
  const order = makeCanonicalOfficialOrder(context);
  assert.equal(validateOfficialListingRequired(parsed(order)), true);
  assert.equal(fullPath(order).observation.adapterVersion, OPENSEA_EXACT_ORDER_ADAPTER_VERSION);
});

test("order_created_at accepts signed int64 bounds and integral spellings", () => {
  for (const raw of ["-9223372036854775808", "9223372036854775807", "1.0", "1e2"]) {
    const value = parsedBytes(withCreatedRaw(raw)).order_created_at;
    assert.notEqual(officialJsonInt64Value(value), null, raw);
    assert.equal(validateOfficialListingRequired(parsedBytes(withCreatedRaw(raw))), true, raw);
  }
});

for (const [name, value] of [
  ["below minimum", "-9223372036854775809"], ["above maximum", "9223372036854775808"],
  ["fractional", "1.5"], ["string", "bad"],
] as const) {
  test(`order_created_at rejects ${name}`, () => {
    const bytes = value === "bad"
      ? new TextEncoder().encode(new TextDecoder().decode(withCreatedRaw('"bad"')).replace('"order_created_at":"bad"', '"order_created_at":"bad"'))
      : withCreatedRaw(value);
    const observation = adaptOpenSeaExactOrder({ ...input(makeCanonicalOfficialOrder(context)), body: bytes });
    assert.ok(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
    assert.notEqual(observation.outcome, "VALID");
  });
}

test("protocol and protocol_data.signature are optional strings", () => {
  const absent = makeCanonicalOfficialOrder(context);
  assert.equal(validateOfficialListingRequired(parsed(absent)), true);
  const valid = makeCanonicalOfficialOrder(context); valid.protocol = "seaport"; valid.protocol_data.signature = "0xsignature";
  assert.equal(validateOfficialListingRequired(parsed(valid)), true);
  for (const [field, mutate] of [["protocol", (o: any) => { o.protocol = 123; }], ["signature", (o: any) => { o.protocol_data.signature = 123; }]] as const) {
    const order = makeCanonicalOfficialOrder(context); mutate(order);
    const { observation } = fullPath(order);
    assert.ok(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), field);
  }
});

const validSvm = { creation_signature: "sig", id: "sig:state", maker: "maker", order_state: "state", asset_id: "asset" };
test("svm_order accepts the exact optional SvmOrderIdentity shape", () => {
  const order = makeCanonicalOfficialOrder(context); order.svm_order = validSvm;
  assert.equal(validateOfficialListingRequired(parsed(order)), true);
  const withoutOptional = makeCanonicalOfficialOrder(context); withoutOptional.svm_order = { creation_signature: "sig", id: "id", maker: "maker", order_state: "state" };
  assert.equal(validateOfficialListingRequired(parsed(withoutOptional)), true);
});

for (const field of ["creation_signature", "id", "maker", "order_state"] as const) {
  test(`svm_order missing ${field} is rejected`, () => {
    const order = makeCanonicalOfficialOrder(context); order.svm_order = { ...validSvm }; delete order.svm_order[field];
    const { observation } = fullPath(order);
    assert.ok(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
    assert.notEqual(observation.outcome, "VALID");
  });
  test(`svm_order ${field} must be a string`, () => {
    const order = makeCanonicalOfficialOrder(context); order.svm_order = { ...validSvm, [field]: 1 };
    const { observation } = fullPath(order);
    assert.ok(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
  });
}

for (const [name, value] of [["asset_id", 1], ["null", null], ["array", []], ["primitive", "bad"]] as const) {
  test(`svm_order ${name} is rejected`, () => {
    const order = makeCanonicalOfficialOrder(context); order.svm_order = name === "asset_id" ? { ...validSvm, asset_id: value } : value;
    const { observation } = fullPath(order);
    assert.ok(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"));
  });
}
