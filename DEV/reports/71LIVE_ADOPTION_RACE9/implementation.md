# Task 71LIVE-ADOPTION-RACE9 implementation

Baseline: `08d112ebe628acc8f90648bc9f9916295bddab8f`

The defect was a timing contradiction: bootstrap required a live external ingestion lease, while the adoption store also required the supported listings table to remain empty and rejected every relevant journal row after the stable watermark. A continuously running worker can legitimately populate rows during that interval, so the empty-state check was removed from the adoption transaction.

The adoption transaction now locks publication sequence, journal, and listings in a fixed order, seeds missing authoritative baseline members, and attaches provenance to matching existing members after immutable identity checks. Existing mutable Stream state is not replaced, unrelated live rows are untouched, and snapshot absence grants no deactivation authority. It then replays the finite post-fence journal cut in ascending `event_id`, using the production stored-event normalizer and the existing order reducer/transfer reducer. Pending, processing, failed, and unknown relevant statuses fail closed; finalized applied/reconciliation-required rows are replayed, while ignored duplicate/older rows are not re-applied. Business timestamps at or before the authoritative snapshot completion are ignored so delayed older events cannot supersede the snapshot anchor. Transfer replay changes listing state only and never rewrites NFT state.

Receipt insertion and membership-count/provenance validation remain inside the same transaction, preserving rollback and idempotent `ALREADY_ADOPTED` behavior. Baseline membership is counted independently from current active state.

Added `runPublishedInitialBaselineAdoptionRecovery` and an explicit-confirmation CLI. Recovery binds an operator-supplied publication ID, sweep ID, and evidence root; reconstructs the trusted plan from the persisted historical evidence/provenance; verifies the publication is current and unadopted; requires the same external ingestion lease before and after adoption; and never creates an Active Listings client, sweep, or publication. Committed adoption is never downgraded; post-commit verification/lease failure is reported as `ADOPTED_WITH_POSTCONDITION_FAILURE`.

No schema or authority change was made. Deactivation authority remains false/none.
