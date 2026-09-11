import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { __executeOpenSeaExactOrderRequestForTest as executeTest, executeOpenSeaExactOrderRequest, MAX_OVERALL_DEADLINE_MS, type OpenSeaRequestFactory, type OpenSeaTransportClock, type OpenSeaTransportRequestOptions } from "../src/reconciliation/verifier/openSeaExactOrderTransport.js";
import { makeCanonicalOfficialOrder, encodeCanonicalOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const body = encodeCanonicalOrder(makeCanonicalOfficialOrder(context));
const rawHeaders = ["Date", "Tue, 01 Jan 2030 00:00:00 GMT", "Content-Type", "application/json", "Content-Encoding", "identity"];

class FakeResponse extends EventEmitter { statusCode?: number; rawHeaders?: string[]; destroyed = 0; constructor(status: number, headers = rawHeaders, private readonly errorOnDestroy = false) { super(); this.statusCode = status; this.rawHeaders = headers; } destroy() { this.destroyed++; if (this.errorOnDestroy) this.emit("error", new Error("late response error")); } }
class FakeRequest extends EventEmitter { destroyed = 0; ended = 0; constructor(private readonly onEnd: () => void, private readonly errorOnDestroy = false) { super(); } end() { this.ended++; this.onEnd(); } destroy() { this.destroyed++; if (this.errorOnDestroy) this.emit("error", new Error("late request error")); } }
class FakeClock implements OpenSeaTransportClock { wall = Date.parse("2030-01-01T00:00:00.000Z"); mono = 0n; pending: (() => void) | null = null; nowWall() { return this.wall; } nowMonotonic() { return this.mono; } setTimeout(callback: () => void) { this.pending = callback; return callback; } clearTimeout() { this.pending = null; } fire() { this.pending?.(); } }
function factoryFor(response: FakeResponse, capture: { options?: OpenSeaTransportRequestOptions; request?: FakeRequest; chunksSeen?: number }): OpenSeaRequestFactory { return (options, callback) => { capture.options = options; const request = new FakeRequest(() => { callback(response); }); capture.request = request; return request; }; }
function streamingFactory(response: FakeResponse, chunks: Uint8Array[], capture: { options?: OpenSeaTransportRequestOptions; request?: FakeRequest; chunksSeen?: number }): OpenSeaRequestFactory { return (options, callback) => { capture.options = options; const request = new FakeRequest(() => { callback(response); if (response.destroyed) return; for (const chunk of chunks) { capture.chunksSeen = (capture.chunksSeen ?? 0) + chunk.byteLength; response.emit("data", chunk); if (response.destroyed) break; } if (!response.destroyed) response.emit("end"); }); capture.request = request; return request; }; }

test("transport constructs one fixed HTTPS request from trusted context", async () => {
  const capture: { options?: OpenSeaTransportRequestOptions; request?: FakeRequest } = {};
  const response = new FakeResponse(503);
  const observation = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factoryFor(response, capture), clock: new FakeClock() });
  assert.equal(capture.options?.hostname, "api.opensea.io"); assert.equal(capture.options?.protocol, "https:"); assert.equal(capture.options?.method, "GET");
  assert.equal(capture.options?.path, `/api/v2/orders/chain/${context.chain}/protocol/${context.protocolAddress}/${context.orderHash}`);
  assert.deepEqual(capture.options?.headers, { Accept: "application/json", "X-API-KEY": "TEST_ONLY_FAKE_OPENSEA_KEY" });
  assert.equal(observation.reasonCodes[0], "HTTP_503"); assert.equal(capture.request?.ended, 1);
});

test("transport rejects credentials and untrusted context before request creation", async () => {
  let calls = 0; const factory = ((() => { calls++; throw new Error("must not call"); }) as unknown) as OpenSeaRequestFactory;
  for (const apiKey of ["", "bad\rkey", "bad\nkey"]) assert.throws(() => executeTest({ context, apiKey, overallDeadlineMs: 1000, requestFactory: factory, clock: new FakeClock() }), /INVALID_OPENSEA_API_KEY/);
  const clone = { ...context };
  assert.throws(() => executeTest({ context: clone as any, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory, clock: new FakeClock() }), /UNTRUSTED_TARGETED_VERIFIER_CONTEXT/);
  assert.equal(calls, 0);
});

test("production API has fixed dependency surface and deadline is explicitly bounded", () => {
  assert.equal(typeof executeOpenSeaExactOrderRequest, "function");
  assert.equal(MAX_OVERALL_DEADLINE_MS, 2147483647);
  assert.throws(() => executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: MAX_OVERALL_DEADLINE_MS + 1, requestFactory: (() => { throw new Error("must not call"); }) as any, clock: new FakeClock() }), /INVALID_OVERALL_DEADLINE/);
});

test("bounded HTTP-200 body is adapted with identical result across chunk boundaries", async () => {
  const expected = createHash("sha256").update(body).digest("hex");
  const results = [];
  for (const chunks of [ [body], Array.from(body, (byte) => new Uint8Array([byte])), [body.slice(0, 7), body.slice(7, 101), body.slice(101)] ]) {
    const response = new FakeResponse(200); const capture: any = {}; const clock = new FakeClock();
    results.push(await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, chunks, capture), clock }));
  }
  for (const result of results) { assert.equal(result.outcome, "VALID"); assert.equal(result.responseBodySha256, expected); assert.equal(result.timing?.deadlineExceeded, false); }
  assert.deepEqual(results.map((result) => result.responseBodySha256), [expected, expected, expected]);
});

test("oversized HTTP-200 response retains only 1 MiB plus one byte", async () => {
  const capture: any = {}; const response = new FakeResponse(200); const first = new Uint8Array(2 * 1048576); const second = new Uint8Array(1024);
  const observation = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, [first, second], capture), clock: new FakeClock() });
  assert.equal(capture.chunksSeen, first.byteLength); assert.equal(response.destroyed, 1);
  assert.equal(observation.outcome, "MALFORMED"); assert.deepEqual(observation.reasonCodes, ["BODY_TOO_LARGE"]); assert.equal(observation.responseBodySha256, null);
});

test("non-200 responses ignore large bodies and preserve status classification", async () => {
  for (const [status, reason] of [[404, "HTTP_404_NOT_STATE_PROOF"], [429, "HTTP_429"], [503, "HTTP_503"], [302, "HTTP_STATUS_OR_BODY_UNPROVEN"]] as const) {
    const response = new FakeResponse(status); const capture: any = {};
    const observation = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, [new Uint8Array(8 * 1048576)], capture), clock: new FakeClock() });
    assert.deepEqual(observation.reasonCodes, [reason]); assert.equal(observation.responseBodySha256, null); assert.equal(capture.chunksSeen, undefined); assert.equal(response.destroyed, 1);
  }
});

test("duplicate raw headers and unsupported encoding reach the accepted adapter unchanged", async () => {
  const duplicate = ["Date", "Tue, 01 Jan 2030 00:00:00 GMT", "Date", "Tue, 01 Jan 2030 00:00:00 GMT", "Content-Type", "application/json", "Content-Type", "application/json", "Content-Encoding", "gzip", "Content-Length", String(body.length), "Content-Length", String(body.length)];
  const response = new FakeResponse(200, duplicate); const observation = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, [body], {}), clock: new FakeClock() });
  assert.equal(observation.outcome, "UNSUPPORTED"); assert.ok(observation.reasonCodes.includes("UNSUPPORTED_CONTENT_ENCODING"));
});

test("timeout, connection failure and late events settle exactly once", async () => {
  const clock = new FakeClock(); let lateResponse: FakeResponse | undefined; const request = new FakeRequest(() => {}, true);
  const factory: OpenSeaRequestFactory = (_options, callback) => { lateResponse = new FakeResponse(200); (request as any).late = () => callback(lateResponse!); return request; };
  const pending = executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory, clock }); clock.fire(); const timeout = await pending;
  assert.equal(timeout.outcome, "TRANSPORT_FAILED"); assert.deepEqual(timeout.reasonCodes, ["REQUEST_TIMEOUT"]); assert.equal(request.destroyed, 1); (request as any).late(); assert.equal(timeout.reasonCodes.length, 1);
  const errorRequest = new FakeRequest(() => {}); const errorResult = executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: (() => errorRequest) as any, clock: new FakeClock() }); errorRequest.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" })); const reset = await errorResult; assert.deepEqual(reset.reasonCodes, ["CONNECTION_RESET"]);
});

test("claim-before-destroy preserves timeout, status and oversized results", async () => {
  const timeoutClock = new FakeClock(); const timeoutRequest = new FakeRequest(() => {}, true);
  const timeoutPending = executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: (() => timeoutRequest) as any, clock: timeoutClock }); timeoutClock.fire(); const timeout = await timeoutPending;
  assert.deepEqual(timeout.reasonCodes, ["REQUEST_TIMEOUT"]); assert.equal(timeoutRequest.destroyed, 1);
  for (const [status, reason] of [[404, "HTTP_404_NOT_STATE_PROOF"], [503, "HTTP_503"], [429, "HTTP_429"]] as const) {
    const response = new FakeResponse(status, rawHeaders, true); const result = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factoryFor(response, {}), clock: new FakeClock() }); assert.deepEqual(result.reasonCodes, [reason]);
  }
  const response = new FakeResponse(200, rawHeaders, true); const oversized = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, [new Uint8Array(1048577)], {}), clock: new FakeClock() });
  assert.deepEqual(oversized.reasonCodes, ["BODY_TOO_LARGE"]); assert.equal(oversized.responseBodySha256, null);
});

test("monotonic deadline is rechecked at headers and completion", async () => {
  const lateHeaders = new FakeClock(); const headerResponse = new FakeResponse(404); const headerFactory: OpenSeaRequestFactory = (_options, callback) => new FakeRequest(() => { lateHeaders.mono = 2_000_000n; callback(headerResponse); }); const headerResult = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory: headerFactory, clock: lateHeaders });
  assert.deepEqual(headerResult.reasonCodes, ["REQUEST_TIMEOUT"]);
  const lateEnd = new FakeClock(); let response!: FakeResponse;
  const factory: OpenSeaRequestFactory = (_options, callback) => new FakeRequest(() => { response = new FakeResponse(200); callback(response); response.emit("data", body); lateEnd.mono = 2_000_000n; response.emit("end"); });
  const endResult = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory: factory, clock: lateEnd });
  assert.deepEqual(endResult.reasonCodes, ["REQUEST_TIMEOUT"]);
  const exact = new FakeClock(); exact.mono = 1_000_000n; const exactResult = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory: factoryFor(new FakeResponse(404), {}), clock: exact });
  assert.deepEqual(exactResult.reasonCodes, ["HTTP_404_NOT_STATE_PROOF"]);
});

test("overdue oversized body is TIMEOUT before BODY_TOO_LARGE and pending timer cannot win", async () => {
  const clock = new FakeClock(); let response!: FakeResponse;
  const factory: OpenSeaRequestFactory = (_options, callback) => new FakeRequest(() => { response = new FakeResponse(200, rawHeaders, true); callback(response); clock.mono = 2_000_000n; response.emit("data", new Uint8Array(1048577)); });
  const result = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory: factory, clock });
  assert.deepEqual(result.reasonCodes, ["REQUEST_TIMEOUT"]); assert.equal(result.responseBodySha256, null); assert.equal(response.destroyed, 1); clock.fire(); assert.deepEqual(result.reasonCodes, ["REQUEST_TIMEOUT"]);
});

test("oversized body exactly at deadline preserves BODY_TOO_LARGE boundary", async () => {
  const clock = new FakeClock(); let response!: FakeResponse;
  const factory: OpenSeaRequestFactory = (_options, callback) => new FakeRequest(() => { response = new FakeResponse(200); callback(response); clock.mono = 1_000_000n; response.emit("data", new Uint8Array(1048577)); });
  const result = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory: factory, clock });
  assert.deepEqual(result.reasonCodes, ["BODY_TOO_LARGE"]); assert.equal(result.responseBodySha256, null);
});

test("response and request errors after deadline become TIMEOUT, within deadline remain reset", async () => {
  const responseClock = new FakeClock(); let response!: FakeResponse;
  const responseFactory: OpenSeaRequestFactory = (_options, callback) => new FakeRequest(() => { response = new FakeResponse(200, rawHeaders, true); callback(response); responseClock.mono = 2_000_000n; response.emit("error", new Error("late")); });
  const lateResponse = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory: responseFactory, clock: responseClock }); assert.deepEqual(lateResponse.reasonCodes, ["REQUEST_TIMEOUT"]);
  const requestClock = new FakeClock(); const request = new FakeRequest(() => {}, true); const requestFactory: OpenSeaRequestFactory = () => request; const pending = executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1, requestFactory, clock: requestClock }); requestClock.mono = 2_000_000n; request.emit("error", new Error("late")); assert.deepEqual((await pending).reasonCodes, ["REQUEST_TIMEOUT"]);
  const withinClock = new FakeClock(); const withinRequest = new FakeRequest(() => {}, true); const within = executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 10, requestFactory: (() => withinRequest) as any, clock: withinClock }); withinRequest.emit("error", new Error("reset")); assert.deepEqual((await within).reasonCodes, ["CONNECTION_RESET"]);
});

test("transport performs no redirect or retry", async () => {
  let calls = 0; const response = new FakeResponse(302, ["Location", "https://evil.example/"]); const factory: OpenSeaRequestFactory = (options, callback) => { calls++; return new FakeRequest(() => callback(response)); };
  const observation = await executeTest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory, clock: new FakeClock() });
  assert.equal(calls, 1); assert.equal(observation.outcome, "UNKNOWN"); assert.equal(observation.reasonCodes[0], "HTTP_STATUS_OR_BODY_UNPROVEN");
});
