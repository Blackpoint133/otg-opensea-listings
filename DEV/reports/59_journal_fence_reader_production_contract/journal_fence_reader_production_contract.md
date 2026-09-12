# Task 59 Journal Fence Reader Production Contract

The reader now accepts the node-postgres timestamptz contract (`Date`) and canonicalizes it with `toISOString()`, while retaining strict ISO validation. Snapshot reads remain repeatable-read/read-only, and the watermark binds event ID and timestamp from the same row. The stateful simulator performs a real interleaving: insertion occurs after high-water capture and before the bounded event query; the first snapshot excludes the new row and a subsequent transaction observes it.

The production bridge is exercised and delegates directly to `applyJournalFence`. Direct-order, same-NFT transfer, unrelated-event, empty-journal, malformed-row, and rollback behavior are covered. No worker or accepted verifier files changed; no migration was needed.
