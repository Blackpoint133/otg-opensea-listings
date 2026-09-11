import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { interpretOpenSeaExactOrderObservation, validateProviderResult } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { isOfficialJsonInteger, officialJsonInt32Value, officialJsonInt64Value } from "../src/reconciliation/verifier/openSeaSchemaAdmission.js";
import { parseLosslessJson } from "../src/reconciliation/verifier/losslessJson.js";
import { makeCanonicalOfficialOrder, encodeCanonicalOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const timing = { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false } as const;
const headers = [
  { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" },
  { name: "Content-Type", value: "application/json" },
  { name: "Content-Encoding", value: "identity" },
] as const;
const canonical = makeCanonicalOfficialOrder(context);
const body = encodeCanonicalOrder(canonical);
const input = (extra: Record<string, unknown> = {}) => ({ context, httpStatus: 200, body, headers, timing, ...extra }) as any;

test("Task-41 status precedence ignores a very large supplied body", () => {
  for (const [httpStatus, outcome, reason] of [[503, "TRANSPORT_FAILED", "HTTP_503"], [404, "UNKNOWN", "HTTP_404_NOT_STATE_PROOF"], [429, "RATE_LIMITED", "HTTP_429"]] as const) {
    const observation = adaptOpenSeaExactOrder(input({ httpStatus, body: new Uint8Array(8 * 1024 * 1024) }));
    assert.equal(observation.outcome, outcome);
    assert.deepEqual(observation.reasonCodes, [reason]);
    assert.equal(observation.responseBodySha256, null);
    assert.equal(observation.providerStatus, null);
  }
});

test("Task-41 malformed raw metadata remains fail closed and sanitized", () => {
  const cases = [
    { transportOutcome: Symbol("transport") }, { transportOutcome: 1 }, { transportOutcome: {} },
    { httpStatus: Symbol("status") }, { httpStatus: "200" }, { httpStatus: 200.5 }, { httpStatus: 200n },
    { body: Symbol("body") }, { body: "bytes" }, { body: new ArrayBuffer(1) }, { body: new DataView(new ArrayBuffer(1)) },
    { responseBodySha256: 123 }, { responseBodySha256: Symbol("hash") },
    { rawResponseArtifactHash: 123 }, { rawResponseArtifactHash: Symbol("artifact") },
    { timing: Symbol("timing") }, { timing: null }, { timing: [] }, { timing: {} },
  ];
  for (const extra of cases) {
    const observation = adaptOpenSeaExactOrder(input(extra));
    assert.notEqual(observation.outcome, "VALID");
    assert.equal(observation.supportedListing, false);
    assert.equal(observation.temporalProof, "UNTRUSTED");
    assert.equal(observation.authorityGranted, false);
    assert.equal(observation.deactivationAuthorityGranted, false);
    assert.ok(observation.httpStatus === null || (typeof observation.httpStatus === "number" && Number.isInteger(observation.httpStatus)));
    assert.ok(["HTTP", "TIMEOUT", "CONNECTION_RESET"].includes(observation.transportOutcome));
    assert.ok(observation.timing === null || typeof observation.timing === "object");
  }
});

test("Task-41 malformed Content-Encoding value stops before string operations", () => {
  const observation = adaptOpenSeaExactOrder(input({ headers: [{ name: "Content-Encoding", value: 123 }] }));
  assert.equal(observation.outcome, "MALFORMED");
  assert.deepEqual(observation.reasonCodes, ["HEADER_INVALID"]);
  assert.equal(observation.responseBodySha256, null);
});

test("Task-41 official integer recognition handles lexical mathematical integers", () => {
  const integral = ["0", "-0", "0.0", "-0.0", "0e0", "0e999999999", "0e999999999999999999999", "-0e999999999999999999999", "10e-1", "100e-2", "1000e-3", "1.000e3", "9223372036854775807.0", "92233720368547758070e-1"];
  for (const raw of integral) assert.equal(isOfficialJsonInteger(parseLosslessJson(raw)), true, raw);
  for (const raw of ["1001e-3", "1.2301e2", "1.5", "1e-1"]) assert.equal(isOfficialJsonInteger(parseLosslessJson(raw)), false, raw);
  assert.equal(officialJsonInt32Value(parseLosslessJson("-2147483648.0")), -2147483648);
  assert.equal(officialJsonInt32Value(parseLosslessJson("2147483647e0")), 2147483647);
  assert.equal(officialJsonInt32Value(parseLosslessJson("2147483648e0")), null);
  assert.equal(officialJsonInt32Value(parseLosslessJson("-2147483649e0")), null);
  assert.equal(officialJsonInt64Value(parseLosslessJson("-9223372036854775808")), -9223372036854775808n);
  assert.equal(officialJsonInt64Value(parseLosslessJson("9223372036854775807.0")), 9223372036854775807n);
  assert.equal(officialJsonInt64Value(parseLosslessJson("9223372036854775808")), null);
  assert.equal(officialJsonInt64Value(parseLosslessJson("-9223372036854775809")), null);
});

test("Task-41 huge exponents do not create a bounded integer or trusted positive state", () => {
  assert.equal(officialJsonInt64Value(parseLosslessJson("1e999999999999999999999")), null);
  assert.equal(officialJsonInt64Value(parseLosslessJson("-1e999999999999999999999")), null);
  const huge = JSON.parse(JSON.stringify(canonical));
  huge.protocol_data.parameters.startTime = "9007199254740993";
  huge.protocol_data.parameters.endTime = "9007199254741993";
  const observation = adaptOpenSeaExactOrder(input({ body: encodeCanonicalOrder(huge) }));
  assert.notEqual(observation.outcome, "VALID");
  assert.notEqual(observation.temporalProof, "ACTIVE_WINDOW_CONFIRMED");
});

test("Task-41 schema-valid targeted-unsupported values are not official-schema failures", () => {
  for (const [label, mutate] of [
    ["order_hash", (o: any) => delete o.order_hash],
    ["protocol_address", (o: any) => delete o.protocol_address],
    ["protocol_data", (o: any) => delete o.protocol_data],
    ["asset", (o: any) => delete o.asset],
    ["empty offer", (o: any) => { o.protocol_data.parameters.offer = []; }],
    ["negative orderType", (o: any) => { o.protocol_data.parameters.orderType = -1; }],
    ["wrong itemType", (o: any) => { o.protocol_data.parameters.offer[0].itemType = 1; }],
    ["non-unit amount", (o: any) => { o.protocol_data.parameters.offer[0].startAmount = "2"; }],
  ]) {
    const value = JSON.parse(JSON.stringify(canonical)); mutate(value);
    const observation = adaptOpenSeaExactOrder(input({ body: encodeCanonicalOrder(value) }));
    assert.notEqual(observation.outcome, "VALID", String(label));
    assert.ok(!observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), `${label}: ${observation.reasonCodes.join(",")}`);
    const result = interpretOpenSeaExactOrderObservation({ context, observation });
    assert.equal(validateProviderResult(result), true);
    assert.equal(result.authorityGranted, false);
  }
});

test("Task-41 empty consideration has no invented official cardinality restriction", () => {
  const value = JSON.parse(JSON.stringify(canonical));
  value.protocol_data.parameters.consideration = [];
  const observation = adaptOpenSeaExactOrder(input({ body: encodeCanonicalOrder(value) }));
  assert.notEqual(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), true);
  assert.equal(observation.supportedListing, true);
});

test("Task-41 bounded HTTP-200 body hash is exact and retained on malformed JSON", () => {
  const expected = createHash("sha256").update(body).digest("hex");
  const valid = adaptOpenSeaExactOrder(input());
  assert.equal(valid.responseBodySha256, expected);
  const malformedBody = new TextEncoder().encode("{broken");
  const malformed = adaptOpenSeaExactOrder(input({ body: malformedBody }));
  assert.equal(malformed.outcome, "MALFORMED");
  assert.equal(malformed.responseBodySha256, null);
});

test("Task-41 provenance rejects copies and cross-context observations", async () => {
  const observation = adaptOpenSeaExactOrder(input());
  assert.equal(validateProviderResult(interpretOpenSeaExactOrderObservation({ context, observation })), true);
  const copy = { ...observation };
  const copied = interpretOpenSeaExactOrderObservation({ context, observation: copy as any });
  assert.equal(copied.status, "PROVENANCE_MISMATCH");
  assert.equal(validateProviderResult(copied), true);
  const other = await makeTrustedContexts({ tokenId: "99" });
  const cross = interpretOpenSeaExactOrderObservation({ context: other.contexts[0], observation });
  assert.equal(cross.status, "PROVENANCE_MISMATCH");
  assert.equal(validateProviderResult(cross), true);
});
