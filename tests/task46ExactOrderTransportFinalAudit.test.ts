import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { __executeOpenSeaExactOrderRequestForTest as executeTest, type OpenSeaRequestFactory, type OpenSeaTransportClock } from "../src/reconciliation/verifier/openSeaExactOrderTransport.js";
import { makeCanonicalOfficialOrder, encodeCanonicalOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const body = encodeCanonicalOrder(makeCanonicalOfficialOrder(context));
const headers = ["Date", "Tue, 01 Jan 2030 00:00:00 GMT", "Content-Type", "application/json", "Content-Encoding", "identity"];
class Clock implements OpenSeaTransportClock { mono = 0n; pending: (() => void) | null = null; nowWall() { return Date.parse("2030-01-01T00:00:00.000Z"); } nowMonotonic() { return this.mono; } setTimeout(cb: () => void) { this.pending = cb; return cb; } clearTimeout() { this.pending = null; } }
class Response extends EventEmitter { destroyed = 0; constructor(readonly statusCode = 200, readonly rawHeaders = headers) { super(); } destroy() { this.destroyed++; this.emit("error", new Error("destroy")); } }
class Request extends EventEmitter { ended = 0; destroyed = 0; constructor(private readonly done: () => void) { super(); } end() { this.ended++; this.done(); } destroy() { this.destroyed++; this.emit("error", new Error("destroy")); } }

test("odd native rawHeaders vector fails closed without fabricated valid evidence", async () => {
  const response = new Response(200, ["Content-Type", "application/json", "Date"]);
  const factory: OpenSeaRequestFactory = (_options, callback) => new Request(() => { callback(response); response.emit("data", body); response.emit("end"); });
  const result = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory, clock: new Clock() });
  assert.equal(result.outcome, "MALFORMED"); assert.ok(result.reasonCodes.includes("HEADER_INVALID")); assert.equal(result.supportedListing, false);
});

test("malformed stream data after monotonic expiry is timeout, not malformed body", async () => {
  const clock = new Clock(); const response = new Response();
  const factory: OpenSeaRequestFactory = (_options, callback) => new Request(() => { callback(response); clock.mono = 2_000_000n; response.emit("data", Symbol("malformed")); });
  const result = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory: factory, clock });
  assert.deepEqual(result.reasonCodes, ["REQUEST_TIMEOUT"]); assert.equal(result.responseBodySha256, null); response.emit("error", new Error("late"));
});

test("one invocation has one factory call and one physical server-attempt counter", async () => {
  let factoryCalls = 0; let serverRequests = 0;
  const factory: OpenSeaRequestFactory = (_options, callback) => { factoryCalls++; return new Request(() => { serverRequests++; callback(new Response(404)); }); };
  const result = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory, clock: new Clock() });
  assert.deepEqual(result.reasonCodes, ["HTTP_404_NOT_STATE_PROOF"]); assert.equal(factoryCalls, 1); assert.equal(serverRequests, 1);
});

test("production surface and localhost integration are isolated from external networking", async () => {
  const transport = await readFile("src/reconciliation/verifier/openSeaExactOrderTransport.ts", "utf8");
  assert.doesNotMatch(transport, /requestFactory\?:|clock\?:|hostname\?:|origin\?:|URL|rejectUnauthorized\s*:\s*false/);
  assert.match(transport, /export function executeOpenSeaExactOrderRequest\(input: \{ readonly context: TargetedVerifierContext; readonly apiKey: string; readonly overallDeadlineMs: number; \}\)/);
  const integration = await readFile("tests/openSeaExactOrderLocalhostHttpsMatrix.test.ts", "utf8");
  assert.match(integration, /server\.listen\(0, "127\.0\.0\.1"/); assert.match(integration, /hostname: "127\.0\.0\.1"/);
  assert.doesNotMatch(integration, /fetch\(|axios|undici|net\.connect|tls\.connect|curl/);
});
