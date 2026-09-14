# Task 67A — Evidence and Gates

Executable coverage includes:

- exact V1 shape, scope, hashes, commitment identity, and publication identity;
- raw tampering rejection for unsafe sequence, unknown state/fields, foreign scope, unsupported version, and malformed source identity;
- current-generation selection for a unique greatest accepted sequence;
- zero-publication fail-closed behavior;
- corrupted greatest-row fail-closed behavior;
- conflicting greatest-sequence publication detection;
- rejection of untrusted caller-provided integrated evidence.

The PostgreSQL store uses raw JSON payload admission rather than trusting TypeScript annotations. Sequence allocation is transaction-backed and does not use wall-clock ordering. ActiveListingsEvidenceV1 remains unimplemented by design.

Gates: build PASS; typecheck PASS; tests 1050 total, 1050 passed, 0 failed, 0 skipped, 9631.166 ms; `git diff --check` PASS.
