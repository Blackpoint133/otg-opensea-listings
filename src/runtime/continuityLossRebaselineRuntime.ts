import type { DbPool } from "../db/types.js";
import { ProductionIngestionRuntime } from "./productionIngestionRuntime.js";
import type { ExternalIngestionLease, BootstrapLeaseProbe } from "./initialGenerationBootstrapRuntime.js";
import { createRecoveryEntryAnchor, createContinuityLossRebaselinePlan, isTrustedRecoveryEntryAnchor, isTrustedContinuityLossRebaselinePlan, PostgresContinuityLossBaselineAdoptionStore, type RecoveryEntryAnchor, type RecoveryEntryAnchorInput, type ContinuityLossRebaselinePlanV2 } from "../reconciliation/continuityLossRebaseline.js";
import type { InitialGenerationBaselineProjection } from "../reconciliation/initialGenerationBaseline.js";
import type { IntegratedEvidenceResult } from "../reconciliation/evidence/reconciliationEvidenceIntegration.js";
import type { GenerationPublicationEvidenceV1 } from "../reconciliation/generationPublication.js";
import { deepFreeze } from "../reconciliation/evidence/canonicalEvidence.js";
import { verifyContinuityLossRebaselineDurable } from "../reconciliation/continuityLossRebaselineVerifier.js";

export type ContinuityLossRebaselineStatus = "VERIFIED_REBASELINED_ADOPTED" | "PUBLISHED_NOT_ADOPTED" | "ADOPTED_WITH_POSTCONDITION_FAILURE" | "PRECONDITION_FAILED" | "STREAM_EPOCH_LOST";
export interface ContinuityLossRebaselineResult { readonly status: ContinuityLossRebaselineStatus; readonly publicationId?: string; readonly adoptionId?: string; readonly publicationCommitted: boolean; readonly adoptionCommitted: boolean; readonly postAdoptionVerified: boolean; readonly ingestionContinuityMaintained: boolean; readonly reason?: string; }
export interface RebaselineGenerationOutput { readonly evidence: unknown; readonly projection: InitialGenerationBaselineProjection; readonly integratedEvidence: IntegratedEvidenceResult; readonly publication: GenerationPublicationEvidenceV1; }
export interface ContinuityLossRebaselineDependencies {
  readonly pool: DbPool;
  readonly apiKey: string;
  readonly supersededPublicationId: string;
  readonly supersededSweepId: string;
  readonly evidenceRoot: string;
  readonly captureAnchor: () => Promise<RecoveryEntryAnchor>;
  readonly runtimeFactory?: (apiKey: string) => ProductionIngestionRuntime;
  readonly leaseProbe: BootstrapLeaseProbe;
  readonly waitUntilReady?: (runtime: ProductionIngestionRuntime) => Promise<void>;
  readonly generation: (initialLease?: ExternalIngestionLease) => Promise<RebaselineGenerationOutput>;
  readonly planFactory?: typeof createContinuityLossRebaselinePlan;
  readonly adoptionStore?: Pick<PostgresContinuityLossBaselineAdoptionStore, "adopt">;
  readonly verify?: (plan: ContinuityLossRebaselinePlanV2, publication: GenerationPublicationEvidenceV1) => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitForTermination?: (runtime: ProductionIngestionRuntime) => Promise<unknown>;
}

function safeReason(error: unknown): string { return (error instanceof Error ? error.message : "CONTINUITY_LOSS_REBASELINE_FAILED").replace(/(password|secret|api[_-]?key|authorization|token|connection string)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 240); }
function sameLease(a: ExternalIngestionLease, b: ExternalIngestionLease): boolean { return a.pid === b.pid && a.backendStart === b.backendStart && a.applicationName === b.applicationName && a.database === b.database; }

export async function runContinuityLossRebaseline(deps: ContinuityLossRebaselineDependencies): Promise<ContinuityLossRebaselineResult> {
  let anchor: RecoveryEntryAnchor;
  try { anchor = await deps.captureAnchor(); if (!isTrustedRecoveryEntryAnchor(anchor)) throw new Error("CONTINUITY_LOSS_RECOVERY_ANCHOR_UNTRUSTED"); if (anchor.supersededPublicationId !== deps.supersededPublicationId || anchor.supersededSweepId !== deps.supersededSweepId || anchor.supersededPublicationSequence < 0) throw new Error("CONTINUITY_LOSS_RECOVERY_ANCHOR_BINDING_MISMATCH"); } catch (error) { return { status: "PRECONDITION_FAILED", publicationCommitted: false, adoptionCommitted: false, postAdoptionVerified: false, ingestionContinuityMaintained: false, reason: safeReason(error) }; }
  let runtime: ProductionIngestionRuntime; let initialLease: ExternalIngestionLease;
  try { runtime = (deps.runtimeFactory ?? ((apiKey) => new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey })))(deps.apiKey); await runtime.start(); await (deps.waitUntilReady?.(runtime) ?? Promise.resolve()); initialLease = await deps.leaseProbe() as ExternalIngestionLease; if (!initialLease) throw new Error("PRODUCTION_INGESTION_LEASE_UNPROVEN"); } catch (error) { return { status: "STREAM_EPOCH_LOST", publicationCommitted: false, adoptionCommitted: false, postAdoptionVerified: false, ingestionContinuityMaintained: false, reason: safeReason(error) }; }
  let generated: RebaselineGenerationOutput;
  try { generated = await deps.generation(initialLease); } catch (error) { return { status: "PRECONDITION_FAILED", publicationCommitted: false, adoptionCommitted: false, postAdoptionVerified: false, ingestionContinuityMaintained: false, reason: safeReason(error) }; }
  let plan: ContinuityLossRebaselinePlanV2;
  try { plan = (deps.planFactory ?? createContinuityLossRebaselinePlan)({ evidence: generated.evidence, projection: generated.projection, integratedEvidence: generated.integratedEvidence, publication: generated.publication, supersededPublicationId: deps.supersededPublicationId, supersededPublicationSequence: anchor.supersededPublicationSequence, supersededSweepId: deps.supersededSweepId, recoveryEntryAnchor: anchor }); if (!isTrustedContinuityLossRebaselinePlan(plan)) throw new Error("CONTINUITY_LOSS_REBASELINE_PLAN_UNTRUSTED"); const current = await deps.leaseProbe(); if (!current || !sameLease(initialLease, current)) throw new Error("STREAM_EPOCH_LOST_BEFORE_ADOPTION"); } catch (error) { return { status: "STREAM_EPOCH_LOST", publicationId: generated.publication.generationPublicationId, publicationCommitted: true, adoptionCommitted: false, postAdoptionVerified: false, ingestionContinuityMaintained: false, reason: safeReason(error) }; }
  let adoption: { outcome: "ADOPTED"|"ALREADY_ADOPTED"; adoptionId: string; adoptedOrderCount: number };
  try { adoption = await (deps.adoptionStore ?? new PostgresContinuityLossBaselineAdoptionStore(deps.pool)).adopt(plan); } catch (error) { return { status: "PUBLISHED_NOT_ADOPTED", publicationId: generated.publication.generationPublicationId, publicationCommitted: true, adoptionCommitted: false, postAdoptionVerified: false, ingestionContinuityMaintained: false, reason: safeReason(error) }; }
  let verified = false; let continuity = false; let reason: string | undefined;
  try {
    const verifier = deps.verify ?? ((p, pub) => verifyContinuityLossRebaselineDurable(deps.pool, p, pub, deps.supersededPublicationId, deps.supersededSweepId, deps.leaseProbe, initialLease));
    verified = await verifier(plan, generated.publication);
    if (!verified) reason = "POST_ADOPTION_DURABLE_VERIFICATION_FAILED";
  } catch { reason = "POST_ADOPTION_DURABLE_VERIFICATION_FAILED"; }
  try { const current = await deps.leaseProbe(); if (!current || !sameLease(initialLease, current)) throw new Error("POST_ADOPTION_INGESTION_CONTINUITY_LOST"); continuity = true; } catch { reason = reason ? `${reason};POST_ADOPTION_INGESTION_CONTINUITY_LOST` : "POST_ADOPTION_INGESTION_CONTINUITY_LOST"; }
  if (!verified || !continuity) return { status: "ADOPTED_WITH_POSTCONDITION_FAILURE", publicationId: generated.publication.generationPublicationId, adoptionId: adoption.adoptionId, publicationCommitted: true, adoptionCommitted: true, postAdoptionVerified: verified, ingestionContinuityMaintained: continuity, reason };
  if (deps.waitForTermination) {
    try { const termination: any = await deps.waitForTermination(runtime); if (termination?.fatal) return { status: "STREAM_EPOCH_LOST", publicationId: generated.publication.generationPublicationId, adoptionId: adoption.adoptionId, publicationCommitted: true, adoptionCommitted: true, postAdoptionVerified: true, ingestionContinuityMaintained: false, reason: safeReason(termination.fatalDiagnostic ?? "STREAM_EPOCH_LOST_AFTER_ADOPTION") }; }
    catch (error) { return { status: "STREAM_EPOCH_LOST", publicationId: generated.publication.generationPublicationId, adoptionId: adoption.adoptionId, publicationCommitted: true, adoptionCommitted: true, postAdoptionVerified: true, ingestionContinuityMaintained: false, reason: safeReason(error) }; }
  }
  return { status: "VERIFIED_REBASELINED_ADOPTED", publicationId: generated.publication.generationPublicationId, adoptionId: adoption.adoptionId, publicationCommitted: true, adoptionCommitted: true, postAdoptionVerified: true, ingestionContinuityMaintained: true };
}

/** Named orchestration boundary used by the future operator CLI. Keeping this
 * as a thin dependency-injected wrapper makes the ordering (anchor, runtime,
 * READY/lease, generation, adoption, postconditions) directly testable without
 * importing a production pool or opening a network transport. */
export const orchestrateContinuityLossRebaseline = runContinuityLossRebaseline;

export function createContinuityLossRecoveryAnchor(input: RecoveryEntryAnchorInput): RecoveryEntryAnchor { return createRecoveryEntryAnchor(input); }
