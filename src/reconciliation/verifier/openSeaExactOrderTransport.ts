import https from "node:https";
import { adaptOpenSeaExactOrder, type OpenSeaExactOrderObservationV1, type OpenSeaExactOrderRawInput, type OpenSeaTimingEvidence } from "./openSeaExactOrderAdapter.js";
import { isTrustedTargetedVerifierContext } from "./targetedVerifierContext.js";
import type { TargetedVerifierContext } from "./targetedVerifierTypes.js";

export const OPENSEA_EXACT_ORDER_HTTP_TRANSPORT_VERSION = "opensea-exact-order-http-transport-v1-2026-09" as const;
const HOST = "api.opensea.io" as const;
const ONE_MIB = 1048576;

export interface OpenSeaTransportRequestOptions { readonly hostname: typeof HOST; readonly protocol: "https:"; readonly method: "GET"; readonly path: string; readonly headers: Readonly<Record<string, string>>; }
interface TransportResponse { readonly statusCode?: number; readonly rawHeaders?: readonly string[]; on(event: string, listener: (...args: any[]) => void): this; destroy?(): void; }
interface TransportRequest { on(event: string, listener: (...args: any[]) => void): this; end(): void; destroy?(): void; }
export type OpenSeaRequestFactory = (options: OpenSeaTransportRequestOptions, callback: (response: TransportResponse) => void) => TransportRequest;
export interface OpenSeaTransportClock { nowWall(): number; nowMonotonic(): bigint; setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; }
const defaultClock: OpenSeaTransportClock = { nowWall: () => Date.now(), nowMonotonic: () => process.hrtime.bigint(), setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs), clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>) };
const defaultRequestFactory: OpenSeaRequestFactory = (options, callback) => https.request(options, callback);

function safePath(context: TargetedVerifierContext): string {
  return `/api/v2/orders/chain/${encodeURIComponent(context.chain)}/protocol/${encodeURIComponent(context.protocolAddress)}/${encodeURIComponent(context.orderHash)}`;
}
function validApiKey(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value); }
function rawHeaders(value: readonly string[] | undefined): readonly { readonly name: string; readonly value: string }[] {
  if (!value || value.length % 2 !== 0) return value ? value.map((entry, index) => ({ name: index % 2 === 0 ? entry : "", value: index % 2 === 0 ? "" : entry })) : [];
  const result: { name: string; value: string }[] = [];
  for (let index = 0; index < value.length; index += 2) result.push({ name: value[index], value: value[index + 1] });
  return result;
}
function timing(clock: OpenSeaTransportClock, startedWall: number, startedMono: bigint, deadline: number, headersWall: number, completedWall: number): OpenSeaTimingEvidence {
  const elapsed = Number((clock.nowMonotonic() - startedMono) / 1000000n);
  return { requestStartedAt: new Date(startedWall).toISOString(), responseHeadersAt: new Date(headersWall).toISOString(), responseCompletedAt: new Date(completedWall).toISOString(), elapsedMs: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : deadline, overallDeadlineMs: deadline, deadlineExceeded: false };
}

/** Execute exactly one fixed-host HTTPS Get Order request and immediately adapt it. */
export function executeOpenSeaExactOrderRequest(input: { readonly context: TargetedVerifierContext; readonly apiKey: string; readonly overallDeadlineMs: number; readonly requestFactory?: OpenSeaRequestFactory; readonly clock?: OpenSeaTransportClock; }): Promise<OpenSeaExactOrderObservationV1> {
  if (!isTrustedTargetedVerifierContext(input.context)) throw new Error("UNTRUSTED_TARGETED_VERIFIER_CONTEXT");
  if (!validApiKey(input.apiKey)) throw new Error("INVALID_OPENSEA_API_KEY");
  if (typeof input.overallDeadlineMs !== "number" || !Number.isSafeInteger(input.overallDeadlineMs) || input.overallDeadlineMs <= 0) throw new Error("INVALID_OVERALL_DEADLINE");
  const clock = input.clock ?? defaultClock;
  const factory = input.requestFactory ?? defaultRequestFactory;
  const startedWall = clock.nowWall();
  const startedMono = clock.nowMonotonic();
  const options: OpenSeaTransportRequestOptions = { hostname: HOST, protocol: "https:", method: "GET", path: safePath(input.context), headers: { Accept: "application/json", "X-API-KEY": input.apiKey } };
  return new Promise((resolve) => {
    let settled = false;
    let request: TransportRequest | null = null;
    let timer: unknown;
    const settle = (raw: OpenSeaExactOrderRawInput) => { if (settled) return; settled = true; if (timer !== undefined) clock.clearTimeout(timer); resolve(adaptOpenSeaExactOrder(raw)); };
    const timeout = () => { if (settled) return; try { request?.destroy?.(); } finally { settle({ context: input.context, httpStatus: null, body: null, transportOutcome: "TIMEOUT" }); } };
    timer = clock.setTimeout(timeout, input.overallDeadlineMs);
    try {
      request = factory(options, (response) => {
        if (settled) return;
        const status = typeof response.statusCode === "number" ? response.statusCode : null;
        const headers = rawHeaders(response.rawHeaders);
        const headersWall = clock.nowWall();
        if (status !== 200) {
          try { response.destroy?.(); } finally { settle({ context: input.context, httpStatus: status, body: null, headers, transportOutcome: "HTTP" }); }
          return;
        }
        const buffer = new Uint8Array(ONE_MIB + 1);
        let size = 0;
        response.on("data", (chunk: unknown) => {
          if (settled) return;
          if (!(chunk instanceof Uint8Array)) { try { response.destroy?.(); } finally { settle({ context: input.context, httpStatus: 200, body: null, headers, transportOutcome: "HTTP" }); } return; }
          const remaining = ONE_MIB + 1 - size;
          if (remaining <= 0) return;
          const copyLength = Math.min(remaining, chunk.byteLength);
          buffer.set(chunk.subarray(0, copyLength), size); size += copyLength;
          if (size >= ONE_MIB + 1) { try { response.destroy?.(); } finally { settle({ context: input.context, httpStatus: 200, body: buffer, headers, transportOutcome: "HTTP" }); } }
        });
        response.on("end", () => { if (settled) return; settle({ context: input.context, httpStatus: 200, body: buffer.slice(0, size), headers, timing: timing(clock, startedWall, startedMono, input.overallDeadlineMs, headersWall, clock.nowWall()), transportOutcome: "HTTP" }); });
        response.on("error", () => { if (!settled) settle({ context: input.context, httpStatus: 200, body: null, headers, transportOutcome: "CONNECTION_RESET" }); });
      });
      request.on("error", () => { if (!settled) settle({ context: input.context, httpStatus: null, body: null, transportOutcome: "CONNECTION_RESET" }); });
      request.end();
    } catch { if (!settled) settle({ context: input.context, httpStatus: null, body: null, transportOutcome: "CONNECTION_RESET" }); }
  });
}
