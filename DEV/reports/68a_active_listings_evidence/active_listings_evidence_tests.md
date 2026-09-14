# Task 68A — Test and Gate Evidence

Focused tests cover trusted `PRESENT`, trusted `ABSENT_CANDIDATE`, blocked classification, publication/artifact mismatch, missing source, exact identity mismatch, current-generation selection, current-generation unproven/conflict outcomes, and self-consistent ActiveListingsEvidence tampering.

The helper fixtures use the real persist/reconstruct evidence path; no hand-built trust marker is accepted. Active evidence is checked through the strict runtime validator and canonical `activeEvidenceId` material.

No production database, API key, or live OpenSea request is used. No ActiveListingsEvidence migration was created (`migration 008 = NO`).
