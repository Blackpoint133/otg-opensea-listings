import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import { canonicalEvidence, sha256Canonical } from "../src/reconciliation/evidence/canonicalEvidence.js";
import { createGenerationPublicationEvidence, decodeGenerationPublicationRow, GENERATION_PUBLICATION_SCHEMA_VERSION, generationCommitmentMaterial, generationPublicationMaterial, PostgresGenerationPublicationStore, provenCandidateProtocolAddresses, validateGenerationPublicationEvidence, type GenerationPublicationEvidenceV1, type GenerationPublicationScope } from "../src/reconciliation/generationPublication.js";
import { OFFLINE_CANDIDATE_MODEL_VERSION } from "../src/reconciliation/offlineCandidateModel.js";
import { OFFLINE_GENERATION_MODEL_VERSION } from "../src/reconciliation/offlineGenerationBarrierModel.js";
import { OPENSEA_ORDER_CONTRACT_VERSION, TARGETED_VERIFIER_NORMALIZER_VERSION, TARGETED_VERIFIER_POLICY_VERSION, TARGETED_VERIFIER_SCHEMA_VERSION } from "../src/reconciliation/verifier/targetedVerifierTypes.js";
import { disposeTrustedContexts, makeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const scope: GenerationPublicationScope = { chain: "gunzilla", collectionSlug: "off-the-grid", contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", protocolAddress: "0x0000000000000000000000000000000000000001" };
const sourceProvenance = Object.freeze({ adapter: "a".repeat(64) });
function publication(sequence: number, suffix = "a", publicationScope = scope): GenerationPublicationEvidenceV1 {
  const provenance = Object.freeze({ adapter: "a".repeat(63) + suffix });
  const base = { schemaVersion: GENERATION_PUBLICATION_SCHEMA_VERSION, publicationSequence: sequence, publicationState: "ACCEPTED" as const, scope: publicationScope, sweepId: "sweep-1", generationRootHash: "1".repeat(64), candidateArtifactHash: "2".repeat(64), barrierArtifactHash: "3".repeat(64), candidateModelVersion: OFFLINE_CANDIDATE_MODEL_VERSION, generationModelVersion: OFFLINE_GENERATION_MODEL_VERSION, verifierSchemaVersion: TARGETED_VERIFIER_SCHEMA_VERSION, verifierPolicyVersion: TARGETED_VERIFIER_POLICY_VERSION, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, normalizerVersion: TARGETED_VERIFIER_NORMALIZER_VERSION, sourceEvidenceHash: sha256Canonical({ manifest: "1".repeat(64), candidate: "2".repeat(64), barrier: "3".repeat(64), provenance }), sourceArtifactIdentity: { manifestRootContentHash: "1".repeat(64), candidateArtifactHash: "2".repeat(64), barrierArtifactHash: "3".repeat(64), sourceProvenance: provenance }, createdAt: "2026-09-13T00:00:00.000Z" };
  const generationCommitmentId = sha256Canonical(generationCommitmentMaterial(base));
  const generationPublicationId = sha256Canonical(generationPublicationMaterial({ ...base, generationCommitmentId }));
  return { ...base, generationCommitmentId, generationPublicationId };
}
type Row = Record<string, unknown>;
function rowFrom(payload: GenerationPublicationEvidenceV1): Row { return { generation_publication_id: payload.generationPublicationId, generation_commitment_id: payload.generationCommitmentId, publication_sequence: payload.publicationSequence, publication_state: payload.publicationState, sweep_id: payload.sweepId, generation_root_hash: payload.generationRootHash, candidate_artifact_hash: payload.candidateArtifactHash, barrier_artifact_hash: payload.barrierArtifactHash, candidate_model_version: payload.candidateModelVersion, generation_model_version: payload.generationModelVersion, verifier_schema_version: payload.verifierSchemaVersion, verifier_policy_version: payload.verifierPolicyVersion, provider_contract_version: payload.providerContractVersion, normalizer_version: payload.normalizerVersion, scope: payload.scope, payload, source_evidence_hash: payload.sourceEvidenceHash, created_at: payload.createdAt }; }
class PublicationDb implements DbPool {
  rows: Row[] = []; sequence = 0; sql: string[] = [];
  async end() {}
  async connect(): Promise<TransactionClient> { return { release() {}, query: (q, v) => this.query(q, v) }; }
  async query<T = unknown>(q: string, values?: readonly unknown[]): Promise<QueryResult<T>> { this.sql.push(q); const l = q.toLowerCase(); if (l.startsWith("select generation_publication_id") && l.includes("where generation_commitment_id")) return { rows: this.rows.filter((r) => r.generation_commitment_id === values?.[0] && r.source_evidence_hash === values?.[1] && r.publication_state === values?.[2]) as T[], rowCount: this.rows.length }; if (l.startsWith("select generation_publication_id")) return { rows: this.rows as T[], rowCount: this.rows.length }; if (l.startsWith("update public.targeted_verifier_generation_publication_sequence")) { this.sequence += 1; return { rows: [{ publication_sequence: this.sequence }] as T[], rowCount: 1 }; } if (l.startsWith("insert into public.targeted_verifier_generation_publications")) { const v = values ?? []; this.rows.push({ generation_publication_id: v[0], generation_commitment_id: v[1], publication_sequence: v[2], publication_state: v[3], sweep_id: v[4], generation_root_hash: v[5], candidate_artifact_hash: v[6], barrier_artifact_hash: v[7], candidate_model_version: v[8], generation_model_version: v[9], verifier_schema_version: v[10], verifier_policy_version: v[11], provider_contract_version: v[12], normalizer_version: v[13], scope: JSON.parse(String(v[14])), payload: JSON.parse(String(v[15])), source_evidence_hash: v[16], created_at: v[17] }); return { rows: [], rowCount: 1 }; } return { rows: [], rowCount: 0 }; }
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
    { ...value, sourceArtifactIdentity: { ...value.sourceArtifactIdentity, sourceProvenance: { adapter: "not-a-hash" } }, sourceEvidenceHash: sha256Canonical({ manifest: value.generationRootHash, candidate: value.candidateArtifactHash, barrier: value.barrierArtifactHash, provenance: { adapter: "not-a-hash" } }) },
    { ...value, extra: true }
  ];
  for (const item of cases) assert.equal(validateGenerationPublicationEvidence(item), false);
});
test("strict DB row decoder cross-binds every duplicated column", () => {
  const value = publication(4); const row = rowFrom(value);
  assert.equal(decodeGenerationPublicationRow(row).generationPublicationId, value.generationPublicationId);
  for (const key of ["publication_state", "publication_sequence", "generation_commitment_id", "generation_publication_id", "source_evidence_hash", "candidate_model_version"]) {
    const tampered = { ...row, [key]: key === "publication_sequence" ? 99 : key === "publication_state" ? "REJECTED" : "x" };
    assert.throws(() => decodeGenerationPublicationRow(tampered), /GENERATION_PUBLICATION_DURABLE_CORRUPTION/);
  }
});
test("current accepted generation selects unique greatest sequence and fails on conflicts", async () => {
  const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db); const first = publication(1); const second = publication(2, "b");
  db.rows.push(rowFrom(first)); db.rows.push(rowFrom(second));
  const current = await store.getCurrentAcceptedGeneration(scope); assert.equal(current.outcome, "CURRENT"); if (current.outcome === "CURRENT") assert.equal(current.publication.generationPublicationId, second.generationPublicationId);
  db.rows.push(rowFrom(publication(2, "c")));
  const conflict = await store.getCurrentAcceptedGeneration(scope); assert.equal(conflict.outcome, "CURRENT_GENERATION_CONFLICT");
});
test("current generation selection is exact by protocol scope", async () => {
  const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db);
  const protocolB: GenerationPublicationScope = { ...scope, protocolAddress: "0x" + "2".repeat(40) };
  db.rows.push(rowFrom(publication(10, "a", scope)), rowFrom(publication(11, "b", protocolB)));
  const current = await store.getCurrentAcceptedGeneration(scope); assert.equal(current.outcome, "CURRENT"); if (current.outcome === "CURRENT") assert.equal(current.publication.publicationSequence, 10);
});
test("empty and corrupted publication rows fail closed", async () => {
  const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db); const result = await store.getCurrentAcceptedGeneration(scope); assert.equal(result.outcome, "CURRENT_GENERATION_UNPROVEN");
  db.rows.push({ ...rowFrom(publication(9)), payload: { bad: true } }); const corrupted = await store.getCurrentAcceptedGeneration(scope); assert.equal(corrupted.outcome, "CURRENT_GENERATION_UNPROVEN");
});
test("untrusted caller cannot create a publication", async () => {
  const store = new PostgresGenerationPublicationStore(new PublicationDb()); const source = { integratedEvidence: { status: "VALID", manifest: null, candidate: null, barrier: null, candidateRef: null, barrierRef: null, reasons: [], authorityGranted: false, deactivationAuthorityGranted: false } as never, protocolAddress: scope.protocolAddress, createdAt: "2026-09-13T00:00:00.000Z" };
  await assert.rejects(store.publish(source), /GENERATION_NOT_ACCEPTED_FOR_PUBLICATION/);
});
test("trusted VERIFIED evidence publishes only for a protocol proven by candidate evidence", async () => {
  const fixture = await makeTrustedContexts();
  try {
    assert.ok(fixture.evidence);
    assert.deepEqual(provenCandidateProtocolAddresses(fixture.evidence), [fixture.protocolAddress]);
    const source = { integratedEvidence: fixture.evidence, protocolAddress: fixture.protocolAddress, createdAt: "2026-09-13T00:00:00.000Z" };
    const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db);
    const first = await store.publish(source); const replay = await store.publish(source);
    assert.equal(first.publicationState, "ACCEPTED"); assert.equal(first.generationPublicationId, replay.generationPublicationId); assert.equal(first.publicationSequence, replay.publicationSequence); assert.equal(db.rows.length, 1);
    await assert.rejects(store.publish({ ...source, protocolAddress: "0x" + "2".repeat(40) }), /PROTOCOL_ADDRESS_NOT_PROVEN/);
  } finally { await disposeTrustedContexts(fixture.root); }
});
test("trusted ABORTED evidence is rejected before sequence allocation", async () => {
  const fixture = await makeTrustedContexts({ unstable: true });
  try {
    const db = new PublicationDb(); const store = new PostgresGenerationPublicationStore(db);
    await assert.rejects(store.publish({ integratedEvidence: fixture.evidence, protocolAddress: fixture.protocolAddress, createdAt: "2026-09-13T00:00:00.000Z" }), /GENERATION_NOT_ACCEPTED_FOR_PUBLICATION/);
    assert.equal(db.sequence, 0); assert.equal(db.rows.length, 0); assert.equal(db.sql.some((sql) => sql.toLowerCase().startsWith("update public.targeted_verifier_generation_publication_sequence")), false);
  } finally { await disposeTrustedContexts(fixture.root); }
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
