# Initial generation bootstrap orchestrator

The runtime composes the accepted projection, journal-window, evidence, publication, and durable adoption primitives. External continuous ingestion remains owned by the long-lived production ingestion runtime; this bootstrap never starts, stops, or acquires its guard.

Continuity is proven by a private lease identity returned from a PostgreSQL `pg_locks`/`pg_stat_activity` join: exactly one granted session advisory guard holder, including PID, backend start, application name, and database. The same lease is required at the start-barrier, post-snapshot, pre-publication, pre-adoption, and post-adoption checkpoints. The semantic order is lease, durable barrier, then snapshot start time.

The sequence is: migration/state preflight, source provenance hashing, lease capture, start watermark, authoritative complete Active Listings sweep, projection-bound scope, end observation, bounded settling, bounded consecutive clean catch-up rounds, VERIFIED generation evaluation, snapshot artifact before integrated evidence finalization, durable reconstruction, PostgreSQL publication, and fenced PostgreSQL baseline adoption.

Published-but-not-adopted failures retain the publication and return `PUBLISHED_NOT_ADOPTED`; no second sweep or publication deletion is attempted. Once adoption returns `ADOPTED` or `ALREADY_ADOPTED`, the runtime records that commit and can only return `VERIFIED_ADOPTED` or `ADOPTED_WITH_POSTCONDITION_FAILURE`, never not-adopted. Post-adoption verification checks immutable receipt/link provenance only, allowing mutable Stream state to advance. The runtime requires VERIFIED/FENCE_ELIGIBLE evidence and keeps deactivation authority false throughout.
