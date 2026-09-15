# Task 71G2 implementation

Implemented migration 009 and a dedicated, runtime-opaque initial baseline adoption plan/store.

The migration adds `opensea_listings_initial_baseline_adoptions` with immutable publication, evidence, scope, watermark, timing, count, and rows-commitment provenance. It adds nullable `protocol_address`, `initial_baseline_adoption_id`, and `raw_baseline_listing` columns plus canonical/all-or-none constraints and an adoption index to `opensea_listings_v2`. Migration 009 was not applied to production.

`createInitialBaselineAdoptionPlan` re-imports the original complete Active Listings evidence, binds it to the existing projection, candidate bundle, trusted integrated evidence, and accepted publication, then derives the projection-bound generation scope. Plans are content-addressed by canonical rows commitment and adoption material and are accepted by the store only through private runtime provenance; structural clones are not adoptable.

Rows use source `active_listings_initial_baseline`, durable canonical protocol address, exact `raw_baseline_listing`, and JSON null `raw_last_event`. Snapshot provider timestamps are not used as local row creation time; one transaction timestamp is used for `created_at`, `updated_at`, `last_reconciled_at`, and the receipt `adopted_at`. The ordinary event `upsertOrderState` path is intentionally not used.

Adoption locks the publication sequence row, then the journal table, then the listing table with bounded `lock_timeout`. It verifies the current accepted publication, requires an empty first-generation local scope, rejects any relevant post-stable journal event (including already-resolved statuses), rejects expired rows, inserts one immutable receipt and exactly the expected rows atomically, and performs no journal or NFT-state writes. Exact committed retries verify receipt/linked-row integrity and return `ALREADY_ADOPTED` without rewriting current listing state. Partial or mismatched durable state fails closed.
