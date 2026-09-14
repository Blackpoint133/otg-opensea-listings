# Task 71F test and gate evidence

Focused tests cover the exact `all` profile, explicit confirmation, database/schema fail-closed startup, migration-008 prerequisites, durable callback persistence, duplicate idempotency, serialized overlapping callbacks, contained persistence failures, shutdown draining, accepted worker reuse, and source isolation from Active Listings and exact-order transports.

The production command was not executed. No OpenSea request, API-key read, production database write, generation publication, shadow persistence, or listing mutation was performed during implementation.
