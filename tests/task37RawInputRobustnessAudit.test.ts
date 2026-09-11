import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { encodeCanonicalOrder, makeCanonicalOfficialOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const orderBody = encodeCanonicalOrder(makeCanonicalOfficialOrder(context));
const validHeaders = [
  { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 GMT" },
  { name: "Content-Type", value: "application/json" },
  { name: "Content-Encoding", value: "identity" },
];
const timing = { requestStartedAt: "2030-01-01T00:00:00.000Z", responseHeadersAt: "2030-01-01T00:00:00.100Z", responseCompletedAt: "2030-01-01T00:00:00.200Z", elapsedMs: 10, overallDeadlineMs: 1000, deadlineExceeded: false };

function raw(extra: Record<string, unknown>) {
  return { context, httpStatus: 200, body: orderBody, headers: validHeaders, timing, ...extra } as any;
}

test("audit reproducer: Symbol httpStatus throws before fail-closed classification", () => {
  assert.throws(() => adaptOpenSeaExactOrder(raw({ httpStatus: Symbol("status") })));
});

test("audit reproducer: Symbol body throws while constructing bytes", () => {
  assert.throws(() => adaptOpenSeaExactOrder(raw({ body: Symbol("body") })));
});
