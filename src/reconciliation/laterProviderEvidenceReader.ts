import type { DbPool } from "../db/types.js";
import { decodeGenerationPublicationRow, type GenerationPublicationDbRow, type GenerationPublicationEvidenceV1 } from "./generationPublication.js";
import { generationCommitmentMaterial } from "./generationPublication.js";
import { sha256Canonical } from "./evidence/canonicalEvidence.js";
import { rehydrateOperationalAttemptRecord, type OperationalAttemptRecord } from "./verifier/targetedVerifierOperationalWorker.js";
import { attemptGenerationProjection, type LaterProviderEvidenceSnapshotV1 } from "./shadowDeactivationEvaluator.js";
import { canonicalEvidence } from "./evidence/canonicalEvidence.js";

export type LaterProviderEvidenceReadResult =
  | { readonly outcome: "COMPLETE"; readonly snapshot: LaterProviderEvidenceSnapshotV1 }
  | { readonly outcome: "UNPROVEN"; readonly reasonCodes: readonly string[] };

const generationColumns = "generation_publication_id,generation_commitment_id,publication_sequence,publication_state,sweep_id,generation_root_hash,candidate_artifact_hash,barrier_artifact_hash,candidate_model_version,generation_model_version,verifier_schema_version,verifier_policy_version,provider_contract_version,normalizer_version,scope,payload,source_evidence_hash,created_at";

function commitment(attempt: OperationalAttemptRecord): string {
  return sha256Canonical(generationCommitmentMaterial(attemptGenerationProjection(attempt)));
}

export class PostgresLaterProviderEvidenceReader {
  constructor(private readonly pool: DbPool) {}

  async read(candidate: OperationalAttemptRecord, current: GenerationPublicationEvidenceV1): Promise<LaterProviderEvidenceReadResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const rows = await client.query<{ attempt_id: unknown; payload: unknown }>("SELECT attempt_id,payload FROM public.targeted_verifier_attempts WHERE order_hash=$1 AND attempt_id<>$2 ORDER BY created_at ASC,attempt_id ASC", [candidate.orderHash, candidate.attemptId]);
      const entries: Array<{ attempt: OperationalAttemptRecord; generationPublication: GenerationPublicationEvidenceV1 }> = [];
      for (const raw of rows.rows) {
        let attempt: OperationalAttemptRecord;
        try {
          attempt = rehydrateOperationalAttemptRecord(typeof raw.payload === "string" ? JSON.parse(raw.payload) : raw.payload);
          if (raw.attempt_id !== attempt.attemptId || canonicalEvidence(attempt.expectedIdentity) !== canonicalEvidence(candidate.expectedIdentity)) throw new Error("LATER_PROVIDER_EVIDENCE_INVALID");
        } catch {
          throw new Error("LATER_PROVIDER_EVIDENCE_INVALID");
        }
        if (attempt.providerResultStatus === null) continue;
        const laterCommitment = commitment(attempt);
        let publication: GenerationPublicationEvidenceV1 | null = null;
        if (laterCommitment === current.generationCommitmentId) publication = current;
        else {
          const publicationRows = await client.query<GenerationPublicationDbRow>(`SELECT ${generationColumns} FROM public.targeted_verifier_generation_publications WHERE generation_commitment_id=$1 AND publication_state='ACCEPTED'`, [laterCommitment]);
          const decoded: GenerationPublicationEvidenceV1[] = [];
          for (const row of publicationRows.rows) {
            try { const item = decodeGenerationPublicationRow(row); if (item.scope.chain === current.scope.chain && item.scope.collectionSlug === current.scope.collectionSlug && item.scope.contractAddress === current.scope.contractAddress && item.scope.protocolAddress === current.scope.protocolAddress) decoded.push(item); } catch { throw new Error("LATER_PROVIDER_GENERATION_UNPROVEN"); }
          }
          if (decoded.length === 0) throw new Error("LATER_PROVIDER_GENERATION_UNPROVEN");
          const higher = decoded.filter((item) => item.publicationSequence > current.publicationSequence);
          const lower = decoded.filter((item) => item.publicationSequence < current.publicationSequence);
          if (decoded.length === 1) publication = decoded[0];
          else if (higher.length === decoded.length) publication = [...higher].sort((a,b) => a.publicationSequence-b.publicationSequence)[0];
          else if (lower.length === decoded.length) publication = [...lower].sort((a,b) => b.publicationSequence-a.publicationSequence)[0];
          else throw new Error("LATER_PROVIDER_GENERATION_CONFLICT");
        }
        if (!publication || commitment(attempt) !== publication.generationCommitmentId) throw new Error("LATER_PROVIDER_GENERATION_UNPROVEN");
        entries.push({ attempt, generationPublication: publication });
      }
      const snapshot = { schemaVersion: "shadow-later-provider-evidence-v1" as const, orderHash: candidate.orderHash, complete: true as const, entries };
      await client.query("COMMIT");
      return { outcome: "COMPLETE", snapshot };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      return { outcome: "UNPROVEN", reasonCodes: [error instanceof Error ? error.message : "LATER_PROVIDER_EVIDENCE_INVALID"] };
    } finally { client.release(); }
  }
}
