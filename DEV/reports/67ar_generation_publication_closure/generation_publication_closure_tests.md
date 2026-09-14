# Task 67AR — tests and gates

Coverage added or retained:

- trusted VERIFIED publication and source-proven protocol binding;
- strict raw-row decoding and SQL-column/payload cross-binding;
- exact scope filtering, including protocol address;
- idempotent replay and fail-closed corrupted rows;
- canonical source provenance validation;
- preservation of migration 007 and the accepted worker contract.

The existing suite remains the regression gate. No ActiveListingsEvidenceV1, shadow evaluator, listing mutation, API-key read, live OpenSea request, or production database connection is introduced by this task.
