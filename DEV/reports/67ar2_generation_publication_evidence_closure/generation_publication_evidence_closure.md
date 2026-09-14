# Task 67AR2 — generation publication evidence closure

67AR fixed the publication trust boundary: only verified fence-eligible generations publish, scope and protocol are source-bound, and SQL metadata is cross-bound to the canonical payload. It did not, however, contain an executable overlapping-publication test. This task adds only evidence closure: provenance keys now require trimmed non-empty names with canonical SHA-256 values, and the test harness models transactional connections, sequence-row locking, commit, rollback, and durable visibility.

The accepted production publication algorithm is unchanged except for the provenance-key predicate. Migration 007 is unchanged and migration 008 is not required. ActiveListingsEvidenceV1, shadow evaluation, SHADOW_ELIGIBLE, Fence B, deactivation authority, and listing mutation remain unimplemented.
