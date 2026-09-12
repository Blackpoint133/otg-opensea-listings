import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:https";
import { test } from "node:test";
import { generate } from "selfsigned";
import { request as httpsRequest } from "node:https";
import { __executeOpenSeaExactOrderRequestForTest as executeTest, type OpenSeaRequestFactory, type OpenSeaTransportClock } from "../src/reconciliation/verifier/openSeaExactOrderTransport.js";
import { makeCanonicalOfficialOrder, encodeCanonicalOrder } from "./helpers/openSeaCanonicalOrder.js";
import { makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const graph = await makeTrustedContexts();
const context = graph.contexts[0];
const key = "TEST_ONLY_FAKE_OPENSEA_KEY";
const integrationOrder = makeCanonicalOfficialOrder(context);
const nowSeconds = Math.floor(Date.now() / 1000);
integrationOrder.protocol_data.parameters.startTime = String(nowSeconds - 10);
integrationOrder.protocol_data.parameters.endTime = String(nowSeconds + 3600);
const canonicalBody = encodeCanonicalOrder(integrationOrder);
const deadlineMs = 1500;
const validHeaders = { "Content-Type": "application/json", "Content-Encoding": "identity", Date: new Date().toUTCString() };

class RealClock implements OpenSeaTransportClock { nowWall() { return Date.now(); } nowMonotonic() { return process.hrtime.bigint(); } setTimeout(cb: () => void, ms: number) { return globalThis.setTimeout(cb, ms); } clearTimeout(handle: unknown) { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>); } }
async function certificate() { return generate([{ name: "commonName", value: "localhost" }], { keySize: 2048, algorithm: "sha256", notBeforeDate: new Date(Date.now() - 60_000), notAfterDate: new Date(Date.now() + 3_600_000), extensions: [{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true, keyEncipherment: true }, { name: "extKeyUsage", serverAuth: true }, { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }] }); }
async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (port: number, ca: string) => Promise<void>) {
  const tls = await certificate(); const server = createServer({ key: tls.private, cert: tls.cert }, handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  try { await run(address.port, tls.cert); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
function localFactory(port: number, ca: string, check: (options: any) => void, servername = "localhost"): OpenSeaRequestFactory {
  return (options, callback) => { check(options); return httpsRequest({ hostname: "127.0.0.1", port, servername, ca, protocol: "https:", method: options.method, path: options.path, headers: options.headers }, callback as any) as any; };
}
function bodyChunks(body: Uint8Array, sizes: number[]) { const chunks: Uint8Array[] = []; let offset = 0; for (const size of sizes) { chunks.push(body.slice(offset, offset + size)); offset += size; } if (offset < body.length) chunks.push(body.slice(offset)); return chunks; }
function writeChunks(response: ServerResponse, chunks: Uint8Array[], delay = 0) { for (const [index, chunk] of chunks.entries()) setTimeout(() => { response.write(chunk); if (index === chunks.length - 1) response.end(); }, delay * index); }

test("localhost verified TLS canonical 200 preserves logical request and body hash", async () => {
  let requests = 0; let bodyBytes = 0; let logical: any;
  await withServer((request, response) => { requests++; assert.equal(request.method, "GET"); assert.equal(new URL(request.url!, "https://localhost").search, ""); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined); request.on("data", (chunk) => { bodyBytes += chunk.length; }); request.on("end", () => { response.writeHead(200, validHeaders); response.end(canonicalBody); }); }, async (port, ca) => {
    const observation = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, (options) => { logical = options; assert.equal(options.hostname, "api.opensea.io"); assert.equal(options.protocol, "https:"); assert.equal(options.method, "GET"); assert.equal(options.path, `/api/v2/orders/chain/${context.chain}/protocol/${context.protocolAddress}/${context.orderHash}`); assert.equal(options.headers.Accept, "application/json"); assert.equal(options.headers["X-API-KEY"], key); }), clock: new RealClock() });
    assert.equal(observation.outcome, "VALID"); assert.equal(observation.responseBodySha256, (await import("node:crypto")).createHash("sha256").update(canonicalBody).digest("hex")); assert.equal(requests, 1); assert.equal(bodyBytes, 0); assert.ok(logical);
  });
});

test("localhost native stream chunking yields identical semantic result", async () => {
  const results: string[] = [];
  for (const sizes of [[canonicalBody.length], [1], [7, 31, 113, 4096]]) await withServer((_request, response) => { response.writeHead(200, validHeaders); writeChunks(response, bodyChunks(canonicalBody, sizes), 0); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.equal(result.outcome, "VALID"); results.push(result.responseBodySha256!); });
  assert.equal(new Set(results).size, 1);
});

test("native duplicate headers remain policy-visible", async () => {
  for (const duplicate of [
    { "Content-Type": ["application/json", "application/json"] },
    { "Content-Encoding": ["identity", "identity"] },
    { Date: ["Tue, 01 Jan 2030 00:00:00 GMT", "Tue, 01 Jan 2030 00:00:00 GMT"] },
    { "Content-Length": [String(canonicalBody.length), String(canonicalBody.length)] },
  ]) await withServer((_request, response) => { response.sendDate = false; response.writeHead(200, { ...validHeaders, ...duplicate }); response.end(canonicalBody); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.notEqual(result.outcome, "VALID"); });
});

test("gzip bytes are not decompressed and reach adapter encoding policy", async () => {
  await withServer((_request, response) => { response.writeHead(200, { ...validHeaders, "Content-Encoding": "gzip" }); response.end(canonicalBody); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.equal(result.outcome, "UNSUPPORTED"); assert.deepEqual(result.reasonCodes, ["UNSUPPORTED_CONTENT_ENCODING"]); });
});

test("oversized localhost body is cancelled after bounded proof", async () => {
  let sent = 0; await withServer((_request, response) => { response.writeHead(200, validHeaders); const chunk = new Uint8Array(64 * 1024); const timer = setInterval(() => { sent += chunk.length; response.write(chunk); if (sent > 2 * 1048576) { clearInterval(timer); response.end(); } }, 1); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.equal(result.outcome, "MALFORMED"); assert.deepEqual(result.reasonCodes, ["BODY_TOO_LARGE"]); assert.equal(result.responseBodySha256, null); });
});

test("localhost non-200 large bodies are isolated and redirects are not followed", async () => {
  for (const [status, reason] of [[404, "HTTP_404_NOT_STATE_PROOF"], [429, "HTTP_429"], [503, "HTTP_503"], [302, "HTTP_STATUS_OR_BODY_UNPROVEN"]] as const) { let targetHits = 0; let requests = 0; await withServer((request, response) => { requests++; if (request.url === "/target") targetHits++; if (status === 302) response.setHeader("Location", "/target"); response.writeHead(status, { "Content-Type": "application/json" }); response.end(new Uint8Array(2 * 1048576)); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.deepEqual(result.reasonCodes, [reason]); assert.equal(result.responseBodySha256, null); assert.equal(targetHits, 0); assert.equal(requests, 1); }); }
});

test("real timeout before headers and after headers settles REQUEST_TIMEOUT", async () => {
  await withServer((_request, response) => { setTimeout(() => { response.writeHead(200, validHeaders); response.end(canonicalBody); }, 250); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: 50, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.deepEqual(result.reasonCodes, ["REQUEST_TIMEOUT"]); });
  await withServer((_request, response) => { response.writeHead(200, validHeaders); response.write(canonicalBody.slice(0, 20)); setTimeout(() => response.end(canonicalBody.slice(20)), 250); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: 50, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.deepEqual(result.reasonCodes, ["REQUEST_TIMEOUT"]); });
});

test("real TLS reset before and during response maps to CONNECTION_RESET", async () => {
  await withServer((_request, response) => { response.socket?.destroy(); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.deepEqual(result.reasonCodes, ["CONNECTION_RESET"]); });
  await withServer((_request, response) => { response.writeHead(200, validHeaders); response.write(canonicalBody.slice(0, 20)); setTimeout(() => response.socket?.destroy(), 10); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => {}), clock: new RealClock() }); assert.deepEqual(result.reasonCodes, ["CONNECTION_RESET"]); });
});

test("wrong TLS trust fails closed without insecure fallback", async () => {
  await withServer((_request, response) => { response.writeHead(200, validHeaders); response.end(canonicalBody); }, async (port) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, "not-the-server-ca", () => {}), clock: new RealClock() }); assert.deepEqual(result.reasonCodes, ["CONNECTION_RESET"]); });
});

test("localhost failures create one physical request and no request body", async () => {
  let attempts = 0; let bodyBytes = 0; await withServer((request, response) => { attempts++; request.on("data", (chunk) => { bodyBytes += chunk.length; }); response.writeHead(503); response.end(); }, async (port, ca) => { const result = await executeTest({ context, apiKey: key, overallDeadlineMs: deadlineMs, requestFactory: localFactory(port, ca, () => { attempts++; }), clock: new RealClock() }); assert.deepEqual(result.reasonCodes, ["HTTP_503"]); });
  assert.equal(bodyBytes, 0); assert.equal(attempts, 2);
});
