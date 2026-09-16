# Task 71LIVE-ADOPTION-RACE9R1 implementation

Baseline: `229718f30c1f7e5a00f2688bb4415fa21843475e`

The recovery path now treats durable adoption and post-adoption conditions as independent facts. An existing exact receipt always reports `adoptionCommitted: true`; verifier and same-lease checks run independently with first-class booleans. Only when both pass is the result `ALREADY_VERIFIED_ADOPTED`; any failed postcondition is `ADOPTED_WITH_POSTCONDITION_FAILURE`, with deterministic durable-verification and/or ingestion-continuity reason codes. A committed adoption can never be downgraded to `PUBLISHED_NOT_ADOPTED`.

Hermetic adoption tests now use production-shaped raw journal payloads and a stateful transaction fake. They pass the shared stored-event normalizer and real `reduceOrderState`/`applyTransferToOrder` reducers, asserting cancellation, sale, invalidation, revalidation, listing, transfer suppression, event-id ordering, old-event anchoring, unsafe-status rollback, provenance survival, matching-live-row merge, identity conflict, and preservation of unrelated live rows.

The observed race fixture models a durable accepted publication, two pre-existing live rows, absent adoption, and post-fence events. The real `PostgresInitialBaselineAdoptionStore` seeds missing baseline members, preserves the live rows, replays effects, links exactly the baseline membership, and inserts one receipt without creating a sweep or publication. A real recovery-pipeline test uses the file evidence reader, historical source provenance, real reconstruction/projection/plan construction, and the real adoption store against the stateful fake database. No Active Listings client or OpenSea path is involved.

No migrations, authority changes, Stream changes, environment changes, or production execution were performed.
