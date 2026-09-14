import type { DbPool, TransactionClient } from "../db/types.js";
import { canonicalEvidence, deepFreeze } from "./evidence/canonicalEvidence.js";
import { decodeGenerationPublicationRow, type GenerationPublicationDbRow, type GenerationPublicationEvidenceV1 } from "./generationPublication.js";
import { rehydrateOperationalAttemptRecord, type OperationalAttemptRecord } from "./verifier/targetedVerifierOperationalWorker.js";
import { validateShadowDecision, type ShadowDecisionV2 } from "./shadowDeactivationEvaluator.js";

export interface ShadowDecisionPersistenceRecordV1 { readonly shadowDecisionId: string; readonly persistSequence: number; readonly previousDecisionId: string | null; readonly persistedAt: string; readonly decision: ShadowDecisionV2; }
export interface ShadowDecisionStore { append(decision: ShadowDecisionV2): Promise<ShadowDecisionPersistenceRecordV1>; get(shadowDecisionId: string): Promise<ShadowDecisionPersistenceRecordV1 | null>; listForAttempt(attemptId: string): Promise<readonly ShadowDecisionPersistenceRecordV1[]>; }
export interface ShadowDecisionDbRow { readonly shadow_decision_id: unknown; readonly persist_sequence: unknown; readonly shadow_evaluation_id: unknown; readonly shadow_evidence_hash: unknown; readonly attempt_id: unknown; readonly order_hash: unknown; readonly generation_publication_id: unknown; readonly generation_commitment_id: unknown; readonly active_evidence_id: unknown; readonly state: unknown; readonly previous_decision_id: unknown; readonly payload: unknown; readonly persisted_at: unknown; }
const rowKeys = ["shadow_decision_id", "persist_sequence", "shadow_evaluation_id", "shadow_evidence_hash", "attempt_id", "order_hash", "generation_publication_id", "generation_commitment_id", "active_evidence_id", "state", "previous_decision_id", "payload", "persisted_at"] as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const instant = (value: unknown): string | null => { const date = value instanceof Date ? value : typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toISOString() : null; };
const sequence = (value: unknown): number | null => { if (typeof value === "bigint") return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null; if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null; if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null; } return null; };
const parsePayload = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) as unknown : value;
export function validateImmediatePredecessor(current: ShadowDecisionPersistenceRecordV1, predecessor: ShadowDecisionPersistenceRecordV1 | null): void { if (current.previousDecisionId === current.shadowDecisionId) throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION"); if (current.previousDecisionId === null) { if (predecessor !== null && predecessor.persistSequence < current.persistSequence) throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION"); return; } if (!predecessor || predecessor.shadowDecisionId !== current.previousDecisionId || predecessor.decision.attemptId !== current.decision.attemptId || predecessor.decision.orderHash !== current.decision.orderHash || predecessor.persistSequence >= current.persistSequence) throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION"); }

export function decodeShadowDecisionRow(input: unknown): ShadowDecisionPersistenceRecordV1 {
  try {
    if (!record(input) || Object.keys(input).length !== rowKeys.length || Object.keys(input).some((key) => !rowKeys.includes(key as typeof rowKeys[number]))) throw new Error();
    const payload = parsePayload(input.payload);
    if (!validateShadowDecision(payload)) throw new Error();
    const decision = payload as ShadowDecisionV2;
    const persistSequence = sequence(input.persist_sequence);
    const persistedAt = instant(input.persisted_at);
    const previous = input.previous_decision_id;
    if (persistSequence === null || persistedAt === null || (previous !== null && !hash(previous)) || input.shadow_decision_id !== decision.shadowDecisionId || input.shadow_evaluation_id !== decision.shadowEvaluationId || input.shadow_evidence_hash !== decision.shadowEvidenceHash || input.attempt_id !== decision.attemptId || input.order_hash !== decision.orderHash || input.generation_publication_id !== decision.generationPublicationId || input.generation_commitment_id !== decision.generationCommitmentId || input.active_evidence_id !== decision.activeEvidenceId || input.state !== decision.state) throw new Error();
    return deepFreeze({ shadowDecisionId: decision.shadowDecisionId, persistSequence, previousDecisionId: previous as string | null, persistedAt, decision });
  } catch { throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION"); }
}

const selectColumns = "shadow_decision_id,persist_sequence,shadow_evaluation_id,shadow_evidence_hash,attempt_id,order_hash,generation_publication_id,generation_commitment_id,active_evidence_id,state,previous_decision_id,payload,persisted_at";
const generationColumns = "generation_publication_id,generation_commitment_id,publication_sequence,publication_state,sweep_id,generation_root_hash,candidate_artifact_hash,barrier_artifact_hash,candidate_model_version,generation_model_version,verifier_schema_version,verifier_policy_version,provider_contract_version,normalizer_version,scope,payload,source_evidence_hash,created_at";

function sourceMatches(attempt: OperationalAttemptRecord, decision: ShadowDecisionV2): boolean { const material = decision.evidenceMaterial; return attempt.attemptId === decision.attemptId && attempt.orderHash === decision.orderHash && attempt.attemptNumber === material.candidateAttempt.attemptNumber && attempt.semanticEvidenceHash === material.candidateAttempt.operationalSemanticEvidenceHash && canonicalEvidence(attempt.expectedIdentity) === canonicalEvidence(material.expectedIdentity) && canonicalEvidence(attempt.requestIdentity) === canonicalEvidence(material.requestIdentity); }
function generationMatches(generation: GenerationPublicationEvidenceV1, decision: ShadowDecisionV2): boolean { return generation.generationPublicationId === decision.generationPublicationId && canonicalEvidence(generation) === canonicalEvidence(decision.evidenceMaterial.currentGeneration); }

export class PostgresShadowDecisionStore implements ShadowDecisionStore {
  constructor(private readonly pool: DbPool) {}
  async append(decision: ShadowDecisionV2): Promise<ShadowDecisionPersistenceRecordV1> {
    if (!validateShadowDecision(decision) || decision.authorityGranted !== false || decision.deactivationAuthorityGranted !== false || decision.mutationAuthorityGranted !== false) throw new Error("INVALID_SHADOW_DECISION");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const attemptResult = await client.query<{ payload: unknown }>("SELECT payload FROM public.targeted_verifier_attempts WHERE attempt_id=$1 FOR UPDATE", [decision.attemptId]);
      const attemptPayload = attemptResult.rows[0]?.payload;
      let attempt: OperationalAttemptRecord;
      try { if (attemptPayload === undefined) throw new Error(); attempt = rehydrateOperationalAttemptRecord(typeof attemptPayload === "string" ? JSON.parse(attemptPayload) : attemptPayload); } catch { throw new Error("SHADOW_SOURCE_ATTEMPT_MISMATCH"); }
      if (!sourceMatches(attempt, decision)) throw new Error("SHADOW_SOURCE_ATTEMPT_MISMATCH");
      const generationResult = await client.query<GenerationPublicationDbRow>(`SELECT ${generationColumns} FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1`, [decision.generationPublicationId]);
      let generation: GenerationPublicationEvidenceV1;
      try { if (!generationResult.rows[0]) throw new Error(); generation = decodeGenerationPublicationRow(generationResult.rows[0]); } catch { throw new Error("SHADOW_SOURCE_GENERATION_MISMATCH"); }
      if (!generationMatches(generation, decision)) throw new Error("SHADOW_SOURCE_GENERATION_MISMATCH");
      const existingResult = await client.query<ShadowDecisionDbRow>(`SELECT ${selectColumns} FROM public.targeted_verifier_shadow_decisions WHERE shadow_decision_id=$1 FOR UPDATE`, [decision.shadowDecisionId]);
      if (existingResult.rows[0]) { const existing = decodeShadowDecisionRow(existingResult.rows[0]); const priorResult = await client.query<ShadowDecisionDbRow>(`SELECT ${selectColumns} FROM public.targeted_verifier_shadow_decisions WHERE attempt_id=$1 AND order_hash=$2 AND persist_sequence < $3 ORDER BY persist_sequence DESC LIMIT 1`, [decision.attemptId, decision.orderHash, existing.persistSequence]); const prior = priorResult.rows[0] ? decodeShadowDecisionRow(priorResult.rows[0]) : null; validateImmediatePredecessor(existing, prior); if (canonicalEvidence(existing.decision) !== canonicalEvidence(decision)) throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION"); await client.query("COMMIT"); return existing; }
      const priorResult = await client.query<ShadowDecisionDbRow>(`SELECT ${selectColumns} FROM public.targeted_verifier_shadow_decisions WHERE attempt_id=$1 AND order_hash=$2 ORDER BY persist_sequence DESC LIMIT 2`, [decision.attemptId, decision.orderHash]);
      let previousDecisionId: string | null = null;
      if (priorResult.rows[0]) { const prior = decodeShadowDecisionRow(priorResult.rows[0]); const older = priorResult.rows[1] ? decodeShadowDecisionRow(priorResult.rows[1]) : null; validateImmediatePredecessor(prior, older); if (prior.decision.attemptId !== decision.attemptId || prior.decision.orderHash !== decision.orderHash) throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION"); previousDecisionId = prior.shadowDecisionId; }
      const inserted = await client.query<ShadowDecisionDbRow>(`INSERT INTO public.targeted_verifier_shadow_decisions (shadow_decision_id,shadow_evaluation_id,shadow_evidence_hash,attempt_id,order_hash,generation_publication_id,generation_commitment_id,active_evidence_id,state,previous_decision_id,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING ${selectColumns}`, [decision.shadowDecisionId, decision.shadowEvaluationId, decision.shadowEvidenceHash, decision.attemptId, decision.orderHash, decision.generationPublicationId, decision.generationCommitmentId, decision.activeEvidenceId, decision.state, previousDecisionId, JSON.stringify(decision)]);
      if (!inserted.rows[0]) throw new Error("SHADOW_DECISION_INSERT_FAILED");
      const persisted = decodeShadowDecisionRow(inserted.rows[0]);
      if (persisted.previousDecisionId !== previousDecisionId) throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION");
      await client.query("COMMIT"); return persisted;
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); }
  }
  async get(shadowDecisionId: string): Promise<ShadowDecisionPersistenceRecordV1 | null> { const result = await this.pool.query<ShadowDecisionDbRow>(`SELECT ${selectColumns} FROM public.targeted_verifier_shadow_decisions WHERE shadow_decision_id=$1`, [shadowDecisionId]); if (!result.rows[0]) return null; const current = decodeShadowDecisionRow(result.rows[0]); const priorResult = await this.pool.query<ShadowDecisionDbRow>(`SELECT ${selectColumns} FROM public.targeted_verifier_shadow_decisions WHERE attempt_id=$1 AND order_hash=$2 AND persist_sequence < $3 ORDER BY persist_sequence DESC LIMIT 1`, [current.decision.attemptId, current.decision.orderHash, current.persistSequence]); validateImmediatePredecessor(current, priorResult.rows[0] ? decodeShadowDecisionRow(priorResult.rows[0]) : null); return current; }
  async listForAttempt(attemptId: string): Promise<readonly ShadowDecisionPersistenceRecordV1[]> { const result = await this.pool.query<ShadowDecisionDbRow>(`SELECT ${selectColumns} FROM public.targeted_verifier_shadow_decisions WHERE attempt_id=$1 ORDER BY persist_sequence ASC`, [attemptId]); const rows = result.rows.map(decodeShadowDecisionRow); for (let index = 0; index < rows.length; index += 1) { if (rows[index].decision.attemptId !== attemptId || (index > 0 && (rows[index].decision.orderHash !== rows[0].decision.orderHash || rows[index].persistSequence <= rows[index - 1].persistSequence || rows[index].previousDecisionId !== rows[index - 1].shadowDecisionId)) || (index === 0 && rows[index].previousDecisionId !== null)) throw new Error("SHADOW_DECISION_DURABLE_CORRUPTION"); } return rows; }
}
