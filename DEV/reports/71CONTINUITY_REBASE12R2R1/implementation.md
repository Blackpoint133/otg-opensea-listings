# Task 71CONTINUITY-REBASE12R2R1

The 54030ca checkpoint still contained `raw_baseline_listing` in the receipt-table SELECT even though migration 009 stores that field only on `opensea_listings_v2`. The receipt query now selects exactly the migration-009 contract: schema/adoption/publication identity, evidence hashes, scope and fingerprint, protocol, watermarks/timestamps, expected/adopted counts, rows commitment, payload, and adopted_at.

The verifier now independently reconstructs authoritative snapshot baseline state and applies post-entry normalized order/transfer reducers before comparing all marketplace identity, seller/price/payment/timestamp, lifecycle, source, and provenance fields. PostgreSQL timestamp and numeric representations are normalized safely. Receipt and linked-row provenance are checked separately, and publication currentness, superseded-publication binding, unsafe journal statuses, business-time authority, and replacement lease remain fail-closed.
