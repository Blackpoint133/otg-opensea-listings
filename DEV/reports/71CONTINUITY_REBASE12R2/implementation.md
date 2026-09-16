# Task 71CONTINUITY-REBASE12R2

This checkpoint closes the final SQL/verifier defects without changing the accepted continuity-loss architecture.

The recovery-entry anchor remains a single `REPEATABLE READ READ ONLY` transaction. Its accepted-publication currentness query is observational and no longer contains `FOR UPDATE` (or any other locking clause); adoption-time locking remains in the separate write transaction.

The durable verifier receipt query now selects only columns defined by migration 009. Baseline raw JSON is verified from `opensea_listings_v2`, where it is actually stored. Receipt verification covers the complete migration-009 receipt contract and compares it to the trusted v2 plan.

The verifier independently rebuilds snapshot-present expected listing state from the trusted plan, replays only rows above `recoveryEntryJournalEventId` in event-id order, rejects unsafe/malformed/unprovable events, ignores business timestamps at or before `snapshotCompletedAt`, and applies later order/transfer effects through `normalizeStoredRawEvent`, `reduceOrderState`, and `applyTransferToOrder`. It then compares authoritative lifecycle fields and exact baseline provenance to durable rows, without mutating anything.

The direct production CLI, managed runtime lifetime, old/new publication checks, and same-lease checks remain unchanged. No migration was added; ordinary v1 adoption semantics, deactivation authority, NFT-gap scope, and Stream policy were not broadened.
