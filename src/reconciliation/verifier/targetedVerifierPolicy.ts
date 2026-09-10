import { canonicalEvidence, deepFreeze, sha256Bytes } from "../evidence/canonicalEvidence.js";
import {
  OPENSEA_ORDER_CONTRACT_VERSION, TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION,
  TARGETED_VERIFIER_ENDPOINT_PATH, TARGETED_VERIFIER_GENERATION_MODEL_VERSION,
  TARGETED_VERIFIER_NORMALIZER_VERSION, TARGETED_VERIFIER_POLICY_VERSION,
  TARGETED_VERIFIER_SCHEMA_VERSION, TARGETED_VERIFIER_SUPPORTED_CHAIN,
  TARGETED_VERIFIER_SUPPORTED_COLLECTION, TARGETED_VERIFIER_SUPPORTED_CONTRACT,
  type EligibilityResult, type JournalFenceSnapshot, type RelevantOrderEvent,
  type RelevantOrderFingerprint, type SafeHeaders, type TargetedVerifierContext,
  type AttemptEvidence, type ProviderStatus, type NormalizedProviderOrder, type RetryMetadata
} from "./targetedVerifierTypes.js";
import { SUPPORTED_CHAIN, SUPPORTED_COLLECTION_SLUG, SUPPORTED_CONTRACT_ADDRESS } from "../identityScope.js";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVENT_TYPES = new Set(["item_listed", "item_sold", "item_cancelled", "order_invalidate", "order_revalidate", "item_transferred", "reconciliation_required"]);
const PROVIDER_STATUSES = new Set(["ACTIVE", "INACTIVE", "FULFILLED", "CANCELLED", "EXPIRED"]);

export const SUPPORTED_PROVIDER_STATUSES = ["ACTIVE", "INACTIVE", "FULFILLED", "CANCELLED", "EXPIRED"] as const;

export function isCanonicalOrderHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
export function isCanonicalAddress(value: unknown): value is string { return typeof value === "string" && ADDRESS.test(value); }
export function isCanonicalHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
export function isIso(value: unknown): value is string {
  if (typeof value !== "string" || !ISO.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
export function isDecimal(value: unknown): value is string { return typeof value === "string" && DECIMAL.test(value); }
export function isKnownProviderStatus(value: unknown): value is import("./targetedVerifierTypes.js").ProviderStatus { return typeof value === "string" && PROVIDER_STATUSES.has(value); }

function sortedReasons(reasons: readonly string[]): readonly string[] { return [...new Set(reasons)].sort(); }
export function cloneOwned<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) throw new Error("CYCLIC_VERIFIER_INPUT");
    const out: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : {};
    seen.set(item, out);
    for (const key of Object.keys(item as Record<string, unknown>)) (out as Record<string, unknown>)[key] = visit((item as Record<string, unknown>)[key]);
    return out;
  };
  return visit(value) as T;
}

function validProvenance(value: unknown): value is Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(([key, item]) => key.length > 0 && isCanonicalHash(item)) && entries.every((entry, index) => index === 0 || entries[index - 1][0].localeCompare(entry[0]) <= 0);
}

export function validateWatermark(value: unknown): value is JournalFenceSnapshot["watermark"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return isDecimal(row.eventId) && isIso(row.receivedAt);
}

export function validateRelevantFingerprint(value: unknown): value is RelevantOrderFingerprint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!isCanonicalOrderHash(row.orderHash) || typeof row.orderingAmbiguous !== "boolean" || !Array.isArray(row.eventIds) || !Array.isArray(row.events)) return false;
  const eventIds = row.eventIds as unknown[];
  if (!eventIds.every((id) => isDecimal(id)) || new Set(eventIds).size !== eventIds.length) return false;
  if (!row.events.every((event) => {
    if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
    const item = event as Record<string, unknown>;
    return isDecimal(item.eventId) && EVENT_TYPES.has(String(item.eventType)) && isCanonicalOrderHash(item.orderHash) && (item.eventVersion === null || isDecimal(item.eventVersion));
  })) return false;
  const ids = (row.events as Array<Record<string, unknown>>).map((event) => event.eventId);
  const ordered = [...eventIds].sort((left, right) => BigInt(left as string) < BigInt(right as string) ? -1 : BigInt(left as string) > BigInt(right as string) ? 1 : 0);
  return ids.length === eventIds.length && ids.every((id, index) => id === eventIds[index]) && eventIds.every((id, index) => id === ordered[index]) && (row.events as Array<Record<string, unknown>>).every((event) => event.orderHash === row.orderHash);
}

export function validateJournalFenceSnapshot(value: unknown): value is JournalFenceSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return validateWatermark(row.watermark) && validateRelevantFingerprint(row.relevantOrderFingerprint);
}

export function validateTargetedVerifierEligibility(context: unknown): EligibilityResult {
  const reasons: string[] = [];
  if (context === null || typeof context !== "object" || Array.isArray(context)) return deepFreeze({ valid: false, status: "VERIFIER_NOT_ELIGIBLE", reasons: ["INVALID_CONTEXT"] });
  const value = context as Record<string, unknown>;
  if (!Object.isFrozen(value)) reasons.push("CONTEXT_NOT_IMMUTABLE");
  if (typeof value.sweepId !== "string" || value.sweepId.trim() === "") reasons.push("INVALID_SWEEP_ID");
  if (!isCanonicalOrderHash(value.orderHash)) reasons.push("INVALID_ORDER_HASH");
  for (const field of ["candidateArtifactHash", "barrierArtifactHash", "generationRootHash"] as const) if (!isCanonicalHash(value[field])) reasons.push(`INVALID_${field.toUpperCase()}`);
  if (value.candidateModelVersion !== TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION) reasons.push("CANDIDATE_MODEL_MISMATCH");
  if (value.generationModelVersion !== TARGETED_VERIFIER_GENERATION_MODEL_VERSION) reasons.push("GENERATION_MODEL_MISMATCH");
  if (value.candidateClassification !== "ABSENT_CANDIDATE") reasons.push("CANDIDATE_NOT_ABSENT");
  if (value.targetedVerifierEligible !== true) reasons.push("TARGETED_VERIFIER_NOT_ELIGIBLE");
  if (value.candidateAuthorityGranted !== false) reasons.push("CANDIDATE_AUTHORITY_NOT_FALSE");
  if (value.generationDeactivationAuthorityGranted !== false) reasons.push("GENERATION_AUTHORITY_NOT_FALSE");
  if (value.verifierSchemaVersion !== TARGETED_VERIFIER_SCHEMA_VERSION || value.verifierPolicyVersion !== TARGETED_VERIFIER_POLICY_VERSION || value.providerContractVersion !== OPENSEA_ORDER_CONTRACT_VERSION || value.normalizerVersion !== TARGETED_VERIFIER_NORMALIZER_VERSION) reasons.push("UNSUPPORTED_VERIFIER_VERSION");
  if (value.chain !== SUPPORTED_CHAIN || value.collectionSlug !== SUPPORTED_COLLECTION_SLUG || value.contractAddress !== SUPPORTED_CONTRACT_ADDRESS || !isCanonicalAddress(value.protocolAddress)) reasons.push("UNSUPPORTED_ORDER_SCOPE");
  const identity = value.expectedIdentity as Record<string, unknown> | null;
  if (!identity || identity.orderHash !== value.orderHash || identity.chain !== value.chain || identity.contractAddress !== value.contractAddress || identity.collectionSlug !== value.collectionSlug || identity.protocolAddress !== value.protocolAddress || !isDecimal(identity.tokenId) || !Object.isFrozen(identity)) reasons.push("INVALID_EXPECTED_IDENTITY");
  if (!validProvenance(value.sourceProvenance)) reasons.push("INVALID_PROVENANCE");
  if (!validateJournalFenceSnapshot(value.preVerification)) reasons.push("INVALID_PRE_VERIFICATION_FENCE");
  if (isCanonicalOrderHash(value.orderHash) && validateJournalFenceSnapshot(value.preVerification) && value.preVerification.relevantOrderFingerprint.orderHash !== value.orderHash) reasons.push("FENCE_ORDER_MISMATCH");
  return deepFreeze({ valid: reasons.length === 0, status: reasons.length === 0 ? "READY" : "VERIFIER_NOT_ELIGIBLE", reasons: sortedReasons(reasons) });
}

export function cloneTargetedVerifierContext(context: unknown): TargetedVerifierContext {
  const result = validateTargetedVerifierEligibility(context);
  if (!result.valid) throw new Error(`VERIFIER_NOT_ELIGIBLE:${result.reasons.join(",")}`);
  return deepFreeze(cloneOwned(context)) as TargetedVerifierContext;
}

export function canonicalRequestIdentity(context: TargetedVerifierContext) {
  return deepFreeze({ method: "GET" as const, endpointPath: TARGETED_VERIFIER_ENDPOINT_PATH, chain: context.chain, protocolAddress: context.protocolAddress, orderHash: context.orderHash });
}

export function normalizeSafeHeaders(value: unknown): SafeHeaders {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (name: string): string | null => typeof row[name] === "string" && (row[name] as string).length > 0 ? row[name] as string : null;
  return deepFreeze({ date: text("date"), retryAfter: text("retry-after"), requestId: text("x-request-id"), rateLimitLimit: text("x-ratelimit-limit"), rateLimitRemaining: text("x-ratelimit-remaining"), rateLimitReset: text("x-ratelimit-reset") });
}

export function validateRetryMetadata(value: unknown): value is RetryMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.retryable === "boolean" && typeof row.retryReason === "string" && row.retryReason.length > 0 &&
    (row.recommendedPolicyClass === "NONE" || row.recommendedPolicyClass === "RATE_LIMITED" || row.recommendedPolicyClass === "TRANSIENT_TRANSPORT");
}

const RESULT_STATUSES = new Set(["VERIFIER_NOT_ELIGIBLE", "ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED", "UNKNOWN", "AMBIGUOUS", "UNSUPPORTED", "RATE_LIMITED", "TRANSPORT_FAILED", "MALFORMED_RESPONSE", "RECONCILIATION_REQUIRED", "PROVENANCE_MISMATCH", "STALE"]);
const RESULT_REASONS = new Set(["ACTIVE_QUANTITY_UNPROVEN", "ACTIVE_TIME_UNPROVEN", "ACTIVE_TIME_INVALID", "OBSERVATION_TIME_INVALID", "ORDER_TIME_INVALID", "ORDER_TIME_RANGE_INVALID", "RESPONSE_OBJECT_REQUIRED", "IDENTITY_MISMATCH", "CHAIN_MISMATCH", "PROTOCOL_MISMATCH", "CONTRACT_MISMATCH", "PROTOCOL_ADDRESS_MISSING_OR_INVALID", "ASSET_CONTRACT_MISSING_OR_INVALID", "ASSET_IDENTITY_MALFORMED", "REMAINING_QUANTITY_INVALID", "UNKNOWN_PROVIDER_STATUS", "PRIVATE_ORDER_UNSUPPORTED", "CRITERIA_ORDER_UNSUPPORTED", "UNSUPPORTED_ORDER_SHAPE", "UNSUPPORTED_PROTOCOL", "UNSUPPORTED_ORDER_TYPE", "MALFORMED_JSON", "HTTP_404_NOT_STATE_PROOF", "HTTP_400_UNSUPPORTED_OR_INVALID_REQUEST", "HTTP_401_ACCESS_FAILURE", "HTTP_403_ACCESS_FAILURE", "HTTP_409_PROVIDER_CONFLICT", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504", "REQUEST_TIMEOUT", "CONNECTION_RESET", "HTTP_STATUS_OR_BODY_UNPROVEN", "RAW_RESPONSE_ARTIFACT_HASH_INVALID", "AMBIGUOUS_JOURNAL_ORDERING", "WATERMARK_REGRESSION", "FENCE_ORDER_MISMATCH", "RELEVANT_ORDER_EVENT_ACROSS_FENCE", "VERIFIER_NOT_ELIGIBLE", "INVALID_CONTEXT", "INVALID_SWEEP_ID", "INVALID_ORDER_HASH", "INVALID_CANDIDATEARTIFACTHASH", "INVALID_BARRIERARTIFACTHASH", "INVALID_GENERATIONROOTHASH", "CANDIDATE_MODEL_MISMATCH", "GENERATION_MODEL_MISMATCH", "CANDIDATE_NOT_ABSENT", "TARGETED_VERIFIER_NOT_ELIGIBLE", "CANDIDATE_AUTHORITY_NOT_FALSE", "GENERATION_AUTHORITY_NOT_FALSE", "UNSUPPORTED_VERIFIER_VERSION", "UNSUPPORTED_ORDER_SCOPE", "INVALID_PROVENANCE", "INVALID_PRE_VERIFICATION_FENCE", "FENCE_ORDER_MISMATCH"]);

export function validateNormalizedProviderOrder(value: unknown): value is NormalizedProviderOrder {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!isCanonicalOrderHash(row.orderHash) || typeof row.chain !== "string" || !isCanonicalAddress(row.protocolAddress) || !isCanonicalAddress(row.contractAddress) || row.assetIdentifier !== null && !isDecimal(row.assetIdentifier) || !isKnownProviderStatus(row.status)) return false;
  if (row.remainingQuantity !== null && !isDecimal(row.remainingQuantity)) return false;
  if (row.startTime !== null && (!isDecimal(row.startTime) || !epochValid(row.startTime))) return false;
  if (row.endTime !== null && (!isDecimal(row.endTime) || !epochValid(row.endTime))) return false;
  return row.isPrivate === false && row.isCriteria === false && (row.startTime === null || row.endTime === null || BigInt(row.startTime) < BigInt(row.endTime));
}

function epochValid(value: unknown): value is string { try { return isDecimal(value) && BigInt(value) > 0n && BigInt(value) < 8640000000000n; } catch { return false; } }

const ATTEMPT_REQUIRED_FIELDS = ["attemptNumber", "sweepId", "candidateArtifactHash", "barrierArtifactHash", "generationRootHash", "candidateModelVersion", "generationModelVersion", "attemptId", "responseBodySha256", "rawResponseArtifactHash", "normalizedProviderStatus", "providerResultStatus", "providerReasonCodes", "normalizedOrder", "resultStatus", "reasonCodes", "preVerificationWatermark", "postVerificationWatermark", "preRelevantFingerprint", "postRelevantFingerprint", "verifierSchemaVersion", "verifierPolicyVersion", "providerContractVersion", "normalizerVersion", "requestIdentity", "expectedIdentity", "semanticEvidenceHash"] as const;
const ATTEMPT_ALLOWED_FIELDS = new Set<string>(ATTEMPT_REQUIRED_FIELDS);

export function canonicalAttemptMaterial(value: { readonly sweepId: string; readonly candidateArtifactHash: string; readonly barrierArtifactHash: string; readonly generationRootHash: string; readonly candidateModelVersion: string; readonly generationModelVersion: string; readonly verifierSchemaVersion: string; readonly verifierPolicyVersion: string; readonly providerContractVersion: string; readonly normalizerVersion: string; readonly requestIdentity: unknown; readonly expectedIdentity: unknown; readonly attemptNumber: number }): unknown {
  return { sweepId: value.sweepId, candidateArtifactHash: value.candidateArtifactHash, barrierArtifactHash: value.barrierArtifactHash, generationRootHash: value.generationRootHash, candidateModelVersion: value.candidateModelVersion, generationModelVersion: value.generationModelVersion, verifierSchemaVersion: value.verifierSchemaVersion, verifierPolicyVersion: value.verifierPolicyVersion, providerContractVersion: value.providerContractVersion, normalizerVersion: value.normalizerVersion, requestIdentity: value.requestIdentity, expectedIdentity: value.expectedIdentity, attemptNumber: value.attemptNumber };
}

export function semanticEvidenceMaterial(value: Record<string, unknown>): unknown {
  const copy = { ...value }; delete copy.semanticEvidenceHash; delete copy.attemptId;
  return copy;
}

export function validateAttemptEvidence(value: unknown): value is AttemptEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!ATTEMPT_REQUIRED_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(row, field))) return false;
  if (Object.keys(row).some((field) => !ATTEMPT_ALLOWED_FIELDS.has(field))) return false;
  if (!Number.isSafeInteger(row.attemptNumber) || (row.attemptNumber as number) < 0 || typeof row.sweepId !== "string" || !isCanonicalHash(row.candidateArtifactHash) || !isCanonicalHash(row.barrierArtifactHash) || !isCanonicalHash(row.generationRootHash) || row.candidateModelVersion !== TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION || row.generationModelVersion !== TARGETED_VERIFIER_GENERATION_MODEL_VERSION || row.verifierSchemaVersion !== TARGETED_VERIFIER_SCHEMA_VERSION || row.verifierPolicyVersion !== TARGETED_VERIFIER_POLICY_VERSION || row.providerContractVersion !== OPENSEA_ORDER_CONTRACT_VERSION || row.normalizerVersion !== TARGETED_VERIFIER_NORMALIZER_VERSION) return false;
  if (!isCanonicalHash(row.attemptId) || row.responseBodySha256 !== null && !isCanonicalHash(row.responseBodySha256) || row.rawResponseArtifactHash !== null && !isCanonicalHash(row.rawResponseArtifactHash) || !isCanonicalHash(row.semanticEvidenceHash)) return false;
  if (typeof row.verifierSchemaVersion !== "string" || row.verifierSchemaVersion.length === 0 || typeof row.verifierPolicyVersion !== "string" || row.verifierPolicyVersion.length === 0 || typeof row.providerContractVersion !== "string" || row.providerContractVersion.length === 0 || typeof row.normalizerVersion !== "string" || row.normalizerVersion.length === 0) return false;
  if (!Array.isArray(row.providerReasonCodes) || !Array.isArray(row.reasonCodes) || !row.providerReasonCodes.every((reason) => typeof reason === "string" && RESULT_REASONS.has(reason)) || !row.reasonCodes.every((reason) => typeof reason === "string" && RESULT_REASONS.has(reason))) return false;
  if (JSON.stringify(row.providerReasonCodes) !== JSON.stringify([...row.providerReasonCodes].sort()) || JSON.stringify(row.reasonCodes) !== JSON.stringify([...row.reasonCodes].sort())) return false;
  if (typeof row.resultStatus !== "string" || !RESULT_STATUSES.has(row.resultStatus) || typeof row.providerResultStatus !== "string" || !RESULT_STATUSES.has(row.providerResultStatus)) return false;
  if (row.normalizedProviderStatus !== null && !isKnownProviderStatus(row.normalizedProviderStatus)) return false;
  if (row.normalizedOrder !== null && !validateNormalizedProviderOrder(row.normalizedOrder)) return false;
  if (!validateWatermark(row.preVerificationWatermark) || !validateWatermark(row.postVerificationWatermark) || !validateRelevantFingerprint(row.preRelevantFingerprint) || !validateRelevantFingerprint(row.postRelevantFingerprint)) return false;
  if (row.requestIdentity === null || typeof row.requestIdentity !== "object" || Array.isArray(row.requestIdentity)) return false;
  const request = row.requestIdentity as Record<string, unknown>;
  if (request.method !== "GET" || request.endpointPath !== TARGETED_VERIFIER_ENDPOINT_PATH || request.chain !== SUPPORTED_CHAIN || !isCanonicalAddress(request.protocolAddress) || !isCanonicalOrderHash(request.orderHash)) return false;
  const identity = row.expectedIdentity as Record<string, unknown>;
  if (identity === null || typeof identity !== "object" || identity.orderHash !== request.orderHash || identity.chain !== request.chain || identity.protocolAddress !== request.protocolAddress || identity.collectionSlug !== SUPPORTED_COLLECTION_SLUG || identity.contractAddress !== SUPPORTED_CONTRACT_ADDRESS || !isCanonicalAddress(identity.contractAddress) || !isCanonicalAddress(identity.protocolAddress) || !isDecimal(identity.tokenId)) return false;
  const pre = row.preRelevantFingerprint as unknown as Record<string, unknown>;
  const post = row.postRelevantFingerprint as unknown as Record<string, unknown>;
  if (pre.orderHash !== request.orderHash || post.orderHash !== request.orderHash) return false;
  const expectedAttempt = sha256Bytes(new TextEncoder().encode(canonicalEvidence(canonicalAttemptMaterial(row as any))));
  if (row.attemptId !== expectedAttempt) return false;
  const expectedSemantic = sha256Bytes(new TextEncoder().encode(canonicalEvidence(semanticEvidenceMaterial(row))));
  return row.semanticEvidenceHash === expectedSemantic;
}

export function retryMetadataFor(status: number | null, outcome: "HTTP" | "TIMEOUT" | "CONNECTION_RESET"): { retryable: boolean; retryReason: string; recommendedPolicyClass: "NONE" | "RATE_LIMITED" | "TRANSIENT_TRANSPORT" } {
  if (outcome === "TIMEOUT" || outcome === "CONNECTION_RESET") return { retryable: true, retryReason: outcome, recommendedPolicyClass: "TRANSIENT_TRANSPORT" };
  if (status === 429) return { retryable: true, retryReason: "HTTP_429", recommendedPolicyClass: "RATE_LIMITED" };
  if (status !== null && [500, 502, 503, 504].includes(status)) return { retryable: true, retryReason: `HTTP_${status}`, recommendedPolicyClass: "TRANSIENT_TRANSPORT" };
  return { retryable: false, retryReason: status === 404 ? "HTTP_404_NOT_STATE_PROOF" : `HTTP_${status ?? "TRANSPORT"}`, recommendedPolicyClass: "NONE" };
}

export function attemptIdentity(context: TargetedVerifierContext, attemptNumber: number): string {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 0) throw new Error("INVALID_ATTEMPT_NUMBER");
  return sha256Bytes(new TextEncoder().encode(canonicalEvidence(canonicalAttemptMaterial({ ...context, requestIdentity: canonicalRequestIdentity(context), attemptNumber }))));
}

export function relevantFingerprintKey(value: RelevantOrderFingerprint): string { return canonicalEvidence(value); }

export function eventFingerprint(events: readonly RelevantOrderEvent[], orderHash: string, orderingAmbiguous = false): RelevantOrderFingerprint {
  const sorted = events.map((event) => cloneOwned(event)).sort((a, b) => BigInt(a.eventId) < BigInt(b.eventId) ? -1 : BigInt(a.eventId) > BigInt(b.eventId) ? 1 : 0);
  return deepFreeze({ orderHash, eventIds: sorted.map((event) => event.eventId), events: sorted, orderingAmbiguous });
}
