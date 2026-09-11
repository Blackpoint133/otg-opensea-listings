import { deepFreeze } from "../evidence/canonicalEvidence.js";
import { isCanonicalHash, isIso, isKnownProviderStatus, retryMetadataFor, validateNormalizedProviderOrder, validateRetryMetadata, cloneOwned } from "./targetedVerifierPolicy.js";
import type { NormalizedProviderOrder, ProviderResult, ProviderStatus, RetryMetadata, TargetedVerifierContext, TransportOutcome } from "./targetedVerifierTypes.js";
import { isObservationBoundToContext, type OpenSeaExactOrderObservationV1 } from "./openSeaExactOrderAdapter.js";
const RUNTIME_PROVIDER_PROOF = new WeakSet<object>();
const RESULT_STATUSES = new Set(["VERIFIER_NOT_ELIGIBLE", "ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED", "UNKNOWN", "AMBIGUOUS", "UNSUPPORTED", "RATE_LIMITED", "TRANSPORT_FAILED", "MALFORMED_RESPONSE", "RECONCILIATION_REQUIRED", "PROVENANCE_MISMATCH", "STALE"]);
const RESULT_REASONS = new Set(["OFFICIAL_SCHEMA_INVALID", "ACTIVE_QUANTITY_UNPROVEN", "ACTIVE_TIME_UNPROVEN", "ACTIVE_TIME_INVALID", "OBSERVATION_TIME_INVALID", "ORDER_TIME_INVALID", "ORDER_TIME_RANGE_INVALID", "RESPONSE_OBJECT_REQUIRED", "IDENTITY_MISMATCH", "CHAIN_MISMATCH", "PROTOCOL_MISMATCH", "CONTRACT_MISMATCH", "PROTOCOL_ADDRESS_MISSING_OR_INVALID", "ASSET_CONTRACT_MISSING_OR_INVALID", "ASSET_IDENTITY_MALFORMED", "REMAINING_QUANTITY_INVALID", "UNKNOWN_PROVIDER_STATUS", "PRIVATE_ORDER_UNSUPPORTED", "CRITERIA_ORDER_UNSUPPORTED", "UNSUPPORTED_ORDER_SHAPE", "UNSUPPORTED_PROTOCOL", "UNSUPPORTED_ORDER_TYPE", "MALFORMED_JSON", "HEADER_INVALID", "CONTENT_TYPE_UNSUPPORTED", "CONTENT_LENGTH_INVALID", "BODY_TOO_LARGE", "UNSUPPORTED_CONTENT_ENCODING", "RAW_RESPONSE_HASH_MISMATCH", "HTTP_5XX_PROVIDER_FAILURE", "HTTP_404_NOT_STATE_PROOF", "HTTP_400_UNSUPPORTED_OR_INVALID_REQUEST", "HTTP_401_ACCESS_FAILURE", "HTTP_403_ACCESS_FAILURE", "HTTP_409_PROVIDER_CONFLICT", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504", "REQUEST_TIMEOUT", "CONNECTION_RESET", "HTTP_STATUS_OR_BODY_UNPROVEN", "RAW_RESPONSE_ARTIFACT_HASH_INVALID"]);
interface ProviderEvidenceMetadata {
    readonly context: TargetedVerifierContext;
    readonly httpStatus: number | null;
    readonly transportOutcome?: TransportOutcome;
    readonly observedAt?: string | null;
    readonly rawResponseArtifactHash?: string | null;
}
function reasons(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
function retry(status: number | null, outcome: TransportOutcome): RetryMetadata { return deepFreeze(retryMetadataFor(status, outcome)); }
function base(input: ProviderEvidenceMetadata, status: ProviderResult["status"], reasonCodes: readonly string[], providerStatus: ProviderStatus | null = null, normalizedOrder: NormalizedProviderOrder | null = null, responseHash: string | null = null): ProviderResult {
    const outcome = input.transportOutcome ?? "HTTP";
    const rawHash = input.rawResponseArtifactHash ?? null;
    const owned = cloneOwned({ status, reasonCodes: reasons(reasonCodes), providerStatus, normalizedOrder: normalizedOrder === null ? null : cloneOwned(normalizedOrder), observedAt: input.observedAt ?? null, responseBodySha256: responseHash, rawResponseArtifactHash: rawHash, httpStatus: input.httpStatus, retry: retry(input.httpStatus, outcome), authorityGranted: false as const, deactivationAuthorityGranted: false as const }) as ProviderResult;
    RUNTIME_PROVIDER_PROOF.add(owned);
    const result = deepFreeze(owned);
    if (!validateProviderResult(result))
        throw new Error("INVALID_NORMALIZER_PROVIDER_RESULT");
    return result;
}
export function validateProviderResult(value: unknown): value is ProviderResult {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const row = value as Record<string, unknown>;
    if (!RUNTIME_PROVIDER_PROOF.has(value))
        return false;
    if (typeof row.status !== "string" || !RESULT_STATUSES.has(row.status) || row.authorityGranted !== false || row.deactivationAuthorityGranted !== false)
        return false;
    if (!Array.isArray(row.reasonCodes) || !row.reasonCodes.every((reason) => typeof reason === "string" && RESULT_REASONS.has(reason)) || JSON.stringify(row.reasonCodes) !== JSON.stringify([...row.reasonCodes].sort()) || new Set(row.reasonCodes).size !== row.reasonCodes.length)
        return false;
    if (row.providerStatus !== null && !isKnownProviderStatus(row.providerStatus))
        return false;
    if (row.normalizedOrder !== null && !validateNormalizedProviderOrder(row.normalizedOrder))
        return false;
    if (row.observedAt !== null && !isIso(row.observedAt))
        return false;
    if (row.responseBodySha256 !== null && !isCanonicalHash(row.responseBodySha256))
        return false;
    if (row.rawResponseArtifactHash !== null && !isCanonicalHash(row.rawResponseArtifactHash))
        return false;
    if (row.httpStatus !== null && (typeof row.httpStatus !== "number" || !Number.isInteger(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599))
        return false;
    if (!validateRetryMetadata(row.retry))
        return false;
    if (["ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED"].includes(String(row.status)) && (row.normalizedOrder === null || row.providerStatus === null || row.normalizedOrder.status !== row.providerStatus))
        return false;
    if (row.status === "ACTIVE_CONFIRMED") {
        const order = row.normalizedOrder as NormalizedProviderOrder;
        if (order.status !== "ACTIVE" || order.remainingQuantity === null || BigInt(order.remainingQuantity) <= 0n || order.startTime === null || order.endTime === null || row.observedAt === null)
            return false;
        const observed = Date.parse(row.observedAt as string);
        if (!(BigInt(order.startTime) * 1000n <= BigInt(observed) && BigInt(observed) < BigInt(order.endTime) * 1000n))
            return false;
    }
    if (["ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED"].includes(String(row.status)) && (row.httpStatus !== 200 || row.responseBodySha256 === null || row.observedAt === null || row.retry.retryable !== false || row.retry.recommendedPolicyClass !== "NONE"))
        return false;
    return true;
}
/** Normalizer handoff for the versioned pure OpenSea adapter. No JSON parsing occurs here. */
export function interpretOpenSeaExactOrderObservation(input: {
    readonly context: TargetedVerifierContext;
    readonly observation: OpenSeaExactOrderObservationV1;
}): ProviderResult {
    const observation = input.observation;
    if (!isObservationBoundToContext(observation, input.context))
        return base({ context: input.context, httpStatus: null, observedAt: null }, "PROVENANCE_MISMATCH", ["HTTP_STATUS_OR_BODY_UNPROVEN"]);
    if (observation.outcome === "TRANSPORT_FAILED")
        return base({ context: input.context, httpStatus: observation.httpStatus, observedAt: null, transportOutcome: observation.transportOutcome }, "TRANSPORT_FAILED", observation.reasonCodes.length ? observation.reasonCodes : [observation.transportOutcome === "HTTP" ? "HTTP_500" : observation.transportOutcome === "TIMEOUT" ? "REQUEST_TIMEOUT" : "CONNECTION_RESET"], null, null, observation.responseBodySha256);
    const adapterReasons = new Set(["CONTENT_TYPE_UNSUPPORTED", "CONTENT_LENGTH_INVALID", "BODY_TOO_LARGE", "UNSUPPORTED_CONTENT_ENCODING", "RAW_RESPONSE_HASH_MISMATCH", "RAW_RESPONSE_ARTIFACT_HASH_INVALID", "UNTRUSTED_TARGETED_VERIFIER_CONTEXT", "HEADER_INVALID"]);
    const mappedReasons = observation.reasonCodes.map((r) => r === "UNTRUSTED_TARGETED_VERIFIER_CONTEXT" ? "OBSERVATION_TIME_INVALID" : r === "CONTENT_TYPE_UNSUPPORTED" ? "CONTENT_TYPE_UNSUPPORTED" : r === "RAW_RESPONSE_ARTIFACT_HASH_INVALID" ? r : adapterReasons.has(r) ? r : r).filter((r) => RESULT_REASONS.has(r));
    if (observation.outcome !== "VALID" || observation.providerStatus === null)
        return base({ context: input.context, httpStatus: observation.httpStatus, observedAt: observation.observedAt }, observation.outcome === "RATE_LIMITED" ? "RATE_LIMITED" : observation.outcome === "AMBIGUOUS" ? "AMBIGUOUS" : observation.outcome === "UNKNOWN" ? "UNKNOWN" : observation.outcome === "MALFORMED" ? "MALFORMED_RESPONSE" : "UNSUPPORTED", mappedReasons.length ? mappedReasons : ["HTTP_STATUS_OR_BODY_UNPROVEN"], null, null, observation.responseBodySha256);
    const normalized: NormalizedProviderOrder = { orderHash: observation.orderHash!, chain: observation.chain!, protocolAddress: observation.protocolAddress!, contractAddress: observation.contractAddress!, assetIdentifier: observation.assetIdentifier, status: observation.providerStatus as ProviderStatus, remainingQuantity: observation.remainingQuantity, startTime: observation.startTime, endTime: observation.endTime, isPrivate: false, isCriteria: false };
    const mapped: ProviderEvidenceMetadata = { context: input.context, httpStatus: observation.httpStatus, observedAt: observation.observedAt, rawResponseArtifactHash: observation.rawResponseArtifactHash };
    if (observation.providerStatus === "ACTIVE") {
        if (observation.remainingQuantity === null || BigInt(observation.remainingQuantity) <= 0n)
            return base(mapped, "UNKNOWN", ["ACTIVE_QUANTITY_UNPROVEN"], "ACTIVE", normalized, observation.responseBodySha256);
        if (observation.temporalProof !== "ACTIVE_WINDOW_CONFIRMED" || observation.startTime === null || observation.endTime === null || !isIso(observation.observedAt))
            return base(mapped, "UNKNOWN", ["ACTIVE_TIME_UNPROVEN"], "ACTIVE", normalized, observation.responseBodySha256);
        return base(mapped, "ACTIVE_CONFIRMED", [], "ACTIVE", normalized, observation.responseBodySha256);
    }
    if (observation.providerStatus === "INACTIVE")
        return observation.temporalProof === "TRUSTED_OBSERVATION" ? base(mapped, "INACTIVE_CONFIRMED", [], "INACTIVE", normalized, observation.responseBodySha256) : base(mapped, "UNKNOWN", ["OBSERVATION_TIME_INVALID"], "INACTIVE", normalized, observation.responseBodySha256);
    if (observation.providerStatus === "FULFILLED" || observation.providerStatus === "CANCELLED")
        return observation.temporalProof === "TRUSTED_OBSERVATION" ? base(mapped, "TERMINAL_CONFIRMED", [], observation.providerStatus as ProviderStatus, normalized, observation.responseBodySha256) : base(mapped, "UNKNOWN", ["OBSERVATION_TIME_INVALID"], observation.providerStatus as ProviderStatus, normalized, observation.responseBodySha256);
    return observation.temporalProof === "EXPIRED_WINDOW_CONFIRMED" ? base(mapped, "EXPIRED_CONFIRMED", [], "EXPIRED", normalized, observation.responseBodySha256) : base(mapped, "UNKNOWN", ["OBSERVATION_TIME_INVALID"], "EXPIRED", normalized, observation.responseBodySha256);
}
