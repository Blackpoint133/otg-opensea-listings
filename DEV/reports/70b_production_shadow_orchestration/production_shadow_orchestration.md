# Task 70B — Production shadow orchestration

The read-side orchestrator loads the durable operational attempt, selects the current accepted generation from `PostgresGenerationPublicationStore`, resolves current Active Listings evidence through the accepted file-backed reconstruction path, reads a fresh journal snapshot, and obtains a complete later-provider snapshot without network/provider calls.

Each run performs the complete acquisition and pure evaluation twice. Persistence is allowed only when both content-addressed decisions are identical. `--persist` uses only the append-only shadow decision store. The runner has no scheduler, Fence B, listing repository, inventory mutation, or authority-granting path. Migration 009 was not created.
