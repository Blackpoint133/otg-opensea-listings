import { deepFreeze } from "../evidence/canonicalEvidence.js";
import { isTrustedReconstructedEvidence, type IntegratedEvidenceResult } from "../evidence/reconciliationEvidenceIntegration.js";
import { validateOfflineCandidateIdentity, type OfflineCandidateIdentity } from "../offlineCandidateModel.js";
import { validateTargetedVerifierEligibility } from "./targetedVerifierPolicy.js";
import { OPENSEA_ORDER_CONTRACT_VERSION, TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION, TARGETED_VERIFIER_GENERATION_MODEL_VERSION, TARGETED_VERIFIER_NORMALIZER_VERSION, TARGETED_VERIFIER_POLICY_VERSION, TARGETED_VERIFIER_SCHEMA_VERSION, type JournalFenceSnapshot, type TargetedVerifierContext } from "./targetedVerifierTypes.js";

export interface TargetedVerifierContextMetadata { readonly preVerification: JournalFenceSnapshot; }

export function deriveTargetedVerifierContext(evidence: IntegratedEvidenceResult, orderHash: string, metadata: TargetedVerifierContextMetadata): TargetedVerifierContext {
  if (!isTrustedReconstructedEvidence(evidence) || evidence.status !== "VALID" || !evidence.candidate || !evidence.barrier || !evidence.candidateRef || !evidence.barrierRef) throw new Error("UNTRUSTED_INTEGRATED_EVIDENCE");
  const payload = evidence.candidate.payload as Record<string, unknown>;
  const orders = Array.isArray(payload.orders) ? payload.orders as Array<Record<string, unknown>> : [];
  const matches = orders.filter((item) => item.orderHash === orderHash);
  if (matches.length !== 1) throw new Error("CANDIDATE_ORDER_NOT_UNIQUE");
  const candidate = matches[0];
  if (candidate.classification !== "ABSENT_CANDIDATE" || candidate.authorityGranted !== false || !validateOfflineCandidateIdentity(candidate.identity)) throw new Error("CANDIDATE_NOT_TARGETED");
  const generation = evidence.barrier.payload as Record<string, unknown>;
  const advances = Array.isArray(generation.candidateAdvancement) ? generation.candidateAdvancement as Array<Record<string, unknown>> : [];
  const advancement = advances.filter((item) => item.orderHash === orderHash && item.sourceClassification === "ABSENT_CANDIDATE");
  if (advancement.length !== 1 || advancement[0].targetedVerifierEligible !== true || advancement[0].authorityGranted !== false) throw new Error("TARGETED_VERIFIER_NOT_ELIGIBLE");
  const identity = candidate.identity as OfflineCandidateIdentity;
  const context = deepFreeze({ sweepId: String(payload.sweepId), orderHash, candidateArtifactHash: evidence.candidateRef.contentHash, barrierArtifactHash: evidence.barrierRef.contentHash, generationRootHash: evidence.barrierRef.contentHash, candidateModelVersion: TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION, generationModelVersion: TARGETED_VERIFIER_GENERATION_MODEL_VERSION, chain: identity.chain, collectionSlug: identity.collectionSlug, contractAddress: identity.contractAddress, protocolAddress: identity.protocolAddress, expectedIdentity: { ...identity }, candidateClassification: "ABSENT_CANDIDATE" as const, targetedVerifierEligible: true, candidateAuthorityGranted: false as const, generationDeactivationAuthorityGranted: false as const, verifierSchemaVersion: TARGETED_VERIFIER_SCHEMA_VERSION, verifierPolicyVersion: TARGETED_VERIFIER_POLICY_VERSION, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, normalizerVersion: TARGETED_VERIFIER_NORMALIZER_VERSION, sourceProvenance: evidence.manifest?.sourceProvenance ?? {}, preVerification: metadata.preVerification });
  const eligibility = validateTargetedVerifierEligibility(context);
  if (!eligibility.valid) throw new Error(`VERIFIER_NOT_ELIGIBLE:${eligibility.reasons.join(",")}`);
  return context;
}
