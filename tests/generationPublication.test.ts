import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import { canonicalEvidence, sha256Canonical } from "../src/reconciliation/evidence/canonicalEvidence.js";
import { GENERATION_PUBLICATION_SCHEMA_VERSION, generationCommitmentMaterial, generationPublicationMaterial, PostgresGenerationPublicationStore, validateGenerationPublicationEvidence, type GenerationPublicationEvidenceV1, type GenerationPublicationScope } from "../src/reconciliation/generationPublication.js";
import { OFFLINE_CANDIDATE_MODEL_VERSION } from "../src/reconciliation/offlineCandidateModel.js";
import { OFFLINE_GENERATION_MODEL_VERSION } from "../src/reconciliation/offlineGenerationBarrierModel.js";
import { OPENSEA_ORDER_CONTRACT_VERSION, TARGETED_VERIFIER_NORMALIZER_VERSION, TARGETED_VERIFIER_POLICY_VERSION, TARGETED_VERIFIER_SCHEMA_VERSION } from "../src/reconciliation/verifier/targetedVerifierTypes.js";

const scope: GenerationPublicationScope = { chain: "gunzilla", collectionSlug: "off-the-grid", contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", protocolAddress: "0x0000000000000000000000000000000000000001" };
const sourceProvenance = Object.freeze({ adapter: "a".repeat(64) });
function publication(sequence: number, suffix = "a"): GenerationPublicationEvidenceV1 {
  const provenance = Object.freeze({ adapter: "a".repeat(63) + suffix });
  const base = { schemaVersion: GENERATION_PUBLICATION_SCHEMA_VERSION, publicationSequence: sequence, publicationState: "ACCEPTED" as const, scope, sweepId: "sweep-1", generationRootHash: "1".repeat(64), candidateArtifactHash: "2".repeat(64), barrierArtifactHash: "3".repeat(64), candidateModelVersion: OFFLINE_CANDIDATE_MODEL_VERSION, generationModelVersion: OFFLINE_GENERATION_MODEL_VERSION, verifierSchemaVersion: TARGETED_VERIFIER_SCHEMA_VERSION, verifierPolicyVersion: TARGETED_VERIFIER_POLICY_VERSION, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, normalizerVersion: TARGETED_VERIFIER_NORMALIZER_VERSION, sourceEvidenceHash: sha256Canonical({ manifest: "1".repeat(64), candidate: "2".repeat(64), barrier: "3".repeat(64), provenance }), sourceArtifactIdentity: { manifestRootContentHash: "1".repeat(64), candidateArtifactHash: "2".repeat(64), barrierArtifactHash: "3".repeat(64), sourceProvenance: provenance }, createdAt: "2026-09-13T00:00:00.000Z" };
  const generationCommitmentId = sha256Canonical(generationCommitmentMaterial(base));
  const generationPublicationId = sha256Canonical(generationPublicationMaterial({ ...base, generationCommitmentId }));
  return { ...base, generationCommitmentId, generationPublicationId };
}
type Row = { payload: unknown; publicationSequence: number; publicationState: string; scope: GenerationPublicationScope };
class PublicationDb implements DbPool {
  rows: Row[] = []; sequence = 0; sql: string[] = [];
  async end() {}
  async connect(): Promise<TransactionClient> { return { release() {}, query: (q, v) => this.query(q, v) }; }
  async query<T = unknown>(q: string, values?: readonly unknown[]): Promise<QueryResult<T>> { this.sql.push(q); const l = q.toLowerCase(); if (l.startsWith("select payload") && l.includes("publication_state='accepted'")) return { rows: this.rows.filter((r) => r.publicationState === "ACCEPTED" && r.scope.chain === values?.[0] && r.scope.collectionSlug === values?.[1] && r.scope.contractAddress === values?.[2]).sort((a, b) => b.publicationSequence - a.publicationSequence).map((r) => ({ payload: r.payload }) as T), rowCount: this.rows.length }; if (l.startsWith("select payload")) return { rows: this.rows.slice(0, 1).map((r) => ({ payload: r.payload }) as T), rowCount: this.rows.length }; return { rows: [], rowCount: 0 }; }
}
test("GenerationPublicationEvidenceV1 exact validation and identities", () => {
  const value = publication(7);
  assert.equal(Object.isFrozen(value), false);
  assert.equal(validateGenerationPublicationEvidence(value), true);
  assert.equal(value.generationCommitmentId, sha256Canonical(generationCommitmentMaterial(value)));
  assert.equal(value.generationPublicationId, sha256Canonical(generationPublicationMaterial(value)));
  assert.equal(canonicalEvidence(value.scope), canonicalEvidence(scope));
  assert.equal(value.publicationSequence, 7);
});
test("raw publication tampering fails closed", () => {
  const value = publication(2);
  const cases: unknown[] = [
    { ...value, publicationSequence: -1 },
    { ...value, publicationSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...value, publicationState: "UNKNOWN" },
    { ...value, scope: { ...scope, chain: "ethereum" } },
    { ...value, scope: { ...scope, collectionSlug: "foreign" } },
    { ...value, scope: { ...scope, contractAddress: "0x" + "f".repeat(40) } },
    { ...value, candidateModelVersion: "future" },
    { ...value, sourceArtifactIdentity: { ...value.sourceArtifactIdentity, sourceEvidenceHash: "x" } },
    { ...value, extra: true }
  ];
  for (const item of cases) assert.equal(validateGenerationPublicationEvidence(item), false);
});
test("current accepted generation selects unique greatest sequence and fails on conflicts", async () => {
  const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db); const first = publication(1); const second = publication(2, "b");
  db.rows.push({ payload: first, publicationSequence: 1, publicationState: "ACCEPTED", scope }); db.rows.push({ payload: second, publicationSequence: 2, publicationState: "ACCEPTED", scope });
  const current = await store.getCurrentAcceptedGeneration(scope); assert.equal(current.outcome, "CURRENT"); if (current.outcome === "CURRENT") assert.equal(current.publication.generationPublicationId, second.generationPublicationId);
  db.rows.push({ payload: publication(2, "c"), publicationSequence: 2, publicationState: "ACCEPTED", scope });
  const conflict = await store.getCurrentAcceptedGeneration(scope); assert.equal(conflict.outcome, "CURRENT_GENERATION_CONFLICT");
});
test("empty and corrupted publication rows fail closed", async () => {
  const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db); const result = await store.getCurrentAcceptedGeneration(scope); assert.equal(result.outcome, "CURRENT_GENERATION_UNPROVEN");
  db.rows.push({ payload: { bad: true }, publicationSequence: 9, publicationState: "ACCEPTED", scope }); const corrupted = await store.getCurrentAcceptedGeneration(scope); assert.equal(corrupted.outcome, "CURRENT_GENERATION_UNPROVEN");
});
test("untrusted caller cannot create a publication", async () => {
  const store = new PostgresGenerationPublicationStore(new PublicationDb()); const source = { integratedEvidence: { status: "VALID", manifest: null, candidate: null, barrier: null, candidateRef: null, barrierRef: null, reasons: [], authorityGranted: false, deactivationAuthorityGranted: false } as never, protocolAddress: scope.protocolAddress, createdAt: "2026-09-13T00:00:00.000Z" };
  await assert.rejects(store.publish(source), /INVALID_ACCEPTED_GENERATION_EVIDENCE/);
});
test("migration and allocator contract are transactional and monotonic", () => {
  const sql = fs.readFileSync(new URL("../sql/007_create_generation_publications.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.targeted_verifier_generation_publication_sequence/);
  assert.match(sql, /publication_sequence bigint NOT NULL CHECK \(publication_sequence >= 0\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.targeted_verifier_generation_publications/);
  assert.match(sql, /UNIQUE \(generation_commitment_id, source_evidence_hash, publication_state\)/);
  const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db);
  assert.equal(typeof store.getCurrentAcceptedGeneration, "function");
});
