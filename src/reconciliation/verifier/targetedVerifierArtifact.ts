import { canonicalEvidence, deepFreeze, sha256Canonical } from "../evidence/canonicalEvidence.js";
import { attemptIdentity, cloneOwned, cloneTargetedVerifierContext, isCanonicalHash, isIso, normalizeSafeHeaders, validateAttemptEvidence, validateJournalFenceSnapshot, validateTargetedVerifierEligibility, relevantFingerprintKey } from "./targetedVerifierPolicy.js";
import { validateProviderResult } from "./targetedVerifierNormalizer.js";
import { TARGETED_VERIFIER_ENDPOINT_PATH, type AttemptEvidence, type FenceResult, type JournalFenceSnapshot, type ProviderResult, type TargetedVerifierArtifact, type TargetedVerifierContext, type TransportOutcome } from "./targetedVerifierTypes.js";

const RUNTIME_FENCE_PROOF = new WeakSet<object>();
const FENCE_REASONS = new Set(["ACTIVE_QUANTITY_UNPROVEN", "ACTIVE_TIME_UNPROVEN", "ACTIVE_TIME_INVALID", "OBSERVATION_TIME_INVALID", "ORDER_TIME_INVALID", "ORDER_TIME_RANGE_INVALID", "RESPONSE_OBJECT_REQUIRED", "IDENTITY_MISMATCH", "CHAIN_MISMATCH", "PROTOCOL_MISMATCH", "CONTRACT_MISMATCH", "PROTOCOL_ADDRESS_MISSING_OR_INVALID", "ASSET_CONTRACT_MISSING_OR_INVALID", "ASSET_IDENTITY_MALFORMED", "REMAINING_QUANTITY_INVALID", "UNKNOWN_PROVIDER_STATUS", "PRIVATE_ORDER_UNSUPPORTED", "CRITERIA_ORDER_UNSUPPORTED", "UNSUPPORTED_ORDER_SHAPE", "UNSUPPORTED_PROTOCOL", "UNSUPPORTED_ORDER_TYPE", "MALFORMED_JSON", "HTTP_404_NOT_STATE_PROOF", "HTTP_400_UNSUPPORTED_OR_INVALID_REQUEST", "HTTP_401_ACCESS_FAILURE", "HTTP_403_ACCESS_FAILURE", "HTTP_409_PROVIDER_CONFLICT", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504", "REQUEST_TIMEOUT", "CONNECTION_RESET", "HTTP_STATUS_OR_BODY_UNPROVEN", "RAW_RESPONSE_ARTIFACT_HASH_INVALID", "AMBIGUOUS_JOURNAL_ORDERING", "WATERMARK_REGRESSION", "FENCE_ORDER_MISMATCH", "RELEVANT_ORDER_EVENT_ACROSS_FENCE"]);

function sorted(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
export function applyJournalFence(providerResult: ProviderResult, pre: JournalFenceSnapshot, post: JournalFenceSnapshot): FenceResult {
  return constructTrustedFenceResult(providerResult, pre, post);
}

function fenceWatermarkCompare(left: JournalFenceSnapshot["watermark"], right: JournalFenceSnapshot["watermark"]): number {
  const ids = BigInt(left.eventId) - BigInt(right.eventId);
  if (ids < 0n) return -1;
  if (ids > 0n) return 1;
  return Date.parse(left.receivedAt) < Date.parse(right.receivedAt) ? -1 : Date.parse(left.receivedAt) > Date.parse(right.receivedAt) ? 1 : 0;
}

export function validateFenceResult(value: unknown): value is FenceResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!RUNTIME_FENCE_PROOF.has(value)) return false;
  if (typeof row.status !== "string" || !Array.isArray(row.reasonCodes) || row.authorityGranted !== false || row.deactivationAuthorityGranted !== false) return false;
  if (!row.reasonCodes.every((reason) => typeof reason === "string" && FENCE_REASONS.has(reason)) || JSON.stringify(row.reasonCodes) !== JSON.stringify([...row.reasonCodes].sort())) return false;
  if (!validateJournalFenceSnapshot(row.preVerification) || !validateJournalFenceSnapshot(row.postVerification) || !validateProviderResult(row.providerResult)) return false;
  const pre = row.preVerification as JournalFenceSnapshot, post = row.postVerification as JournalFenceSnapshot;
  const changed = relevantFingerprintKey(pre.relevantOrderFingerprint) !== relevantFingerprintKey(post.relevantOrderFingerprint) || pre.relevantOrderFingerprint.orderingAmbiguous || post.relevantOrderFingerprint.orderingAmbiguous || BigInt(post.watermark.eventId) < BigInt(pre.watermark.eventId);
  return changed ? row.status === "RECONCILIATION_REQUIRED" : row.status === row.providerResult.status;
}

function constructTrustedFenceResult(providerResult: ProviderResult, pre: JournalFenceSnapshot, post: JournalFenceSnapshot): FenceResult {
  if (!validateProviderResult(providerResult)) throw new Error("INVALID_PROVIDER_RESULT");
  if (!validateJournalFenceSnapshot(pre) || !validateJournalFenceSnapshot(post)) throw new Error("INVALID_JOURNAL_FENCE");
  const ownedPre = cloneOwned(pre), ownedPost = cloneOwned(post), reasons: string[] = [];
  if (ownedPre.relevantOrderFingerprint.orderHash !== ownedPost.relevantOrderFingerprint.orderHash) reasons.push("FENCE_ORDER_MISMATCH");
  if (ownedPre.relevantOrderFingerprint.orderingAmbiguous || ownedPost.relevantOrderFingerprint.orderingAmbiguous) reasons.push("AMBIGUOUS_JOURNAL_ORDERING");
  if (fenceWatermarkCompare(ownedPost.watermark, ownedPre.watermark) < 0) reasons.push("WATERMARK_REGRESSION");
  if (relevantFingerprintKey(ownedPre.relevantOrderFingerprint) !== relevantFingerprintKey(ownedPost.relevantOrderFingerprint)) reasons.push("RELEVANT_ORDER_EVENT_ACROSS_FENCE");
  const owned = { status: reasons.length > 0 ? "RECONCILIATION_REQUIRED" as const : providerResult.status, reasonCodes: sorted([...providerResult.reasonCodes, ...reasons]), preVerification: ownedPre, postVerification: ownedPost, providerResult, authorityGranted: false as const, deactivationAuthorityGranted: false as const };
  RUNTIME_FENCE_PROOF.add(owned);
  const result = deepFreeze(owned);
  if (!validateFenceResult(result)) throw new Error("INVALID_TRUSTED_FENCE_RESULT");
  return result;
}

export interface BuildArtifactInput {
  readonly context: TargetedVerifierContext;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly providerResult: ProviderResult;
  readonly fenceResult: FenceResult;
  readonly transportOutcome: TransportOutcome;
  readonly safeHeaders: unknown;
  readonly rawResponseArtifactHash?: string | null;
}

export function buildTargetedVerifierArtifact(input: BuildArtifactInput): TargetedVerifierArtifact {
  const eligibility = validateTargetedVerifierEligibility(input.context);
  if (!eligibility.valid) throw new Error(`VERIFIER_NOT_ELIGIBLE:${eligibility.reasons.join(",")}`);
  if (!isIso(input.startedAt) || !isIso(input.completedAt) || Date.parse(input.completedAt) < Date.parse(input.startedAt)) throw new Error("INVALID_VERIFICATION_TIME");
  if (!validateProviderResult(input.providerResult)) throw new Error("INVALID_PROVIDER_RESULT");
  if (!validateFenceResult(input.fenceResult)) throw new Error("INVALID_FENCE_RESULT");
  if (canonicalEvidence(input.fenceResult.providerResult) !== canonicalEvidence(input.providerResult)) throw new Error("FENCE_PROVIDER_MISMATCH");
  const normalized = input.providerResult.normalizedOrder;
  if (normalized !== null && (normalized.orderHash !== input.context.orderHash || normalized.chain !== input.context.chain || normalized.protocolAddress !== input.context.protocolAddress || normalized.contractAddress !== input.context.contractAddress)) throw new Error("PROVIDER_SCOPE_MISMATCH");
  if (input.rawResponseArtifactHash !== null && input.rawResponseArtifactHash !== undefined && !isCanonicalHash(input.rawResponseArtifactHash)) throw new Error("INVALID_RAW_RESPONSE_ARTIFACT_HASH");
  const context = cloneTargetedVerifierContext(input.context);
  const provider = cloneOwned(input.providerResult);
  const fence = cloneOwned(input.fenceResult);
  const requestIdentity = { method: "GET" as const, endpointPath: TARGETED_VERIFIER_ENDPOINT_PATH, chain: context.chain, protocolAddress: context.protocolAddress, orderHash: context.orderHash };
  return deepFreeze({
    artifactType: "targeted-order-verification" as const,
    artifactSchemaVersion: context.verifierSchemaVersion,
    verifierSchemaVersion: context.verifierSchemaVersion,
    verifierPolicyVersion: context.verifierPolicyVersion,
    providerContractVersion: context.providerContractVersion,
    normalizerVersion: context.normalizerVersion,
    sweepId: context.sweepId,
    orderHash: context.orderHash,
    candidateArtifactHash: context.candidateArtifactHash,
    barrierArtifactHash: context.barrierArtifactHash,
    generationRootHash: context.generationRootHash,
    chain: context.chain,
    collectionSlug: context.collectionSlug,
    contractAddress: context.contractAddress,
    protocolAddress: context.protocolAddress,
    expectedIdentity: context.expectedIdentity,
    verificationStartedAt: input.startedAt,
    verificationCompletedAt: input.completedAt,
    providerObservedAt: provider.observedAt,
    requestIdentity,
    httpStatus: input.providerResult.httpStatus,
    transportOutcome: input.transportOutcome,
    safeHeaders: normalizeSafeHeaders(input.safeHeaders),
    responseBodySha256: provider.responseBodySha256,
    rawResponseArtifactHash: input.rawResponseArtifactHash ?? provider.rawResponseArtifactHash,
    preVerificationWatermark: fence.preVerification.watermark,
    postVerificationWatermark: fence.postVerification.watermark,
    preRelevantFingerprint: fence.preVerification.relevantOrderFingerprint,
    postRelevantFingerprint: fence.postVerification.relevantOrderFingerprint,
    normalizedProviderStatus: provider.providerStatus,
    providerResultStatus: provider.status,
    providerReasonCodes: sorted(provider.reasonCodes),
    normalizedOrder: provider.normalizedOrder,
    resultStatus: fence.status,
    reasonCodes: sorted(fence.reasonCodes),
    authorityGranted: false as const,
    deactivationAuthorityGranted: false as const
  });
}

export function verifierArtifactHash(artifact: TargetedVerifierArtifact): string { return sha256Canonical(artifact); }
export function sameAttemptEvidence(left: unknown, right: unknown): "IDEMPOTENT" | "CONFLICT" | "INCOMPLETE" {
  const validLeft = validateAttemptEvidence(left), validRight = validateAttemptEvidence(right);
  if (!validLeft || !validRight) return "INCOMPLETE";
  if (left.attemptId !== right.attemptId) return "CONFLICT";
  const identity = (value: AttemptEvidence) => sha256Canonical(value);
  return identity(left) === identity(right) ? "IDEMPOTENT" : "CONFLICT";
}

export function canonicalVerifierIdentity(context: TargetedVerifierContext, attemptNumber: number): string { return attemptIdentity(context, attemptNumber); }

export function providerResultIsAuthoritative(result: unknown): boolean {
  if (validateProviderResult(result)) return ["ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED"].includes(result.status);
  if (validateFenceResult(result)) return ["ACTIVE_CONFIRMED", "INACTIVE_CONFIRMED", "TERMINAL_CONFIRMED", "EXPIRED_CONFIRMED"].includes(result.status);
  return false;
}

export function canonicalFingerprint(value: JournalFenceSnapshot): string { return canonicalEvidence(value.relevantOrderFingerprint); }
