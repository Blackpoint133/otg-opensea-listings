import https from "node:https";
import { adaptOpenSeaExactOrder, type OpenSeaExactOrderObservationV1, type OpenSeaExactOrderRawInput, type OpenSeaTimingEvidence } from "./openSeaExactOrderAdapter.js";
import { isTrustedTargetedVerifierContext } from "./targetedVerifierContext.js";
import type { TargetedVerifierContext } from "./targetedVerifierTypes.js";

export const OPENSEA_EXACT_ORDER_HTTP_TRANSPORT_VERSION = "opensea-exact-order-http-transport-v1-2026-09" as const;
const HOST = "api.opensea.io" as const;
const ONE_MIB = 1048576;
export const MAX_OVERALL_DEADLINE_MS = 2147483647;

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
function timing(startedWall: number, deadline: number, headersWall: number, completedWall: number, elapsedMs: number): OpenSeaTimingEvidence {
  return { requestStartedAt: new Date(startedWall).toISOString(), responseHeadersAt: new Date(headersWall).toISOString(), responseCompletedAt: new Date(completedWall).toISOString(), elapsedMs, overallDeadlineMs: deadline, deadlineExceeded: false };
}

/** Execute exactly one fixed-host HTTPS Get Order request and immediately adapt it. */
type CoreInput = { readonly context: TargetedVerifierContext; readonly apiKey: string; readonly overallDeadlineMs: number; readonly requestFactory: OpenSeaRequestFactory; readonly clock: OpenSeaTransportClock; };
function executeCore(input: CoreInput): Promise<OpenSeaExactOrderObservationV1> {
  if (!isTrustedTargetedVerifierContext(input.context)) throw new Error("UNTRUSTED_TARGETED_VERIFIER_CONTEXT");
  if (!validApiKey(input.apiKey)) throw new Error("INVALID_OPENSEA_API_KEY");
  if (!Number.isSafeInteger(input.overallDeadlineMs) || input.overallDeadlineMs <= 0 || input.overallDeadlineMs > MAX_OVERALL_DEADLINE_MS) throw new Error("INVALID_OVERALL_DEADLINE");
  const clock = input.clock;
  const factory = input.requestFactory;
  const startedWall = clock.nowWall();
  const startedMono = clock.nowMonotonic();
  const options: OpenSeaTransportRequestOptions = { hostname: HOST, protocol: "https:", method: "GET", path: safePath(input.context), headers: { Accept: "application/json", "X-API-KEY": input.apiKey } };
  return new Promise((resolve) => {
    let settled = false;
    let request: TransportRequest | null = null;
    let timer: unknown;
    const claim = (): boolean => { if (settled) return false; settled = true; if (timer !== undefined) clock.clearTimeout(timer); return true; };
    const finish = (raw: OpenSeaExactOrderRawInput, cancel?: () => void, elapsedSample = Number((clock.nowMonotonic() - startedMono) / 1000000n)): void => {
      if (raw.transportOutcome !== "TIMEOUT" && elapsedSample > input.overallDeadlineMs) { finishTimeout(cancel); return; }
      if (!claim()) return; try { cancel?.(); } finally { resolve(adaptOpenSeaExactOrder(raw)); }
    };
    const finishTimeout = (cancel?: () => void): void => { if (!claim()) return; try { cancel?.(); } finally { resolve(adaptOpenSeaExactOrder({ context: input.context, httpStatus: null, body: null, transportOutcome: "TIMEOUT" })); } };
    const timeout = () => finishTimeout(() => request?.destroy?.());
    timer = clock.setTimeout(timeout, input.overallDeadlineMs);
    try {
      request = factory(options, (response) => {
        if (settled) return;
        const status = typeof response.statusCode === "number" ? response.statusCode : null;
        const headers = rawHeaders(response.rawHeaders);
        const headersWall = clock.nowWall();
        const headerElapsed = Number((clock.nowMonotonic() - startedMono) / 1000000n);
        if (headerElapsed > input.overallDeadlineMs) { finishTimeout(() => { response.destroy?.(); request?.destroy?.(); }); return; }
        if (status !== 200) {
          finish({ context: input.context, httpStatus: status, body: null, headers, transportOutcome: "HTTP" }, () => response.destroy?.(), headerElapsed);
          return;
        }
        const buffer = new Uint8Array(ONE_MIB + 1);
        let size = 0;
        response.on("data", (chunk: unknown) => {
          if (settled) return;
          if (!(chunk instanceof Uint8Array)) { finish({ context: input.context, httpStatus: 200, body: null, headers, transportOutcome: "HTTP" }, () => response.destroy?.()); return; }
          const remaining = ONE_MIB + 1 - size;
          if (remaining <= 0) return;
          const copyLength = Math.min(remaining, chunk.byteLength);
          buffer.set(chunk.subarray(0, copyLength), size); size += copyLength;
          if (size >= ONE_MIB + 1) { const dataElapsed = Number((clock.nowMonotonic() - startedMono) / 1000000n); finish({ context: input.context, httpStatus: 200, body: buffer, headers, transportOutcome: "HTTP" }, () => response.destroy?.(), dataElapsed); }
        });
        response.on("end", () => { if (settled) return; const completionElapsed = Number((clock.nowMonotonic() - startedMono) / 1000000n); if (completionElapsed > input.overallDeadlineMs) { finishTimeout(() => { response.destroy?.(); request?.destroy?.(); }); return; } finish({ context: input.context, httpStatus: 200, body: buffer.slice(0, size), headers, timing: timing(startedWall, input.overallDeadlineMs, headersWall, clock.nowWall(), completionElapsed), transportOutcome: "HTTP" }, undefined, completionElapsed); });
        response.on("error", () => { const errorElapsed = Number((clock.nowMonotonic() - startedMono) / 1000000n); finish({ context: input.context, httpStatus: 200, body: null, headers, transportOutcome: "CONNECTION_RESET" }, undefined, errorElapsed); });
      });
      request.on("error", () => finish({ context: input.context, httpStatus: null, body: null, transportOutcome: "CONNECTION_RESET" }));
      request.end();
    } catch { finish({ context: input.context, httpStatus: null, body: null, transportOutcome: "CONNECTION_RESET" }); }
  });
}

/** Production API: dependencies are module-owned; callers supply no network implementation or clock. */
export function executeOpenSeaExactOrderRequest(input: { readonly context: TargetedVerifierContext; readonly apiKey: string; readonly overallDeadlineMs: number; }): Promise<OpenSeaExactOrderObservationV1> {
  return executeCore({ ...input, requestFactory: defaultRequestFactory, clock: defaultClock });
}

/** @internal test-only seam; never use as the production transport entry point. */
export function __executeOpenSeaExactOrderRequestForTest(input: { readonly context: TargetedVerifierContext; readonly apiKey: string; readonly overallDeadlineMs: number; readonly requestFactory: OpenSeaRequestFactory; readonly clock: OpenSeaTransportClock; }): Promise<OpenSeaExactOrderObservationV1> {
  return executeCore(input);
}
