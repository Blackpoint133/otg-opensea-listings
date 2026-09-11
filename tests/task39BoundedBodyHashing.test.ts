import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { encodeCanonicalOrder, makeCanonicalOfficialOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const validBody = encodeCanonicalOrder(makeCanonicalOfficialOrder(context));
const headers = [
  { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" },
  { name: "Content-Type", value: "application/json" },
  { name: "Content-Encoding", value: "identity" },
];
const timing = { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false };
const input = (extra: Record<string, unknown> = {}) => ({ context, httpStatus: 200, body: validBody, headers, timing, ...extra } as any);

test("early classified branches do not hash an irrelevant supplied body", () => {
  for (const [httpStatus, outcome, reason] of [[503, "TRANSPORT_FAILED", "HTTP_503"], [404, "UNKNOWN", "HTTP_404_NOT_STATE_PROOF"], [429, "RATE_LIMITED", "HTTP_429"]] as const) {
    const observation = adaptOpenSeaExactOrder(input({ httpStatus }));
    assert.equal(observation.outcome, outcome); assert.deepEqual(observation.reasonCodes, [reason]);
    assert.equal(observation.responseBodySha256, null); assert.equal(observation.temporalProof, "UNTRUSTED");
  }
  for (const transportOutcome of ["TIMEOUT", "CONNECTION_RESET"] as const) {
    const observation = adaptOpenSeaExactOrder(input({ transportOutcome }));
    assert.equal(observation.responseBodySha256, null);
  }
});

test("oversized HTTP-200 body is rejected before SHA computation", () => {
  const observation = adaptOpenSeaExactOrder(input({ body: new Uint8Array(1048577) }));
  assert.equal(observation.outcome, "MALFORMED");
  assert.deepEqual(observation.reasonCodes, ["BODY_TOO_LARGE"]);
  assert.equal(observation.responseBodySha256, null);
});

test("bounded HTTP-200 body is hashed once for trusted valid evidence", () => {
  const expected = createHash("sha256").update(validBody).digest("hex");
  const observation = adaptOpenSeaExactOrder(input());
  assert.equal(observation.outcome, "VALID");
  assert.equal(observation.responseBodySha256, expected);
});

test("bounded malformed Content-Encoding metadata stops at HEADER_INVALID", () => {
  const observation = adaptOpenSeaExactOrder(input({ headers: [
    { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" },
    { name: "Content-Type", value: "application/json" },
    { name: "Content-Encoding", value: 123 },
  ] }));
  assert.equal(observation.outcome, "MALFORMED");
  assert.deepEqual(observation.reasonCodes, ["HEADER_INVALID"]);
  assert.equal(observation.responseBodySha256, null);
});
