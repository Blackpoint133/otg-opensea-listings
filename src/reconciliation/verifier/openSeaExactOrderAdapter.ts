import { createHash } from "node:crypto";
import { deepFreeze } from "../evidence/canonicalEvidence.js";
import { OPENSEA_ORDER_CONTRACT_VERSION } from "./targetedVerifierTypes.js";
import type { TargetedVerifierContext, TransportOutcome } from "./targetedVerifierTypes.js";
import { isCanonicalAddress, isCanonicalOrderHash, isDecimal } from "./targetedVerifierPolicy.js";

export const OPENSEA_EXACT_ORDER_ADAPTER_VERSION = "opensea-exact-order-adapter-v1-2026-09" as const;

export interface OpenSeaExactOrderRawInput {
  readonly context: TargetedVerifierContext;
  readonly httpStatus: number | null;
  readonly body: Uint8Array | null;
  readonly responseBodySha256?: string | null;
  readonly rawResponseArtifactHash?: string | null;
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly requestStartedAt?: string;
  readonly responseHeadersAt?: string;
  readonly responseCompletedAt?: string;
  readonly transportOutcome?: TransportOutcome;
}

export interface OpenSeaExactOrderObservationV1 {
  readonly adapterVersion: typeof OPENSEA_EXACT_ORDER_ADAPTER_VERSION;
  readonly providerContractVersion: string;
  readonly requestIdentity: { readonly method: "GET"; readonly endpointPath: string; readonly chain: string; readonly protocolAddress: string; readonly orderHash: string };
  readonly outcome: "VALID" | "UNKNOWN" | "MALFORMED" | "UNSUPPORTED" | "TRANSPORT_FAILED";
  readonly reasonCodes: readonly string[];
  readonly providerStatus: string | null;
  readonly orderHash: string | null;
  readonly chain: string | null;
  readonly protocolAddress: string | null;
  readonly contractAddress: string | null;
  readonly assetIdentifier: string | null;
  readonly offerIdentifier: string | null;
  readonly remainingQuantity: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly itemType: number | null;
  readonly orderType: number | string | null;
  readonly observedAt: string | null;
  readonly responseBodySha256: string | null;
  readonly rawResponseArtifactHash: string | null;
  readonly httpStatus: number | null;
  readonly transportOutcome: TransportOutcome;
  readonly supportedListing: boolean;
  readonly authorityGranted: false;
  readonly deactivationAuthorityGranted: false;
}

const TRUSTED = new WeakSet<object>();
export function isTrustedOpenSeaExactOrderObservation(value: unknown): value is OpenSeaExactOrderObservationV1 { return value !== null && typeof value === "object" && TRUSTED.has(value); }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function failure(input: OpenSeaExactOrderRawInput, outcome: OpenSeaExactOrderObservationV1["outcome"], reasonCodes: string[], fields: Partial<OpenSeaExactOrderObservationV1> = {}): OpenSeaExactOrderObservationV1 {
  const result = deepFreeze({ adapterVersion: OPENSEA_EXACT_ORDER_ADAPTER_VERSION, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, requestIdentity: { method: "GET" as const, endpointPath: "/api/v2/orders/chain/{chain}/protocol/{protocol_address}/{order_hash}", chain: input.context.chain, protocolAddress: input.context.protocolAddress, orderHash: input.context.orderHash }, outcome, reasonCodes: [...new Set(reasonCodes)].sort(), providerStatus: null, orderHash: null, chain: null, protocolAddress: null, contractAddress: null, assetIdentifier: null, offerIdentifier: null, remainingQuantity: null, startTime: null, endTime: null, itemType: null, orderType: null, observedAt: input.responseHeadersAt ?? null, responseBodySha256: input.body ? hash(input.body) : null, rawResponseArtifactHash: input.rawResponseArtifactHash ?? null, httpStatus: input.httpStatus, transportOutcome: input.transportOutcome ?? "HTTP", supportedListing: false, authorityGranted: false as const, deactivationAuthorityGranted: false as const, ...fields });
  TRUSTED.add(result); return result;
}
function duplicateKeys(json: string): boolean {
  const stack: Array<Set<string> | null> = []; let quote = false, esc = false, key = "", inKey = false;
  for (let i = 0; i < json.length; i++) { const c = json[i]; if (quote) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') { quote = false; if (inKey && stack[stack.length - 1]) { if (stack[stack.length - 1]!.has(key)) return true; stack[stack.length - 1]!.add(key); } } else if (inKey) key += c; continue; } if (c === '"') { quote = true; key = ""; inKey = json[i + 1] !== undefined && json.slice(i + 1).match(/^\s*:/) !== null; } else if (c === "{") stack.push(new Set()); else if (c === "}") stack.pop(); }
  return false;
}
export function adaptOpenSeaExactOrder(input: OpenSeaExactOrderRawInput): OpenSeaExactOrderObservationV1 {
  if (input.httpStatus === 404) return failure(input, "UNKNOWN", ["HTTP_404_NOT_STATE_PROOF"]);
  if (!input.body) return failure(input, input.transportOutcome === "HTTP" ? "UNKNOWN" : "TRANSPORT_FAILED", ["HTTP_STATUS_OR_BODY_UNPROVEN"]);
  const bytes = new Uint8Array(input.body); const actual = hash(bytes);
  if (bytes.byteLength > 1048576) return failure(input, "MALFORMED", ["BODY_TOO_LARGE"]);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return failure(input, "MALFORMED", ["MALFORMED_JSON"]);
  const headers = input.headers ?? {};
  const encoding = headers["content-encoding"] ?? headers["Content-Encoding"];
  if (encoding && encoding.toLowerCase() !== "identity") return failure(input, "UNSUPPORTED", ["UNSUPPORTED_CONTENT_ENCODING"]);
  if (headers.age !== undefined || headers.Age !== undefined) return failure(input, "UNKNOWN", ["OBSERVATION_TIME_INVALID"]);
  if (input.responseBodySha256 !== undefined && input.responseBodySha256 !== null && input.responseBodySha256 !== actual) return failure(input, "MALFORMED", ["RAW_RESPONSE_HASH_MISMATCH"]);
  let text: string; let root: any;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.charCodeAt(0) === 0xfeff || duplicateKeys(text)) return failure(input, "MALFORMED", ["MALFORMED_JSON"]); root = JSON.parse(text); } catch { return failure(input, "MALFORMED", ["MALFORMED_JSON"]); }
  if (input.httpStatus !== 200) return failure(input, input.httpStatus === 404 ? "UNKNOWN" : "UNSUPPORTED", [input.httpStatus === 404 ? "HTTP_404_NOT_STATE_PROOF" : `HTTP_${input.httpStatus ?? "STATUS"}`]);
  if (root === null || typeof root !== "object" || Array.isArray(root) || root.order === null || typeof root.order !== "object" || Array.isArray(root.order)) return failure(input, "MALFORMED", ["RESPONSE_OBJECT_REQUIRED"]);
  const order = root.order as Record<string, any>; const params = order.protocol_data?.parameters;
  const offer = params?.offer; const asset = order.asset;
  const dateHeader = headers.date ?? headers.Date ?? null;
  const observedAt = dateHeader && /^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(dateHeader) && !Number.isNaN(Date.parse(dateHeader)) && new Date(Date.parse(dateHeader)).toUTCString() === dateHeader ? new Date(Date.parse(dateHeader)).toISOString() : null;
  const orderHash = order.order_hash, chain = order.chain, protocol = order.protocol_address, contract = asset?.contract;
  if (!isCanonicalOrderHash(orderHash) || orderHash !== input.context.orderHash || chain !== input.context.chain || !isCanonicalAddress(protocol) || protocol !== input.context.protocolAddress || !isCanonicalAddress(contract) || contract !== input.context.contractAddress) return failure(input, "MALFORMED", ["IDENTITY_MISMATCH"]);
  const assetId = asset?.identifier; const offerId = Array.isArray(offer) && offer.length === 1 ? offer[0]?.identifier_or_criteria : null;
  const itemType = Array.isArray(offer) && offer.length === 1 ? offer[0]?.item_type : null;
  const validIds = isDecimal(assetId) && isDecimal(offerId) && assetId === offerId && assetId === input.context.expectedIdentity.tokenId;
  const documentedStatus = new Set(["ACTIVE", "INACTIVE", "FULFILLED", "CANCELLED", "EXPIRED"]);
  const listing = validIds && itemType === 2 && offer[0]?.token === input.context.contractAddress && offer[0]?.start_amount === "1" && offer[0]?.end_amount === "1" && (params?.order_type === 0 || params?.order_type === "FULL_OPEN") && typeof order.status === "string" && documentedStatus.has(order.status) && observedAt !== null;
  return failure(input, listing ? "VALID" : "UNSUPPORTED", listing ? [] : ["UNSUPPORTED_ORDER_SHAPE"], { providerStatus: typeof order.status === "string" ? order.status : null, orderHash, chain, protocolAddress: protocol, contractAddress: contract, assetIdentifier: typeof assetId === "string" ? assetId : null, offerIdentifier: typeof offerId === "string" ? offerId : null, remainingQuantity: typeof order.remaining_quantity === "string" && isDecimal(order.remaining_quantity) ? order.remaining_quantity : null, startTime: typeof params?.start_time === "string" && isDecimal(params.start_time) ? params.start_time : null, endTime: typeof params?.end_time === "string" && isDecimal(params.end_time) ? params.end_time : null, itemType: typeof itemType === "number" ? itemType : null, orderType: params?.order_type ?? null, supportedListing: listing, observedAt });
}
