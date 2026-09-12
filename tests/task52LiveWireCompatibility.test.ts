import assert from "node:assert/strict";
import { after, test } from "node:test";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { validateOfficialListingRequired, validateOpenSeaLiveCompatibleListing } from "../src/reconciliation/verifier/openSeaSchemaAdmission.js";
import { isJsonObject, parseLosslessJson, type LosslessJsonValue } from "../src/reconciliation/verifier/losslessJson.js";
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

function drift(counter: unknown, signature: unknown = null): Record<string, any> {
  const order = makeCanonicalOfficialOrder(context);
  order.protocol_data.parameters.counter = counter;
  order.protocol_data.signature = signature;
  return order;
}

test("strict Task-32 admission rejects the observed drift while live compatibility accepts it", () => {
  const order = drift("0x0", null);
  assert.equal(validateOfficialListingRequired(parsed(order)), false);
  assert.equal(validateOpenSeaLiveCompatibleListing(parsed(order)), true);
});

test("live-compatible counter accepts only bounded unsigned decimal/hex or official JSON integers", () => {
  const accepted: unknown[] = [0, "0", "7", "0x0", "0x7", (2n ** 256n - 1n).toString(10), `0x${(2n ** 256n - 1n).toString(16)}`];
  for (const value of accepted) assert.equal(validateOpenSeaLiveCompatibleListing(parsed(drift(value))), true, String(value));

  const rejected: unknown[] = ["", "-1", "+1", " 1", "1 ", "1.0", "1e3", "0x", "0xzz", (2n ** 256n).toString(10), `0x${(2n ** 256n).toString(16)}`, null, true, {}, []];
  for (const value of rejected) assert.equal(validateOpenSeaLiveCompatibleListing(parsed(drift(value))), false, String(value));
});

test("signature compatibility is limited to absent, string, and null", () => {
  const absent = makeCanonicalOfficialOrder(context);
  assert.equal(validateOpenSeaLiveCompatibleListing(parsed(absent)), true);
  for (const value of ["0xsig", null]) assert.equal(validateOpenSeaLiveCompatibleListing(parsed(drift(0, value))), true);
  for (const value of [123, true, {}, []]) assert.equal(validateOpenSeaLiveCompatibleListing(parsed(drift(0, value))), false);
  const strictString = drift(0, "0xsig");
  assert.equal(validateOfficialListingRequired(parsed(strictString)), true);
  assert.equal(validateOfficialListingRequired(parsed(drift(0, null))), false);
});

test("counter and signature exceptions are independent and adapter continues downstream semantics", () => {
  for (const [counter, signature] of [[0, null], ["0x7", "0xsig"], ["7", null]] as const) {
    const order = drift(counter, signature);
    assert.equal(validateOpenSeaLiveCompatibleListing(parsed(order)), true);
    const observation = adaptOpenSeaExactOrder(input(order));
    assert.equal(observation.outcome, "VALID");
    assert.equal(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), false);
    assert.equal(observation.authorityGranted, false);
    assert.equal(observation.deactivationAuthorityGranted, false);
  }
});

test("compatibility does not relax downstream identity", () => {
  const order = drift("0x0", null);
  order.order_hash = "0x" + "b".repeat(64);
  const observation = adaptOpenSeaExactOrder(input(order));
  assert.equal(observation.reasonCodes.includes("OFFICIAL_SCHEMA_INVALID"), false);
  assert.equal(observation.reasonCodes.includes("IDENTITY_MISMATCH"), true);
  assert.equal(observation.authorityGranted, false);
  assert.equal(observation.deactivationAuthorityGranted, false);
});
