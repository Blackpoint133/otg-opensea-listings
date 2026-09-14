# Task 68A — Active Listings Evidence V1

Implemented a versioned, deterministic active-listings evidence view over the accepted generation-publication and trusted reconstructed generation artifacts.

## Contract

- `publicationId` is exactly the accepted `generationPublicationId`.
- `publicationSequence` is copied from that generation publication; no active-evidence allocator or wall-clock ordering exists.
- `sourceArtifactHash` is exactly the accepted candidate artifact hash.
- `observationWatermark` is the verified barrier's stable catch-up watermark.
- `PRESENT` is derived only from a trusted `PRESENT` candidate classification and produces `status: ACTIVE`.
- `ABSENT` is derived only from `ABSENT_CANDIDATE` and produces `status: null`.
- `BLOCKED` and malformed/non-canonical classifications fail closed and never become absence.

Derivation validates the accepted publication, trusted reconstructed evidence, artifact/provenance graph, supported scope, exact expected order identity, and verified stable watermark. The runtime validator rejects unknown fields, unsupported scope/version values, invalid hashes/identities/watermarks, inconsistent presence/status pairs, and active-evidence hash mismatches.

The current source first resolves the unique current accepted generation for the requested exact protocol scope, then resolves trusted evidence for that publication only. Historical evidence cannot override a newer current generation; a resolver returning evidence for another publication is rejected.

This task adds no migration and no independent active publication clock. ActiveListingsEvidenceV1 grants no authority. Shadow decisions, `SHADOW_ELIGIBLE`, Fence B, deactivation, and listing mutation remain unimplemented and disabled.
