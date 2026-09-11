import { deepFreeze } from "../evidence/canonicalEvidence.js";

export const TARGETED_VERIFIER_SCHEMA_VERSION = "targeted-verifier-schema-v4" as const;
export const TARGETED_VERIFIER_POLICY_VERSION = "targeted-verifier-policy-v8-2026-09" as const;
export const OPENSEA_ORDER_CONTRACT_VERSION = "opensea-get-order-v1-2026-05" as const;
export const TARGETED_VERIFIER_NORMALIZER_VERSION = "targeted-verifier-normalizer-v5-2026-09" as const;
export const TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION = "active-listings-offline-candidate-v3" as const;
export const TARGETED_VERIFIER_GENERATION_MODEL_VERSION = "active-listings-offline-generation-barrier-v2" as const;
export const TARGETED_VERIFIER_ENDPOINT_PATH = "/api/v2/orders/chain/{chain}/protocol/{protocol_address}/{order_hash}" as const;
export const TARGETED_VERIFIER_SUPPORTED_CHAIN = "gunzilla" as const;
export const TARGETED_VERIFIER_SUPPORTED_COLLECTION = "off-the-grid" as const;
export const TARGETED_VERIFIER_SUPPORTED_CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271" as const;

export type CandidateClassification = "PRESENT" | "ABSENT_CANDIDATE" | "BLOCKED";
export type ProviderStatus = "ACTIVE" | "INACTIVE" | "FULFILLED" | "CANCELLED" | "EXPIRED";
export type TransportOutcome = "HTTP" | "TIMEOUT" | "CONNECTION_RESET";
export type VerifierStatus =
  | "VERIFIER_NOT_ELIGIBLE" | "ACTIVE_CONFIRMED" | "INACTIVE_CONFIRMED"
  | "TERMINAL_CONFIRMED" | "EXPIRED_CONFIRMED" | "UNKNOWN" | "AMBIGUOUS"
  | "UNSUPPORTED" | "RATE_LIMITED" | "TRANSPORT_FAILED" | "MALFORMED_RESPONSE"
  | "RECONCILIATION_REQUIRED" | "PROVENANCE_MISMATCH" | "STALE";

export type RelevantEventType = "item_listed" | "item_sold" | "item_cancelled" | "order_invalidate" | "order_revalidate" | "item_transferred" | "reconciliation_required";

export interface LocalWatermark {
  readonly eventId: string;
  readonly receivedAt: string;
}

export interface RelevantOrderEvent {
  readonly eventId: string;
  readonly eventType: RelevantEventType;
  readonly orderHash: string;
  readonly eventVersion: string | null;
}

export interface RelevantOrderFingerprint {
  readonly orderHash: string;
  readonly eventIds: readonly string[];
  readonly events: readonly RelevantOrderEvent[];
  readonly orderingAmbiguous: boolean;
}

export interface JournalFenceSnapshot {
  readonly watermark: LocalWatermark;
  readonly relevantOrderFingerprint: RelevantOrderFingerprint;
}

export interface TargetedVerifierContext {
  readonly sweepId: string;
  readonly orderHash: string;
  readonly candidateArtifactHash: string;
  readonly barrierArtifactHash: string;
  readonly generationRootHash: string;
  readonly candidateModelVersion: string;
  readonly generationModelVersion: string;
  readonly chain: string;
  readonly collectionSlug: string;
  readonly contractAddress: string;
  readonly protocolAddress: string;
  readonly expectedIdentity: Readonly<{ orderHash: string; chain: string; contractAddress: string; tokenId: string; collectionSlug: string; protocolAddress: string }>;
  readonly candidateClassification: CandidateClassification;
  readonly targetedVerifierEligible: boolean;
  readonly candidateAuthorityGranted: false;
  readonly generationDeactivationAuthorityGranted: false;
  readonly verifierSchemaVersion: typeof TARGETED_VERIFIER_SCHEMA_VERSION;
  readonly verifierPolicyVersion: typeof TARGETED_VERIFIER_POLICY_VERSION;
  readonly providerContractVersion: typeof OPENSEA_ORDER_CONTRACT_VERSION;
  readonly normalizerVersion: typeof TARGETED_VERIFIER_NORMALIZER_VERSION;
  readonly sourceProvenance: Readonly<Record<string, string>>;
  readonly preVerification: JournalFenceSnapshot;
}

export interface EligibilityResult {
  readonly valid: boolean;
  readonly status: "VERIFIER_NOT_ELIGIBLE" | "READY";
  readonly reasons: readonly string[];
}

export interface SafeHeaders {
  readonly date: string | null;
  readonly retryAfter: string | null;
  readonly requestId: string | null;
  readonly rateLimitLimit: string | null;
  readonly rateLimitRemaining: string | null;
  readonly rateLimitReset: string | null;
}

export interface RequestIdentity {
  readonly method: "GET";
  readonly endpointPath: typeof TARGETED_VERIFIER_ENDPOINT_PATH;
  readonly chain: string;
  readonly protocolAddress: string;
  readonly orderHash: string;
}

export interface RetryMetadata {
  readonly retryable: boolean;
  readonly retryReason: string;
  readonly recommendedPolicyClass: "NONE" | "RATE_LIMITED" | "TRANSIENT_TRANSPORT";
}

export interface NormalizedProviderOrder {
  readonly orderHash: string;
  readonly chain: string;
  readonly protocolAddress: string;
  readonly contractAddress: string;
  readonly assetIdentifier: string | null;
  readonly status: ProviderStatus;
  readonly remainingQuantity: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly isPrivate: false;
  readonly isCriteria: false;
}

export interface ProviderResult {
  readonly status: VerifierStatus;
  readonly reasonCodes: readonly string[];
  readonly providerStatus: ProviderStatus | null;
  readonly normalizedOrder: NormalizedProviderOrder | null;
  readonly observedAt: string | null;
  readonly responseBodySha256: string | null;
  readonly rawResponseArtifactHash: string | null;
  readonly httpStatus: number | null;
  readonly retry: RetryMetadata;
  readonly authorityGranted: false;
  readonly deactivationAuthorityGranted: false;
}

export interface FenceResult {
  readonly status: VerifierStatus;
  readonly reasonCodes: readonly string[];
  readonly preVerification: JournalFenceSnapshot;
  readonly postVerification: JournalFenceSnapshot;
  readonly providerResult: ProviderResult;
  readonly authorityGranted: false;
  readonly deactivationAuthorityGranted: false;
}

export interface TargetedVerifierArtifact {
  readonly artifactType: "targeted-order-verification";
  readonly artifactSchemaVersion: typeof TARGETED_VERIFIER_SCHEMA_VERSION;
  readonly verifierSchemaVersion: typeof TARGETED_VERIFIER_SCHEMA_VERSION;
  readonly verifierPolicyVersion: typeof TARGETED_VERIFIER_POLICY_VERSION;
  readonly providerContractVersion: typeof OPENSEA_ORDER_CONTRACT_VERSION;
  readonly normalizerVersion: typeof TARGETED_VERIFIER_NORMALIZER_VERSION;
  readonly sweepId: string;
  readonly orderHash: string;
  readonly candidateArtifactHash: string;
  readonly barrierArtifactHash: string;
  readonly generationRootHash: string;
  readonly chain: string;
  readonly collectionSlug: string;
  readonly contractAddress: string;
  readonly protocolAddress: string;
  readonly expectedIdentity: Readonly<{ orderHash: string; chain: string; contractAddress: string; tokenId: string; collectionSlug: string; protocolAddress: string }>;
  readonly verificationStartedAt: string;
  readonly verificationCompletedAt: string;
  readonly providerObservedAt: string | null;
  readonly requestIdentity: RequestIdentity;
  readonly httpStatus: number | null;
  readonly transportOutcome: TransportOutcome;
  readonly safeHeaders: SafeHeaders;
  readonly responseBodySha256: string | null;
  readonly rawResponseArtifactHash: string | null;
  readonly preVerificationWatermark: LocalWatermark;
  readonly postVerificationWatermark: LocalWatermark;
  readonly preRelevantFingerprint: RelevantOrderFingerprint;
  readonly postRelevantFingerprint: RelevantOrderFingerprint;
  readonly normalizedProviderStatus: ProviderStatus | null;
  readonly providerResultStatus: VerifierStatus;
  readonly providerReasonCodes: readonly string[];
  readonly normalizedOrder: NormalizedProviderOrder | null;
  readonly resultStatus: VerifierStatus;
  readonly reasonCodes: readonly string[];
  readonly authorityGranted: false;
  readonly deactivationAuthorityGranted: false;
}

export interface AttemptEvidence {
  readonly attemptNumber: number;
  readonly sweepId: string;
  readonly candidateArtifactHash: string;
  readonly barrierArtifactHash: string;
  readonly generationRootHash: string;
  readonly candidateModelVersion: string;
  readonly generationModelVersion: string;
  readonly attemptId: string;
  readonly responseBodySha256: string | null;
  readonly rawResponseArtifactHash: string | null;
  readonly normalizedProviderStatus: ProviderStatus | null;
  readonly providerResultStatus: VerifierStatus;
  readonly providerReasonCodes: readonly string[];
  readonly normalizedOrder: NormalizedProviderOrder | null;
  readonly resultStatus: VerifierStatus;
  readonly reasonCodes: readonly string[];
  readonly preVerificationWatermark: LocalWatermark;
  readonly postVerificationWatermark: LocalWatermark;
  readonly preRelevantFingerprint: RelevantOrderFingerprint;
  readonly postRelevantFingerprint: RelevantOrderFingerprint;
  readonly verifierSchemaVersion: string;
  readonly verifierPolicyVersion: string;
  readonly providerContractVersion: string;
  readonly normalizerVersion: string;
  readonly requestIdentity: RequestIdentity;
  readonly semanticEvidenceHash: string;
  readonly expectedIdentity: Readonly<{ orderHash: string; chain: string; contractAddress: string; tokenId: string; collectionSlug: string; protocolAddress: string }>;
}

export type VerifierLifecycle = "NOT_STARTED" | "REQUEST_PENDING" | "RESPONSE_OBSERVED" | "PENDING_FENCE" | "COMPLETE" | "FAILED";

export function freezeVerifier<T>(value: T): Readonly<T> { return deepFreeze(value) as Readonly<T>; }
