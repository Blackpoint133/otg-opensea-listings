# Task 69AR — Shadow evaluator integrity closure

Task 69A supplied the pure audit evaluator and one positive worker-backed test. Its decision validator did not independently recompute the evidence hash, blocking later ACTIVE evidence was omitted from blocked-decision evidence, and later attempts were compared to the candidate only by order hash.

This remediation reuses the accepted operational-record normalizer for candidate and later attempts, admits every later-evidence field strictly, binds the complete canonical order identity and request identity, and performs admission before semantic precedence. Decisions are schema-v2, self-contained through `ShadowEvidenceMaterialV1`, and content-addressed by `shadowEvidenceHash` and `shadowDecisionId`. Candidate generation material is kept distinct from current generation material. All admitted later entries are projected and sorted before a blocking decision is emitted, so blocking evidence changes the decision digest.

The evaluator remains pure and audit-only. It has no database, scheduler, network, Fence B, shadow persistence, listing repository, or mutation capability. All authority flags remain false. Migration 008 is not created.
