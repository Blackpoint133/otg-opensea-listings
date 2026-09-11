import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { executeOpenSeaExactOrderRequest, type OpenSeaRequestFactory, type OpenSeaTransportClock, type OpenSeaTransportRequestOptions } from "../src/reconciliation/verifier/openSeaExactOrderTransport.js";
import { makeCanonicalOfficialOrder, encodeCanonicalOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const body = encodeCanonicalOrder(makeCanonicalOfficialOrder(context));
const rawHeaders = ["Date", "Tue, 01 Jan 2030 00:00:00 GMT", "Content-Type", "application/json", "Content-Encoding", "identity"];

class FakeResponse extends EventEmitter { statusCode?: number; rawHeaders?: string[]; destroyed = 0; constructor(status: number, headers = rawHeaders) { super(); this.statusCode = status; this.rawHeaders = headers; } destroy() { this.destroyed++; } }
class FakeRequest extends EventEmitter { destroyed = 0; ended = 0; constructor(private readonly onEnd: () => void) { super(); } end() { this.ended++; this.onEnd(); } destroy() { this.destroyed++; } }
class FakeClock implements OpenSeaTransportClock { wall = Date.parse("2030-01-01T00:00:00.000Z"); mono = 0n; pending: (() => void) | null = null; nowWall() { return this.wall; } nowMonotonic() { return this.mono; } setTimeout(callback: () => void) { this.pending = callback; return callback; } clearTimeout() { this.pending = null; } fire() { this.pending?.(); } }
function factoryFor(response: FakeResponse, capture: { options?: OpenSeaTransportRequestOptions; request?: FakeRequest; chunksSeen?: number }): OpenSeaRequestFactory { return (options, callback) => { capture.options = options; const request = new FakeRequest(() => { callback(response); }); capture.request = request; return request; }; }
function streamingFactory(response: FakeResponse, chunks: Uint8Array[], capture: { options?: OpenSeaTransportRequestOptions; request?: FakeRequest; chunksSeen?: number }): OpenSeaRequestFactory { return (options, callback) => { capture.options = options; const request = new FakeRequest(() => { callback(response); if (response.destroyed) return; for (const chunk of chunks) { capture.chunksSeen = (capture.chunksSeen ?? 0) + chunk.byteLength; response.emit("data", chunk); if (response.destroyed) break; } if (!response.destroyed) response.emit("end"); }); capture.request = request; return request; }; }

test("transport constructs one fixed HTTPS request from trusted context", async () => {
  const capture: { options?: OpenSeaTransportRequestOptions; request?: FakeRequest } = {};
  const response = new FakeResponse(503);
  const observation = await executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factoryFor(response, capture), clock: new FakeClock() });
  assert.equal(capture.options?.hostname, "api.opensea.io"); assert.equal(capture.options?.protocol, "https:"); assert.equal(capture.options?.method, "GET");
  assert.equal(capture.options?.path, `/api/v2/orders/chain/${context.chain}/protocol/${context.protocolAddress}/${context.orderHash}`);
  assert.deepEqual(capture.options?.headers, { Accept: "application/json", "X-API-KEY": "TEST_ONLY_FAKE_OPENSEA_KEY" });
  assert.equal(observation.reasonCodes[0], "HTTP_503"); assert.equal(capture.request?.ended, 1);
});

test("transport rejects credentials and untrusted context before request creation", async () => {
  let calls = 0; const factory = ((() => { calls++; throw new Error("must not call"); }) as unknown) as OpenSeaRequestFactory;
  for (const apiKey of ["", "bad\rkey", "bad\nkey"]) assert.throws(() => executeOpenSeaExactOrderRequest({ context, apiKey, overallDeadlineMs: 1000, requestFactory: factory }), /INVALID_OPENSEA_API_KEY/);
  const clone = { ...context };
  assert.throws(() => executeOpenSeaExactOrderRequest({ context: clone as any, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory }), /UNTRUSTED_TARGETED_VERIFIER_CONTEXT/);
  assert.equal(calls, 0);
});

test("bounded HTTP-200 body is adapted with identical result across chunk boundaries", async () => {
  const expected = createHash("sha256").update(body).digest("hex");
  const results = [];
  for (const chunks of [ [body], Array.from(body, (byte) => new Uint8Array([byte])), [body.slice(0, 7), body.slice(7, 101), body.slice(101)] ]) {
    const response = new FakeResponse(200); const capture: any = {}; const clock = new FakeClock();
    results.push(await executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, chunks, capture), clock }));
  }
  for (const result of results) { assert.equal(result.outcome, "VALID"); assert.equal(result.responseBodySha256, expected); assert.equal(result.timing?.deadlineExceeded, false); }
  assert.deepEqual(results.map((result) => result.responseBodySha256), [expected, expected, expected]);
});

test("oversized HTTP-200 response retains only 1 MiB plus one byte", async () => {
  const capture: any = {}; const response = new FakeResponse(200); const first = new Uint8Array(2 * 1048576); const second = new Uint8Array(1024);
  const observation = await executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, [first, second], capture), clock: new FakeClock() });
  assert.equal(capture.chunksSeen, first.byteLength); assert.equal(response.destroyed, 1);
  assert.equal(observation.outcome, "MALFORMED"); assert.deepEqual(observation.reasonCodes, ["BODY_TOO_LARGE"]); assert.equal(observation.responseBodySha256, null);
});

test("non-200 responses ignore large bodies and preserve status classification", async () => {
  for (const [status, reason] of [[404, "HTTP_404_NOT_STATE_PROOF"], [429, "HTTP_429"], [503, "HTTP_503"], [302, "HTTP_STATUS_OR_BODY_UNPROVEN"]] as const) {
    const response = new FakeResponse(status); const capture: any = {};
    const observation = await executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, [new Uint8Array(8 * 1048576)], capture), clock: new FakeClock() });
    assert.deepEqual(observation.reasonCodes, [reason]); assert.equal(observation.responseBodySha256, null); assert.equal(capture.chunksSeen, undefined); assert.equal(response.destroyed, 1);
  }
});

test("duplicate raw headers and unsupported encoding reach the accepted adapter unchanged", async () => {
  const duplicate = ["Date", "Tue, 01 Jan 2030 00:00:00 GMT", "Date", "Tue, 01 Jan 2030 00:00:00 GMT", "Content-Type", "application/json", "Content-Type", "application/json", "Content-Encoding", "gzip", "Content-Length", String(body.length), "Content-Length", String(body.length)];
  const response = new FakeResponse(200, duplicate); const observation = await executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: streamingFactory(response, [body], {}), clock: new FakeClock() });
  assert.equal(observation.outcome, "UNSUPPORTED"); assert.ok(observation.reasonCodes.includes("UNSUPPORTED_CONTENT_ENCODING"));
});

test("timeout, connection failure and late events settle exactly once", async () => {
  const clock = new FakeClock(); let lateResponse: FakeResponse | undefined; const request = new FakeRequest(() => {});
  const factory: OpenSeaRequestFactory = (_options, callback) => { lateResponse = new FakeResponse(200); (request as any).late = () => callback(lateResponse!); return request; };
  const pending = executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory, clock }); clock.fire(); const timeout = await pending;
  assert.equal(timeout.outcome, "TRANSPORT_FAILED"); assert.deepEqual(timeout.reasonCodes, ["REQUEST_TIMEOUT"]); assert.equal(request.destroyed, 1); (request as any).late(); assert.equal(timeout.reasonCodes.length, 1);
  const errorRequest = new FakeRequest(() => {}); const errorResult = executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: (() => errorRequest) as any, clock: new FakeClock() }); errorRequest.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" })); const reset = await errorResult; assert.deepEqual(reset.reasonCodes, ["CONNECTION_RESET"]);
});

test("transport performs no redirect or retry", async () => {
  let calls = 0; const response = new FakeResponse(302, ["Location", "https://evil.example/"]); const factory: OpenSeaRequestFactory = (options, callback) => { calls++; return new FakeRequest(() => callback(response)); };
  const observation = await executeOpenSeaExactOrderRequest({ context, apiKey: "TEST_ONLY_FAKE_OPENSEA_KEY", overallDeadlineMs: 1000, requestFactory: factory, clock: new FakeClock() });
  assert.equal(calls, 1); assert.equal(observation.outcome, "UNKNOWN"); assert.equal(observation.reasonCodes[0], "HTTP_STATUS_OR_BODY_UNPROVEN");
});
