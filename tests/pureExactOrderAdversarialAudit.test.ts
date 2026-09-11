import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { parseLosslessJson, type LosslessJsonValue } from "../src/reconciliation/verifier/losslessJson.js";
import { isOfficialJsonInteger } from "../src/reconciliation/verifier/openSeaSchemaAdmission.js";
import { makeCanonicalOfficialOrder, encodeCanonicalOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const order = makeCanonicalOfficialOrder(context);
const body = encodeCanonicalOrder(order);
const timing = { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false } as const;
const headers = [
  { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" },
  { name: "Content-Type", value: "application/json" },
  { name: "Content-Encoding", value: "identity" },
] as const;

function input(extra: Record<string, unknown> = {}) {
  return { context, httpStatus: 200, body, timing, headers, ...extra } as any;
}

test("non-200 status classification is independent of a perfect order body", () => {
  for (const [status, outcome, reason] of [
    [400, "UNSUPPORTED", "HTTP_400_UNSUPPORTED_OR_INVALID_REQUEST"],
    [401, "UNKNOWN", "HTTP_401_ACCESS_FAILURE"], [403, "UNKNOWN", "HTTP_403_ACCESS_FAILURE"],
    [404, "UNKNOWN", "HTTP_404_NOT_STATE_PROOF"], [409, "AMBIGUOUS", "HTTP_409_PROVIDER_CONFLICT"],
    [429, "RATE_LIMITED", "HTTP_429"], [500, "TRANSPORT_FAILED", "HTTP_500"],
    [502, "TRANSPORT_FAILED", "HTTP_502"], [503, "TRANSPORT_FAILED", "HTTP_503"],
    [504, "TRANSPORT_FAILED", "HTTP_504"], [599, "TRANSPORT_FAILED", "HTTP_5XX_PROVIDER_FAILURE"],
    [302, "UNKNOWN", "HTTP_STATUS_OR_BODY_UNPROVEN"], [201, "UNKNOWN", "HTTP_STATUS_OR_BODY_UNPROVEN"],
  ] as const) {
    const observation = adaptOpenSeaExactOrder(input({ httpStatus: status }));
    assert.equal(observation.outcome, outcome, String(status));
    assert.ok(observation.reasonCodes.includes(reason), String(status));
    assert.equal(observation.providerStatus, null, String(status));
    assert.equal(observation.supportedListing, false, String(status));
  }
});

test("timeout and connection reset are transport failures before body parsing", () => {
  for (const transportOutcome of ["TIMEOUT", "CONNECTION_RESET"] as const) {
    const observation = adaptOpenSeaExactOrder(input({ transportOutcome, body: new TextEncoder().encode("not json") }));
    assert.equal(observation.outcome, "TRANSPORT_FAILED");
    assert.equal(observation.providerStatus, null);
    assert.ok(observation.reasonCodes.includes(transportOutcome === "TIMEOUT" ? "REQUEST_TIMEOUT" : "CONNECTION_RESET"));
  }
});

test("lossless parser rejects an escaped duplicate and trailing data independently", () => {
  assert.throws(() => parseLosslessJson('{"a":1,"\\u0061":2}'));
  assert.throws(() => parseLosslessJson('{"a":1} trailing'));
});

test("official integer recognition remains exact for adversarial integral spellings", () => {
  for (const raw of ["0.0", "-0.0", "0e999999999999999999999", "-0e999999999999999999999", "10e-1", "100e-2", "1000e-3", "1.000e3", "92233720368547758070e-1"]) {
    const value = parseLosslessJson(raw) as LosslessJsonValue;
    assert.equal(typeof value, "object", raw);
  }
  assert.equal(isOfficialJsonInteger(parseLosslessJson("1.2301e2")), false);
});

test("malformed non-200 body cannot override status classification", () => {
  const observation = adaptOpenSeaExactOrder(input({ httpStatus: 503, body: new TextEncoder().encode("{broken") }));
  assert.equal(observation.outcome, "TRANSPORT_FAILED");
  assert.deepEqual(observation.reasonCodes, ["HTTP_503"]);
});

test("malformed raw metadata fails closed without leaking invalid fields", () => {
  for (const extra of [
    { transportOutcome: Symbol("transport") }, { transportOutcome: "UNKNOWN" },
    { transportOutcome: 1 }, { transportOutcome: {} },
    { httpStatus: "200" }, { httpStatus: NaN }, { httpStatus: Infinity },
    { httpStatus: 200.5 }, { httpStatus: 99 }, { httpStatus: 600 },
    { body: "bytes" }, { body: 1 }, { body: false }, { body: 1n },
    { body: {} }, { body: [] }, { body: new ArrayBuffer(1) }, { body: new DataView(new ArrayBuffer(1)) },
    { responseBodySha256: Symbol("hash") }, { rawResponseArtifactHash: Symbol("artifact") },
    { timing: Symbol("timing") }, { timing: "timing" }, { timing: 1 }, { timing: [] }, { timing: null }, { timing: {} },
  ]) {
    const observation = adaptOpenSeaExactOrder(input(extra));
    assert.notEqual(observation.outcome, "VALID");
    assert.equal(observation.supportedListing, false);
    assert.equal(observation.temporalProof, "UNTRUSTED");
    assert.equal(observation.authorityGranted, false);
    assert.equal(observation.deactivationAuthorityGranted, false);
    assert.equal(observation.httpStatus === null || (typeof observation.httpStatus === "number" && Number.isInteger(observation.httpStatus)), true);
    assert.equal(observation.transportOutcome === "HTTP" || observation.transportOutcome === "TIMEOUT" || observation.transportOutcome === "CONNECTION_RESET", true);
    assert.equal(observation.timing === null || typeof observation.timing === "object", true);
  }
});

test("critical non-200 statuses remain classified with a Symbol body", () => {
  for (const [httpStatus, outcome, reason] of [[503, "TRANSPORT_FAILED", "HTTP_503"], [404, "UNKNOWN", "HTTP_404_NOT_STATE_PROOF"], [429, "RATE_LIMITED", "HTTP_429"]] as const) {
    const observation = adaptOpenSeaExactOrder(input({ httpStatus, body: Symbol("body") }));
    assert.equal(observation.outcome, outcome);
    assert.deepEqual(observation.reasonCodes, [reason]);
  }
  for (const transportOutcome of ["TIMEOUT", "CONNECTION_RESET"] as const) {
    const observation = adaptOpenSeaExactOrder(input({ transportOutcome, body: Symbol("body") }));
    assert.equal(observation.outcome, "TRANSPORT_FAILED");
    assert.ok(observation.reasonCodes.includes(transportOutcome === "TIMEOUT" ? "REQUEST_TIMEOUT" : "CONNECTION_RESET"));
  }
});

test("malformed runtime header name fails closed before header lookup", () => {
  const observation = adaptOpenSeaExactOrder(input({ headers: [{ name: null, value: "application/json" }] }));
  assert.equal(observation.outcome, "MALFORMED");
  assert.deepEqual(observation.reasonCodes, ["HEADER_INVALID"]);
  assert.equal(observation.supportedListing, false);
  assert.equal(observation.temporalProof, "UNTRUSTED");
  assert.equal(observation.authorityGranted, false);
  assert.equal(observation.deactivationAuthorityGranted, false);
});

for (const [label, headers] of [
  ["non-array container", {}], ["string container", "headers"], ["null entry", [null]],
  ["primitive entry", [1]], ["empty object entry", [{}]], ["numeric name", [{ name: 1, value: "x" }]],
  ["object name", [{ name: {}, value: "x" }]], ["null value", [{ name: "X-Test", value: null }]],
  ["numeric value", [{ name: "X-Test", value: 1 }]], ["object value", [{ name: "X-Test", value: {} }]],
  ["empty name", [{ name: "", value: "x" }]], ["CR value", [{ name: "X-Test", value: "a\r" }]],
  ["LF value", [{ name: "X-Test", value: "a\n" }]],
] as const) {
  test(`malformed header matrix: ${label}`, () => {
    const observation = adaptOpenSeaExactOrder(input({ headers }));
    assert.equal(observation.outcome, "MALFORMED");
    assert.ok(observation.reasonCodes.includes("HEADER_INVALID"));
    assert.equal(observation.supportedListing, false);
    assert.equal(observation.temporalProof, "UNTRUSTED");
    assert.equal(observation.authorityGranted, false);
    assert.equal(observation.deactivationAuthorityGranted, false);
  });
}

test("valid ordered headers preserve normal semantic processing", () => {
  const observation = adaptOpenSeaExactOrder(input());
  assert.equal(observation.outcome, "VALID");
  assert.equal(observation.supportedListing, true);
  assert.equal(observation.temporalProof, "ACTIVE_WINDOW_CONFIRMED");
});
