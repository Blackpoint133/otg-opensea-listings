import type { DbPool } from "../db/types.js";
import { canonicalEvidence } from "./evidence/canonicalEvidence.js";
import { CurrentActiveListingsEvidenceSource, type ActiveListingsEvidenceV1 } from "./activeListingsEvidence.js";
import { type GenerationPublicationEvidenceV1, type GenerationPublicationScope, type GenerationPublicationStore } from "./generationPublication.js";
import { evaluateShadowDeactivation, type ShadowDecisionV2, type ShadowEvaluationResult } from "./shadowDeactivationEvaluator.js";
import { PostgresShadowDecisionStore, type ShadowDecisionPersistenceRecordV1, type ShadowDecisionStore } from "./shadowDecisionStore.js";
import { PostgresJournalFenceSnapshotReader, type JournalFenceSnapshotReader } from "./verifier/journalFenceSnapshotReader.js";
import { rehydrateOperationalAttemptRecord, type OperationalAttemptRecord } from "./verifier/targetedVerifierOperationalWorker.js";
import { PostgresLaterProviderEvidenceReader } from "./laterProviderEvidenceReader.js";
import { validateCanonicalIdentity, SUPPORTED_CHAIN, SUPPORTED_COLLECTION_SLUG, SUPPORTED_CONTRACT_ADDRESS } from "./identityScope.js";

export type ShadowProductionOutcome = "PERSISTED" | "EVALUATED" | "UNPROVEN" | "SOURCE_CHANGED_DURING_EVALUATION" | "NOT_A_SHADOW_CANDIDATE";
export interface ShadowProductionRunResult { readonly outcome: ShadowProductionOutcome; readonly decision: ShadowDecisionV2 | null; readonly persistence?: ShadowDecisionPersistenceRecordV1; readonly reasonCodes?: readonly string[]; readonly stage?: string; }
export interface ShadowProductionBatchResult { readonly results: readonly ShadowProductionRunResult[]; readonly evaluated: number; readonly persisted: number; readonly shadowEligible: number; readonly shadowIneligible: number; readonly blockedByLaterEvidence: number; readonly superseded: number; readonly reconciliationRequired: number; readonly unproven: number; readonly changedDuringEvaluation: number; }
export interface DurableAttemptReader { get(attemptId: string): Promise<OperationalAttemptRecord | null>; listCandidates(limit: number): Promise<readonly OperationalAttemptRecord[]>; }
export interface LaterProviderEvidenceReader { read(candidate: OperationalAttemptRecord, current: GenerationPublicationEvidenceV1): Promise<{ readonly outcome: "COMPLETE"; readonly snapshot: unknown } | { readonly outcome: "UNPROVEN"; readonly reasonCodes: readonly string[] }>; }

const attemptColumns = "attempt_id,payload";
const narrowCandidate = (attempt: OperationalAttemptRecord): boolean => attempt.lifecycle === "COMPLETE" && attempt.providerResultStatus === "INACTIVE_CONFIRMED" && attempt.finalResultStatus === "INACTIVE_CONFIRMED" && attempt.failureClassification === null && attempt.retry.retryable === false && attempt.semanticEvidenceHash !== null && attempt.authorityGranted === false && attempt.deactivationAuthorityGranted === false;
function scopeFor(attempt: OperationalAttemptRecord): GenerationPublicationScope { return { chain: SUPPORTED_CHAIN, collectionSlug: SUPPORTED_COLLECTION_SLUG, contractAddress: SUPPORTED_CONTRACT_ADDRESS, protocolAddress: attempt.expectedIdentity.protocolAddress }; }

export class PostgresDurableAttemptReader implements DurableAttemptReader {
  constructor(private readonly pool: DbPool) {}
  async get(attemptId: string): Promise<OperationalAttemptRecord | null> { const result = await this.pool.query<{ attempt_id: unknown; payload: unknown }>(`SELECT ${attemptColumns} FROM public.targeted_verifier_attempts WHERE attempt_id=$1`, [attemptId]); const row = result.rows[0]; if (!row) return null; const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload; const attempt = rehydrateOperationalAttemptRecord(payload); if (row.attempt_id !== attempt.attemptId) throw new Error("SHADOW_SOURCE_ATTEMPT_MISMATCH"); return attempt; }
  async listCandidates(limit: number): Promise<readonly OperationalAttemptRecord[]> { if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("INVALID_SHADOW_LIMIT"); const result = await this.pool.query<{ attempt_id: unknown; payload: unknown }>("SELECT attempt_id,payload FROM public.targeted_verifier_attempts WHERE lifecycle='COMPLETE' ORDER BY created_at ASC,attempt_id ASC LIMIT $1", [limit]); return result.rows.map((row) => { const attempt = rehydrateOperationalAttemptRecord(typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload); if (row.attempt_id !== attempt.attemptId) throw new Error("SHADOW_SOURCE_ATTEMPT_MISMATCH"); return attempt; }).filter(narrowCandidate); }
}

export interface ShadowProductionOrchestratorDependencies { readonly pool: DbPool; readonly attemptReader?: DurableAttemptReader; readonly generationStore: GenerationPublicationStore; readonly activeSource: CurrentActiveListingsEvidenceSource; readonly journalReader: JournalFenceSnapshotReader; readonly laterReader: LaterProviderEvidenceReader; readonly decisionStore: ShadowDecisionStore; }
export class ShadowProductionOrchestrator {
  private readonly attempts: DurableAttemptReader;
  constructor(private readonly dependencies: ShadowProductionOrchestratorDependencies) { this.attempts = dependencies.attemptReader ?? new PostgresDurableAttemptReader(dependencies.pool); }
  private async acquire(attempt: OperationalAttemptRecord): Promise<ShadowProductionRunResult> {
    let current: Awaited<ReturnType<GenerationPublicationStore["getCurrentAcceptedGeneration"]>>;
    try { current = await this.dependencies.generationStore.getCurrentAcceptedGeneration(scopeFor(attempt)); } catch { return { outcome: "UNPROVEN", decision: null, stage: "CURRENT_GENERATION", reasonCodes: ["CURRENT_GENERATION_UNPROVEN"] }; }
    if (current.outcome !== "CURRENT") return { outcome: "UNPROVEN", decision: null, stage: "CURRENT_GENERATION", reasonCodes: [current.outcome] };
    let active; try { active = await this.dependencies.activeSource.resolve(attempt.expectedIdentity); } catch { return { outcome: "UNPROVEN", decision: null, stage: "ACTIVE_EVIDENCE", reasonCodes: ["ACTIVE_EVIDENCE_SOURCE_UNAVAILABLE"] }; }
    if (active.outcome !== "CURRENT_ACTIVE_EVIDENCE") return { outcome: "UNPROVEN", decision: null, stage: "ACTIVE_EVIDENCE", reasonCodes: active.reasonCodes };
    if (active.evidence.publicationId !== current.publication.generationPublicationId || active.evidence.publicationSequence !== current.publication.publicationSequence || canonicalEvidence(active.evidence.sourceScope) !== canonicalEvidence(current.publication.scope)) return { outcome: "SOURCE_CHANGED_DURING_EVALUATION", decision: null, stage: "ACTIVE_EVIDENCE", reasonCodes: ["ACTIVE_EVIDENCE_PUBLICATION_MISMATCH"] };
    let journal; try { journal = await this.dependencies.journalReader.readSnapshot({ orderHash: attempt.orderHash, chain: attempt.expectedIdentity.chain, contractAddress: attempt.expectedIdentity.contractAddress, tokenId: attempt.expectedIdentity.tokenId }); } catch { return { outcome: "UNPROVEN", decision: null, stage: "CURRENT_JOURNAL", reasonCodes: ["INVALID_CURRENT_JOURNAL"] }; }
    const later = await this.dependencies.laterReader.read(attempt, current.publication); if (later.outcome !== "COMPLETE") return { outcome: "UNPROVEN", decision: null, stage: "LATER_PROVIDER_EVIDENCE", reasonCodes: later.reasonCodes };
    const evaluated = evaluateShadowDeactivation({ candidateAttempt: attempt, currentGeneration: current.publication, activeEvidence: active.evidence, currentJournal: journal, laterProviderEvidence: later.snapshot });
    return "outcome" in evaluated ? { outcome: "UNPROVEN", decision: null, stage: "EVALUATOR", reasonCodes: evaluated.reasonCodes } : { outcome: "EVALUATED", decision: evaluated };
  }
  async runAttempt(attemptId: string, options: { readonly persist?: boolean } = {}): Promise<ShadowProductionRunResult> {
    let attempt: OperationalAttemptRecord | null; try { attempt = await this.attempts.get(attemptId); } catch { throw new Error("SHADOW_SOURCE_ATTEMPT_MISMATCH"); }
    if (!attempt) return { outcome: "UNPROVEN", decision: null, stage: "CANDIDATE", reasonCodes: ["SHADOW_SOURCE_ATTEMPT_MISMATCH"] };
    if (!narrowCandidate(attempt)) return { outcome: "NOT_A_SHADOW_CANDIDATE", decision: null };
    const first = await this.acquire(attempt); if (first.outcome !== "EVALUATED" || !first.decision) return first;
    const second = await this.acquire(attempt); if (second.outcome !== "EVALUATED" || !second.decision) return second.outcome === "UNPROVEN" ? second : { outcome: "SOURCE_CHANGED_DURING_EVALUATION", decision: null, stage: "STABILITY_RECHECK", reasonCodes: second.reasonCodes };
    if (first.decision.shadowDecisionId !== second.decision.shadowDecisionId) return { outcome: "SOURCE_CHANGED_DURING_EVALUATION", decision: null, stage: "STABILITY_RECHECK", reasonCodes: ["SOURCE_CHANGED_DURING_EVALUATION"] };
    if (options.persist !== true) return { outcome: "EVALUATED", decision: second.decision };
    const persistence = await this.dependencies.decisionStore.append(second.decision); return { outcome: "PERSISTED", decision: second.decision, persistence };
  }
  async runBatch(input: { readonly limit: number; readonly persist?: boolean }): Promise<ShadowProductionBatchResult> { const attempts = await this.attempts.listCandidates(input.limit); const results: ShadowProductionRunResult[] = []; for (const attempt of attempts) results.push(await this.runAttempt(attempt.attemptId, { persist: input.persist })); const decisions = results.flatMap((result) => result.decision ? [result.decision] : []); return { results, evaluated: results.filter(r => r.outcome === "EVALUATED" || r.outcome === "PERSISTED").length, persisted: results.filter(r => r.outcome === "PERSISTED").length, shadowEligible: decisions.filter(d => d.state === "SHADOW_ELIGIBLE").length, shadowIneligible: decisions.filter(d => d.state === "SHADOW_INELIGIBLE").length, blockedByLaterEvidence: decisions.filter(d => d.state === "BLOCKED_BY_LATER_EVIDENCE").length, superseded: decisions.filter(d => d.state === "SUPERSEDED").length, reconciliationRequired: decisions.filter(d => d.state === "RECONCILIATION_REQUIRED").length, unproven: results.filter(r => r.outcome === "UNPROVEN").length, changedDuringEvaluation: results.filter(r => r.outcome === "SOURCE_CHANGED_DURING_EVALUATION").length }; }
}

export function createDefaultShadowProductionOrchestrator(pool: DbPool, dependencies: Omit<ShadowProductionOrchestratorDependencies, "pool" | "attemptReader" | "journalReader" | "laterReader" | "decisionStore"> & Partial<Pick<ShadowProductionOrchestratorDependencies, "attemptReader" | "journalReader" | "laterReader" | "decisionStore">>): ShadowProductionOrchestrator {
  const journalReader = dependencies.journalReader ?? new PostgresJournalFenceSnapshotReader(pool);
  const laterReader = dependencies.laterReader ?? new PostgresLaterProviderEvidenceReader(pool);
  const decisionStore = dependencies.decisionStore ?? new PostgresShadowDecisionStore(pool);
  return new ShadowProductionOrchestrator({ ...dependencies, pool, journalReader, laterReader, decisionStore });
}
