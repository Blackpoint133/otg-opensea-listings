import path from "node:path";
import type { IntegratedGenerationEvidenceResolver } from "./activeListingsEvidence.js";
import type { GenerationPublicationEvidenceV1 } from "./generationPublication.js";
import { openGenerationEvidenceReader } from "./evidence/fileEvidenceStore.js";
import { reconstructIntegratedEvidence, type IntegratedEvidenceResult } from "./evidence/reconciliationEvidenceIntegration.js";

export class FileIntegratedGenerationEvidenceResolver implements IntegratedGenerationEvidenceResolver {
  constructor(private readonly evidenceRoot: string) {}
  async resolve(publication: GenerationPublicationEvidenceV1): Promise<IntegratedEvidenceResult | null> {
    try {
      const reader = await openGenerationEvidenceReader(path.resolve(this.evidenceRoot, publication.sweepId), publication.sweepId);
      const evidence = await reconstructIntegratedEvidence(reader, publication.sweepId, publication.sourceArtifactIdentity.sourceProvenance);
      if (evidence.status !== "VALID" || !evidence.manifest || !evidence.candidateRef || !evidence.barrierRef) return null;
      if (evidence.manifest.rootContentHash !== publication.generationRootHash || evidence.candidateRef.contentHash !== publication.candidateArtifactHash || evidence.barrierRef.contentHash !== publication.barrierArtifactHash) return null;
      return evidence;
    } catch { return null; }
  }
}
