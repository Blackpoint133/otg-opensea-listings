import type { DbPool } from "../db/types.js";
import type { GenerationPublicationEvidenceV1 } from "./generationPublication.js";
import type { ContinuityLossRebaselinePlanV2 } from "./continuityLossRebaseline.js";
import { canonicalEvidence } from "./evidence/canonicalEvidence.js";

/** Fail-closed durable verifier for continuity-loss adoption.  It deliberately
 * returns only a boolean so no database or credential material can leak into
 * operator diagnostics. */
export async function verifyContinuityLossRebaselineDurable(
  pool: DbPool,
  plan: ContinuityLossRebaselinePlanV2,
  publication: GenerationPublicationEvidenceV1,
  supersededPublicationId: string,
  supersededSweepId: string,
  leaseProbe: () => Promise<{ pid: string; backendStart: string; applicationName: string; database: string } | null>,
  initialLease: { pid: string; backendStart: string; applicationName: string; database: string }
): Promise<boolean> {
  try {
    const receipt = await pool.query<any>("SELECT schema_version,adoption_id,generation_publication_id,publication_sequence,sweep_id,expected_order_count,adopted_order_count,protocol_address,raw_baseline_listing,rows_commitment,payload FROM public.opensea_listings_initial_baseline_adoptions WHERE adoption_id=$1", [plan.adoptionId]);
    if (receipt.rows.length !== 1) return false;
    const r = receipt.rows[0];
    let payload: unknown = r.payload; if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return false; } }
    if (r.schema_version !== "initial-baseline-adoption-v2" || r.adoption_id !== plan.adoptionId || r.generation_publication_id !== publication.generationPublicationId || Number(r.publication_sequence) !== publication.publicationSequence || r.sweep_id !== publication.sweepId || Number(r.expected_order_count) !== plan.expectedOrderCount || Number(r.adopted_order_count) !== plan.expectedOrderCount || r.protocol_address !== plan.protocolAddress || r.rows_commitment !== plan.rowsCommitment || canonicalEvidence(payload) !== canonicalEvidence(plan)) return false;
    const linked = await pool.query<any>("SELECT order_hash,protocol_address,initial_baseline_adoption_id,raw_baseline_listing FROM public.opensea_listings_v2 WHERE initial_baseline_adoption_id=$1", [plan.adoptionId]);
    if (linked.rows.length !== plan.expectedOrderCount || new Set(linked.rows.map((x: any) => x.order_hash)).size !== plan.expectedOrderCount) return false;
    const expected = new Map(plan.rows.map((x) => [x.orderHash, x]));
    for (const row of linked.rows) {
      const baseline = expected.get(row.order_hash);
      let raw: unknown = row.raw_baseline_listing; if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return false; } }
      if (!baseline || row.initial_baseline_adoption_id !== plan.adoptionId || row.protocol_address !== plan.protocolAddress || canonicalEvidence(raw) !== canonicalEvidence(baseline.rawBaselineListing)) return false;
    }
    const current = await pool.query<any>("SELECT generation_publication_id,publication_sequence,publication_state,sweep_id FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1", [publication.generationPublicationId]);
    if (current.rows.length !== 1 || current.rows[0].publication_state !== "ACCEPTED" || Number(current.rows[0].publication_sequence) !== publication.publicationSequence || current.rows[0].sweep_id !== publication.sweepId) return false;
    const accepted = await pool.query<any>("SELECT generation_publication_id,publication_sequence,publication_state,scope FROM public.targeted_verifier_generation_publications WHERE publication_state='ACCEPTED'");
    const scope = publication.scope; const scoped = accepted.rows.filter((x: any) => { let s: any = x.scope; if (typeof s === "string") { try { s = JSON.parse(s); } catch { return false; } } return s && s.chain === scope.chain && s.collectionSlug === scope.collectionSlug && s.contractAddress === scope.contractAddress && s.protocolAddress === scope.protocolAddress; });
    const max = scoped.reduce((m: number, x: any) => Math.max(m, Number(x.publication_sequence)), -1); if (scoped.filter((x: any) => Number(x.publication_sequence) === max).length !== 1 || max !== publication.publicationSequence) return false;
    const superseded = await pool.query<any>("SELECT publication_sequence,publication_state,sweep_id FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1", [supersededPublicationId]);
    if (superseded.rows.length !== 1 || superseded.rows[0].publication_state !== "ACCEPTED" || Number(superseded.rows[0].publication_sequence) !== plan.supersededPublicationSequence || superseded.rows[0].sweep_id !== supersededSweepId) return false;
    const oldAdoptions = await pool.query<any>("SELECT count(*)::int AS count FROM public.opensea_listings_initial_baseline_adoptions WHERE generation_publication_id=$1", [supersededPublicationId]);
    if (Number(oldAdoptions.rows[0]?.count ?? 0) !== 0) return false;
    const unsafe = await pool.query<any>("SELECT count(*)::int AS count FROM public.opensea_listings_events_v2 WHERE event_id > $1::bigint AND processing_status IN ('pending','processing','failed')", [plan.recoveryEntryJournalEventId]);
    if (Number(unsafe.rows[0]?.count ?? 0) !== 0) return false;
    const after = await leaseProbe();
    return !!after && after.pid === initialLease.pid && after.backendStart === initialLease.backendStart && after.applicationName === initialLease.applicationName && after.database === initialLease.database;
  } catch {
    return false;
  }
}
