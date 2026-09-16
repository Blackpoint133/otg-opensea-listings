import path from "node:path";
import type { DbPool } from "../db/types.js";
import { openGenerationEvidenceReader } from "../reconciliation/evidence/fileEvidenceStore.js";
import { reconstructIntegratedEvidence } from "../reconciliation/evidence/reconciliationEvidenceIntegration.js";
import { projectInitialGenerationBaseline } from "../reconciliation/initialGenerationBaseline.js";
import { decodeGenerationPublicationRow, type GenerationPublicationDbRow, type GenerationPublicationEvidenceV1 } from "../reconciliation/generationPublication.js";
import { createInitialBaselineAdoptionPlan, isTrustedInitialBaselineAdoptionPlan, PostgresInitialBaselineAdoptionStore, type InitialBaselineAdoptionPlanV1 } from "../reconciliation/initialBaselineAdoption.js";
import { probeExternalIngestionLease, type ExternalIngestionLease, type BootstrapLeaseProbe } from "./initialGenerationBootstrapRuntime.js";
import { SUPPORTED_CHAIN, SUPPORTED_COLLECTION_SLUG, SUPPORTED_CONTRACT_ADDRESS } from "../reconciliation/identityScope.js";
import { canonicalEvidence } from "../reconciliation/evidence/canonicalEvidence.js";

export type PublishedBaselineRecoveryStatus = "VERIFIED_ADOPTED" | "ALREADY_VERIFIED_ADOPTED" | "PUBLISHED_NOT_ADOPTED" | "ADOPTED_WITH_POSTCONDITION_FAILURE";
export interface PublishedBaselineRecoveryResult {
  readonly status: PublishedBaselineRecoveryStatus;
  readonly publicationId: string;
  readonly sweepId: string;
  readonly adoptionId?: string;
  readonly publicationCommitted: boolean;
  readonly adoptionCommitted: boolean;
  readonly postAdoptionVerified: boolean;
  readonly ingestionContinuityMaintained: boolean;
  readonly reason?: string;
}
export interface PublishedBaselineRecoveryDependencies {
  readonly pool: DbPool;
  readonly publicationId: string;
  readonly sweepId: string;
  readonly evidenceRoot: string;
  readonly leaseProbe?: BootstrapLeaseProbe;
  readonly adoptionStore?: Pick<PostgresInitialBaselineAdoptionStore, "adopt">;
  readonly planFactory?: typeof createInitialBaselineAdoptionPlan;
  readonly reconstruct?: typeof reconstructIntegratedEvidence;
  readonly project?: typeof projectInitialGenerationBaseline;
  readonly postAdoptionVerifier?: (plan: InitialBaselineAdoptionPlanV1, publication: GenerationPublicationEvidenceV1) => Promise<boolean>;
}

const PUBLICATION_COLUMNS = "generation_publication_id,generation_commitment_id,publication_sequence,publication_state,sweep_id,generation_root_hash,candidate_artifact_hash,barrier_artifact_hash,candidate_model_version,generation_model_version,verifier_schema_version,verifier_policy_version,provider_contract_version,normalizer_version,scope,payload,source_evidence_hash,created_at";
const SUPPORTED_SCOPE = { chain: SUPPORTED_CHAIN, collectionSlug: SUPPORTED_COLLECTION_SLUG, contractAddress: SUPPORTED_CONTRACT_ADDRESS };
function fail(code: string): never { throw new Error(code); }
function sameLease(left: ExternalIngestionLease, right: ExternalIngestionLease): boolean { return left.pid === right.pid && left.backendStart === right.backendStart && left.applicationName === right.applicationName && left.database === right.database; }
function safeReason(error: unknown): string { return (error instanceof Error ? error.message : "INITIAL_BASELINE_RECOVERY_FAILED").replace(/(password|secret|api[_-]?key|authorization|token|connection string)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 240); }
async function verifyLease(probe: BootstrapLeaseProbe, initial?: ExternalIngestionLease): Promise<ExternalIngestionLease> {
  const current = await probe();
  if (!current) fail(initial ? "PRODUCTION_INGESTION_CONTINUITY_LOST" : "PRODUCTION_INGESTION_LEASE_UNPROVEN");
  if (initial && !sameLease(initial, current)) fail("PRODUCTION_INGESTION_CONTINUITY_LOST");
  return current;
}
async function defaultPostAdoptionVerifier(pool: DbPool, plan: InitialBaselineAdoptionPlanV1, publication: GenerationPublicationEvidenceV1): Promise<boolean> {
  const receipt = await pool.query<any>("SELECT generation_publication_id,sweep_id,expected_order_count,adopted_order_count FROM public.opensea_listings_initial_baseline_adoptions WHERE adoption_id=$1", [plan.adoptionId]);
  if (receipt.rows.length !== 1 || receipt.rows[0].generation_publication_id !== publication.generationPublicationId || receipt.rows[0].sweep_id !== publication.sweepId || Number(receipt.rows[0].expected_order_count) !== plan.expectedOrderCount || Number(receipt.rows[0].adopted_order_count) !== plan.expectedOrderCount) return false;
  const linked = await pool.query<any>("SELECT order_hash,protocol_address,initial_baseline_adoption_id,raw_baseline_listing FROM public.opensea_listings_v2 WHERE initial_baseline_adoption_id=$1", [plan.adoptionId]);
  const expected = new Map(plan.rows.map((row) => [row.orderHash, row]));
  if (linked.rows.length !== expected.size) return false;
  const seen = new Set<string>();
  for (const row of linked.rows) { const baseline = expected.get(row.order_hash); if (!baseline || seen.has(row.order_hash) || row.protocol_address !== plan.protocolAddress || row.initial_baseline_adoption_id !== plan.adoptionId || row.raw_baseline_listing == null || canonicalEvidence(row.raw_baseline_listing) !== canonicalEvidence(baseline.rawBaselineListing)) return false; seen.add(row.order_hash); }
  return seen.size === expected.size;
}
async function loadPublication(pool: DbPool, publicationId: string, sweepId: string): Promise<GenerationPublicationEvidenceV1> {
  const rows = await pool.query<GenerationPublicationDbRow>(`SELECT ${PUBLICATION_COLUMNS} FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1`, [publicationId]);
  if (rows.rows.length !== 1) fail("INITIAL_BASELINE_PUBLICATION_NOT_FOUND");
  const publication = decodeGenerationPublicationRow(rows.rows[0]);
  if (publication.publicationState !== "ACCEPTED" || publication.sweepId !== sweepId || publication.scope.chain !== SUPPORTED_SCOPE.chain || publication.scope.collectionSlug !== SUPPORTED_SCOPE.collectionSlug || publication.scope.contractAddress !== SUPPORTED_SCOPE.contractAddress) fail("INITIAL_BASELINE_PUBLICATION_BINDING_MISMATCH");
  const current = await pool.query<GenerationPublicationDbRow>(`SELECT ${PUBLICATION_COLUMNS} FROM public.targeted_verifier_generation_publications WHERE publication_state='ACCEPTED' AND scope->>'protocolAddress'=$1`, [publication.scope.protocolAddress]);
  const accepted = current.rows.map((row) => decodeGenerationPublicationRow(row)).filter((item) => item.scope.chain === publication.scope.chain && item.scope.collectionSlug === publication.scope.collectionSlug && item.scope.contractAddress === publication.scope.contractAddress).sort((a, b) => b.publicationSequence - a.publicationSequence);
  if (accepted.length === 0 || accepted[0].generationPublicationId !== publication.generationPublicationId || accepted.some((item, index) => index > 0 && item.publicationSequence === accepted[0].publicationSequence && item.generationPublicationId !== accepted[0].generationPublicationId)) fail("INITIAL_BASELINE_PUBLICATION_NOT_CURRENT");
  return publication;
}
async function readSnapshot(reader: Awaited<ReturnType<typeof openGenerationEvidenceReader>>, sweepId: string): Promise<unknown> {
  const refs = await reader.listArtifacts();
  const ref = refs.find((item) => item.artifactType === "transport" && item.artifactId === "initial-active-listings-snapshot" && item.sweepId === sweepId);
  if (!ref) fail("INITIAL_BASELINE_SNAPSHOT_ARTIFACT_MISSING");
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(await reader.readArtifact(ref)))); } catch { fail("INITIAL_BASELINE_SNAPSHOT_ARTIFACT_INVALID"); }
}

export async function runPublishedInitialBaselineAdoptionRecovery(deps: PublishedBaselineRecoveryDependencies): Promise<PublishedBaselineRecoveryResult> {
  if (!deps.publicationId || !deps.sweepId) fail("RECOVERY_PUBLICATION_ID_REQUIRED");
  if (!path.isAbsolute(deps.evidenceRoot)) fail("EVIDENCE_ROOT_MUST_BE_ABSOLUTE");
  const probe = deps.leaseProbe ?? (() => probeExternalIngestionLease(deps.pool));
  const initialLease = await verifyLease(probe);
  const publication = await loadPublication(deps.pool, deps.publicationId, deps.sweepId);
  const receipts = await deps.pool.query<any>("SELECT adoption_id FROM public.opensea_listings_initial_baseline_adoptions WHERE generation_publication_id=$1", [publication.generationPublicationId]);
  if (receipts.rows.length > 1) fail("INITIAL_BASELINE_DURABLE_CORRUPTION");
  const reader = await openGenerationEvidenceReader(path.resolve(deps.evidenceRoot, deps.sweepId), deps.sweepId);
  const evidence = await readSnapshot(reader, deps.sweepId);
  const integrated = await (deps.reconstruct ?? reconstructIntegratedEvidence)(reader, deps.sweepId, publication.sourceArtifactIdentity.sourceProvenance);
  if (integrated.status !== "VALID") fail("INITIAL_BASELINE_EVIDENCE_UNTRUSTED");
  const projection = (deps.project ?? projectInitialGenerationBaseline)(evidence, { sourceEvidencePath: "active-listings-snapshot.json", sweepId: deps.sweepId });
  const plan = (deps.planFactory ?? createInitialBaselineAdoptionPlan)({ evidence, projection, integratedEvidence: integrated, publication });
  if (!isTrustedInitialBaselineAdoptionPlan(plan)) fail("INITIAL_BASELINE_PLAN_UNTRUSTED");
  if (receipts.rows.length === 1) {
    if (String(receipts.rows[0].adoption_id) !== plan.adoptionId) fail("INITIAL_BASELINE_DURABLE_CORRUPTION");
    const verified = await (deps.postAdoptionVerifier ?? ((p, pub) => defaultPostAdoptionVerifier(deps.pool, p, pub)))(plan, publication);
    await verifyLease(probe, initialLease);
    return { status: verified ? "ALREADY_VERIFIED_ADOPTED" : "ADOPTED_WITH_POSTCONDITION_FAILURE", publicationId: publication.generationPublicationId, sweepId: publication.sweepId, adoptionId: String(receipts.rows[0].adoption_id), publicationCommitted: true, adoptionCommitted: true, postAdoptionVerified: verified, ingestionContinuityMaintained: verified };
  }
  let adoption: Awaited<ReturnType<PostgresInitialBaselineAdoptionStore["adopt"]>>;
  try { adoption = await (deps.adoptionStore ?? new PostgresInitialBaselineAdoptionStore(deps.pool)).adopt(plan); }
  catch (error) { return { status: "PUBLISHED_NOT_ADOPTED", publicationId: publication.generationPublicationId, sweepId: publication.sweepId, publicationCommitted: true, adoptionCommitted: false, postAdoptionVerified: false, ingestionContinuityMaintained: false, reason: safeReason(error) }; }
  const committed = adoption.outcome === "ADOPTED" || adoption.outcome === "ALREADY_ADOPTED";
  if (!committed) return { status: "PUBLISHED_NOT_ADOPTED", publicationId: publication.generationPublicationId, sweepId: publication.sweepId, publicationCommitted: true, adoptionCommitted: false, postAdoptionVerified: false, ingestionContinuityMaintained: false, reason: "INITIAL_BASELINE_NOT_ADOPTED" };
  let verified = false; let continuity = false; let reason: string | undefined;
  try { verified = await (deps.postAdoptionVerifier ?? ((p, pub) => defaultPostAdoptionVerifier(deps.pool, p, pub)))(plan, publication); if (!verified) reason = "POST_ADOPTION_DURABLE_VERIFICATION_FAILED"; } catch { reason = "POST_ADOPTION_DURABLE_VERIFICATION_FAILED"; }
  try { await verifyLease(probe, initialLease); continuity = true; } catch { reason = reason ? `${reason};POST_ADOPTION_INGESTION_CONTINUITY_LOST` : "POST_ADOPTION_INGESTION_CONTINUITY_LOST"; }
  if (!verified || !continuity) return { status: "ADOPTED_WITH_POSTCONDITION_FAILURE", publicationId: publication.generationPublicationId, sweepId: publication.sweepId, adoptionId: adoption.adoptionId, publicationCommitted: true, adoptionCommitted: true, postAdoptionVerified: verified, ingestionContinuityMaintained: continuity, reason };
  return { status: "VERIFIED_ADOPTED", publicationId: publication.generationPublicationId, sweepId: publication.sweepId, adoptionId: adoption.adoptionId, publicationCommitted: true, adoptionCommitted: true, postAdoptionVerified: true, ingestionContinuityMaintained: true };
}

export { safeReason };
