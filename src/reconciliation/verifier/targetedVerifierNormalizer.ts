import { deepFreeze, sha256Bytes } from "../evidence/canonicalEvidence.js";
import {
  isCanonicalAddress, isCanonicalHash, isCanonicalOrderHash, isDecimal, isIso,
  isKnownProviderStatus, normalizeSafeHeaders, retryMetadataFor, validateNormalizedProviderOrder, validateRetryMetadata, validateTargetedVerifierEligibility, cloneOwned
} from "./targetedVerifierPolicy.js";
import type { NormalizedProviderOrder, ProviderResult, ProviderStatus, RetryMetadata, SafeHeaders, TargetedVerifierContext, TransportOutcome } from "./targetedVerifierTypes.js";

const RUNTIME_PROVIDER_PROOF = new WeakSet<object>();
const RESULT_STATUSES = new Set(["VERIFIER_NOT_ELIGIBLE", "ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED", "UNKNOWN", "AMBIGUOUS", "UNSUPPORTED", "RATE_LIMITED", "TRANSPORT_FAILED", "MALFORMED_RESPONSE", "RECONCILIATION_REQUIRED", "PROVENANCE_MISMATCH", "STALE"]);
const RESULT_REASONS = new Set(["ACTIVE_QUANTITY_UNPROVEN", "ACTIVE_TIME_UNPROVEN", "ACTIVE_TIME_INVALID", "OBSERVATION_TIME_INVALID", "ORDER_TIME_INVALID", "ORDER_TIME_RANGE_INVALID", "RESPONSE_OBJECT_REQUIRED", "IDENTITY_MISMATCH", "CHAIN_MISMATCH", "PROTOCOL_MISMATCH", "CONTRACT_MISMATCH", "PROTOCOL_ADDRESS_MISSING_OR_INVALID", "ASSET_CONTRACT_MISSING_OR_INVALID", "ASSET_IDENTITY_MALFORMED", "REMAINING_QUANTITY_INVALID", "UNKNOWN_PROVIDER_STATUS", "PRIVATE_ORDER_UNSUPPORTED", "CRITERIA_ORDER_UNSUPPORTED", "UNSUPPORTED_ORDER_SHAPE", "UNSUPPORTED_PROTOCOL", "UNSUPPORTED_ORDER_TYPE", "MALFORMED_JSON", "HTTP_404_NOT_STATE_PROOF", "HTTP_400_UNSUPPORTED_OR_INVALID_REQUEST", "HTTP_401_ACCESS_FAILURE", "HTTP_403_ACCESS_FAILURE", "HTTP_409_PROVIDER_CONFLICT", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504", "REQUEST_TIMEOUT", "CONNECTION_RESET", "HTTP_STATUS_OR_BODY_UNPROVEN", "RAW_RESPONSE_ARTIFACT_HASH_INVALID"]);

type RawBody = string | Uint8Array;

export interface InterpretTargetedOrderResponseInput {
  readonly context: TargetedVerifierContext;
  readonly httpStatus: number | null;
  readonly transportOutcome?: TransportOutcome;
  readonly safeHeaders?: unknown;
  readonly rawBody?: RawBody;
  readonly observedAt?: string | null;
  readonly rawResponseArtifactHash?: string | null;
}

function reasons(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
function retry(status: number | null, outcome: TransportOutcome): RetryMetadata { return deepFreeze(retryMetadataFor(status, outcome)); }
function base(input: InterpretTargetedOrderResponseInput, status: ProviderResult["status"], reasonCodes: readonly string[], providerStatus: ProviderStatus | null = null, normalizedOrder: NormalizedProviderOrder | null = null, responseHash: string | null = null): ProviderResult {
  const outcome = input.transportOutcome ?? "HTTP";
  const rawHash = input.rawResponseArtifactHash ?? null;
  const owned = cloneOwned({ status, reasonCodes: reasons(reasonCodes), providerStatus, normalizedOrder: normalizedOrder === null ? null : cloneOwned(normalizedOrder), observedAt: input.observedAt ?? null, responseBodySha256: responseHash, rawResponseArtifactHash: rawHash, httpStatus: input.httpStatus, retry: retry(input.httpStatus, outcome), authorityGranted: false as const, deactivationAuthorityGranted: false as const }) as ProviderResult;
  RUNTIME_PROVIDER_PROOF.add(owned);
  const result = deepFreeze(owned);
  if (!validateProviderResult(result)) throw new Error("INVALID_NORMALIZER_PROVIDER_RESULT");
  return result;
}

export function validateProviderResult(value: unknown): value is ProviderResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!RUNTIME_PROVIDER_PROOF.has(value)) return false;
  if (typeof row.status !== "string" || !RESULT_STATUSES.has(row.status) || row.authorityGranted !== false || row.deactivationAuthorityGranted !== false) return false;
  if (!Array.isArray(row.reasonCodes) || !row.reasonCodes.every((reason) => typeof reason === "string" && RESULT_REASONS.has(reason)) || JSON.stringify(row.reasonCodes) !== JSON.stringify([...row.reasonCodes].sort()) || new Set(row.reasonCodes).size !== row.reasonCodes.length) return false;
  if (row.providerStatus !== null && !isKnownProviderStatus(row.providerStatus)) return false;
  if (row.normalizedOrder !== null && !validateNormalizedProviderOrder(row.normalizedOrder)) return false;
  if (row.observedAt !== null && !isIso(row.observedAt)) return false;
  if (row.responseBodySha256 !== null && !isCanonicalHash(row.responseBodySha256)) return false;
  if (row.rawResponseArtifactHash !== null && !isCanonicalHash(row.rawResponseArtifactHash)) return false;
  if (row.httpStatus !== null && (typeof row.httpStatus !== "number" || !Number.isInteger(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599)) return false;
  if (!validateRetryMetadata(row.retry)) return false;
  if (["ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED"].includes(String(row.status)) && (row.normalizedOrder === null || row.providerStatus === null || row.normalizedOrder.status !== row.providerStatus)) return false;
  if (row.status === "ACTIVE_CONFIRMED") {
    const order = row.normalizedOrder as NormalizedProviderOrder;
    if (order.status !== "ACTIVE" || order.remainingQuantity === null || BigInt(order.remainingQuantity) <= 0n || order.startTime === null || order.endTime === null || row.observedAt === null) return false;
    const observed = Date.parse(row.observedAt as string);
    if (!(BigInt(order.startTime) * 1000n <= BigInt(observed) && BigInt(observed) < BigInt(order.endTime) * 1000n)) return false;
  }
  if (["ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED"].includes(String(row.status)) && (row.httpStatus !== 200 || row.responseBodySha256 === null || row.observedAt === null || row.retry.retryable !== false || row.retry.recommendedPolicyClass !== "NONE")) return false;
  return true;
}

function bytes(value: RawBody): Uint8Array { return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value); }
export function sha256RawResponse(value: RawBody): string { return sha256Bytes(bytes(value)); }
function parseJson(value: RawBody): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(value))) as unknown; }
  catch { return undefined; }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null { return record(value[key]) ? value[key] as Record<string, unknown> : null; }
function epochValid(value: string): boolean { try { const n = BigInt(value); return n > 0n && n < 8640000000000n; } catch { return false; } }
function temporalWindow(startTime: string, endTime: string, observedAt: string): boolean {
  const observed = BigInt(Date.parse(observedAt));
  return BigInt(startTime) * 1000n <= observed && observed < BigInt(endTime) * 1000n;
}

function supportedBasicShape(body: Record<string, unknown>, asset: Record<string, unknown>, parameters: Record<string, unknown>): string | null {
  if (body.is_private === true || body.private_listing === true || body.restricted === true) return "PRIVATE_ORDER_UNSUPPORTED";
  if (body.criteria !== undefined || asset.criteria !== undefined || parameters.criteria !== undefined) return "CRITERIA_ORDER_UNSUPPORTED";
  const offers = parameters.offer;
  if (offers !== undefined) {
    if (!Array.isArray(offers) || offers.length !== 1) return "UNSUPPORTED_ORDER_SHAPE";
    const offer = offers[0];
    if (!record(offer)) return "UNSUPPORTED_ORDER_SHAPE";
    if (offer.itemType !== 2) return offer.itemType === 4 || offer.itemType === "criteria" ? "CRITERIA_ORDER_UNSUPPORTED" : "UNSUPPORTED_ORDER_SHAPE";
    if (!isCanonicalAddress(offer.token) || offer.token !== asset.contract) return "UNSUPPORTED_ORDER_SHAPE";
    if (!isDecimal(offer.identifierOrCriteria) || offer.identifierOrCriteria !== asset.identifier) return "CRITERIA_ORDER_UNSUPPORTED";
    if (offer.startAmount !== "1" || offer.endAmount !== "1") return "UNSUPPORTED_ORDER_SHAPE";
  }
  for (const itemType of [body.item_type, parameters.itemType]) {
    if (itemType !== undefined && itemType !== 2 && itemType !== "ERC721") return "UNSUPPORTED_PROTOCOL";
  }
  for (const protocol of [parameters.protocol, parameters.protocol_name, body.protocol]) {
    if (protocol !== undefined && protocol !== "seaport" && protocol !== "seaport-v1.5" && protocol !== "seaport_v1.5") return "UNSUPPORTED_PROTOCOL";
  }
  const orderType = body.order_type ?? parameters.orderType;
  if (orderType !== undefined && orderType !== 0 && orderType !== "basic" && orderType !== "BASIC" && orderType !== "FULL_OPEN") return "UNSUPPORTED_ORDER_TYPE";
  if (asset.identifier === undefined || !isDecimal(asset.identifier)) return "UNSUPPORTED_ORDER_SHAPE";
  if (asset.identifierOrCriteria !== undefined && asset.identifierOrCriteria !== asset.identifier) return "CRITERIA_ORDER_UNSUPPORTED";
  return null;
}

function normalizeOrder(input: InterpretTargetedOrderResponseInput, body: unknown, responseHash: string): ProviderResult {
  if (!record(body)) return base(input, "MALFORMED_RESPONSE", ["RESPONSE_OBJECT_REQUIRED"], null, null, responseHash);
  const orderHash = body.order_hash;
  if (!isCanonicalOrderHash(orderHash)) return base(input, "AMBIGUOUS", ["IDENTITY_MISMATCH"], null, null, responseHash);
  if (orderHash !== input.context.orderHash) return base(input, "AMBIGUOUS", ["IDENTITY_MISMATCH"], null, null, responseHash);
  if (body.chain !== input.context.chain) return base(input, "AMBIGUOUS", ["IDENTITY_MISMATCH", "CHAIN_MISMATCH"], null, null, responseHash);
  const protocolAddress = body.protocol_address;
  if (!isCanonicalAddress(protocolAddress)) return base(input, "MALFORMED_RESPONSE", ["PROTOCOL_ADDRESS_MISSING_OR_INVALID"], null, null, responseHash);
  if (protocolAddress !== input.context.protocolAddress) return base(input, "AMBIGUOUS", ["IDENTITY_MISMATCH", "PROTOCOL_MISMATCH"], null, null, responseHash);
  const asset = nestedRecord(body, "asset");
  if (!asset) return base(input, "MALFORMED_RESPONSE", ["ASSET_CONTRACT_MISSING_OR_INVALID"], null, null, responseHash);
  const contract = asset?.contract;
  if (!isCanonicalAddress(contract)) return base(input, "MALFORMED_RESPONSE", ["ASSET_CONTRACT_MISSING_OR_INVALID"], null, null, responseHash);
  if (contract !== input.context.contractAddress) return base(input, "AMBIGUOUS", ["IDENTITY_MISMATCH", "CONTRACT_MISMATCH"], null, null, responseHash);
  const assetIdentifier = asset?.identifier === undefined ? null : text(asset.identifier);
  if (asset?.identifier !== undefined && assetIdentifier === null) return base(input, "MALFORMED_RESPONSE", ["ASSET_IDENTITY_MALFORMED"], null, null, responseHash);
  const status = body.status;
  if (!isKnownProviderStatus(status)) return base(input, "UNKNOWN", ["UNKNOWN_PROVIDER_STATUS"], null, null, responseHash);
  const privateOrder = body.is_private === true || body.private_listing === true;
  const protocolData = nestedRecord(body, "protocol_data");
  const parameters = protocolData ? nestedRecord(protocolData, "parameters") : null;
  if (privateOrder) return base(input, "UNSUPPORTED", ["PRIVATE_ORDER_UNSUPPORTED"], status, null, responseHash);
  if (!parameters) return base(input, "UNSUPPORTED", ["UNSUPPORTED_ORDER_SHAPE"], status, null, responseHash);
  const unsupportedShape = supportedBasicShape(body, asset, parameters);
  if (unsupportedShape) return base(input, "UNSUPPORTED", [unsupportedShape], status, null, responseHash);
  const remaining = body.remaining_quantity;
  if (remaining !== undefined && !isDecimal(remaining)) return base(input, "MALFORMED_RESPONSE", ["REMAINING_QUANTITY_INVALID"], status, null, responseHash);
  const startTime = parameters?.startTime;
  const endTime = parameters?.endTime;
  if ((startTime !== undefined && (!isDecimal(startTime) || !epochValid(startTime))) || (endTime !== undefined && (!isDecimal(endTime) || !epochValid(endTime)))) return base(input, "MALFORMED_RESPONSE", ["ORDER_TIME_INVALID"], status, null, responseHash);
  if (startTime !== undefined && endTime !== undefined && BigInt(startTime as string) > BigInt(endTime as string)) return base(input, "MALFORMED_RESPONSE", ["ORDER_TIME_RANGE_INVALID"], status, null, responseHash);
  if (startTime !== undefined && endTime !== undefined && BigInt(startTime as string) === BigInt(endTime as string)) return base(input, "UNKNOWN", ["ORDER_TIME_RANGE_INVALID"], status, null, responseHash);
  const normalized = deepFreeze({ orderHash, chain: input.context.chain, protocolAddress, contractAddress: contract, assetIdentifier, status, remainingQuantity: remaining === undefined ? null : remaining as string, startTime: startTime === undefined ? null : startTime as string, endTime: endTime === undefined ? null : endTime as string, isPrivate: false as const, isCriteria: false as const });
  if (status === "ACTIVE") {
    if (normalized.remainingQuantity === null || BigInt(normalized.remainingQuantity) <= 0n) return base(input, "UNKNOWN", ["ACTIVE_QUANTITY_UNPROVEN"], status, normalized, responseHash);
    if (!isIso(input.observedAt) || normalized.startTime === null || normalized.endTime === null || !temporalWindow(normalized.startTime, normalized.endTime, input.observedAt)) return base(input, "UNKNOWN", ["ACTIVE_TIME_UNPROVEN"], status, normalized, responseHash);
    return base(input, "ACTIVE_CONFIRMED", [], status, normalized, responseHash);
  }
  if (status === "INACTIVE") return base(input, "INACTIVE_CONFIRMED", [], status, normalized, responseHash);
  if (status === "FULFILLED" || status === "CANCELLED") return base(input, "TERMINAL_CONFIRMED", [], status, normalized, responseHash);
  return base(input, "EXPIRED_CONFIRMED", [], status, normalized, responseHash);
}

export function interpretTargetedOrderResponse(input: InterpretTargetedOrderResponseInput): ProviderResult {
  const eligibility = validateTargetedVerifierEligibility(input.context);
  if (!eligibility.valid) return base(input, "VERIFIER_NOT_ELIGIBLE", eligibility.reasons);
  const outcome = input.transportOutcome ?? "HTTP";
  const headers: SafeHeaders = normalizeSafeHeaders(input.safeHeaders);
  void headers;
  if (outcome !== "HTTP") return base(input, "TRANSPORT_FAILED", [outcome === "TIMEOUT" ? "REQUEST_TIMEOUT" : "CONNECTION_RESET"]);
  if (input.httpStatus === 404) return base(input, "UNKNOWN", ["HTTP_404_NOT_STATE_PROOF"]);
  if (input.httpStatus === 429) return base(input, "RATE_LIMITED", ["HTTP_429"]);
  if (input.httpStatus !== null && [500, 502, 503, 504].includes(input.httpStatus)) return base(input, "TRANSPORT_FAILED", [`HTTP_${input.httpStatus}`]);
  if (input.httpStatus === 401 || input.httpStatus === 403) return base(input, "UNKNOWN", [`HTTP_${input.httpStatus}_ACCESS_FAILURE`]);
  if (input.httpStatus === 400) return base(input, "UNSUPPORTED", ["HTTP_400_UNSUPPORTED_OR_INVALID_REQUEST"]);
  if (input.httpStatus === 409) return base(input, "AMBIGUOUS", ["HTTP_409_PROVIDER_CONFLICT"]);
  if (input.httpStatus !== 200 || input.rawBody === undefined) return base(input, "UNKNOWN", ["HTTP_STATUS_OR_BODY_UNPROVEN"]);
  if (input.observedAt !== undefined && input.observedAt !== null && !isIso(input.observedAt)) return base(input, "MALFORMED_RESPONSE", ["OBSERVATION_TIME_INVALID"]);
  if (input.rawResponseArtifactHash !== null && input.rawResponseArtifactHash !== undefined && !isCanonicalHash(input.rawResponseArtifactHash)) return base(input, "MALFORMED_RESPONSE", ["RAW_RESPONSE_ARTIFACT_HASH_INVALID"]);
  const responseHash = sha256RawResponse(input.rawBody);
  const parsed = parseJson(input.rawBody);
  if (parsed === undefined) return base(input, "MALFORMED_RESPONSE", ["MALFORMED_JSON"], null, null, responseHash);
  return normalizeOrder(input, parsed, responseHash);
}
