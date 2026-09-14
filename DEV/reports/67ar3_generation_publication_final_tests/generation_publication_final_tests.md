# Task 67AR3 — final generation-publication tests

Production `src/reconciliation/generationPublication.ts` was not changed. The 67AR2 executable concurrency, replay, rollback, foreign-scope, and provenance tests remain intact. This closure adds the complete duplicated SQL-column/payload corruption matrix, a real initial `findExisting` replay-corruption test, exact allocator-delta assertions for unproven protocol evidence, and the unrelated higher-sequence scope regression.

Migration 007 is unchanged; migration 008 is not required. ActiveListingsEvidenceV1, shadow evaluation, SHADOW_ELIGIBLE, Fence B, deactivation, and listing mutation remain unimplemented.
