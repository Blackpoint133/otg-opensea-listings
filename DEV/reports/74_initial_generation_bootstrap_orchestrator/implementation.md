# Initial generation bootstrap orchestrator

The new runtime composes the accepted projection, journal-window, evidence, publication, and durable adoption primitives. External continuous ingestion remains owned by the long-lived production ingestion runtime; this bootstrap never starts, stops, or acquires its guard.

The sequence is: migration/state preflight, ingestion health and guard check, start watermark, authoritative complete Active Listings sweep, projection-bound scope, end observation, bounded settling, bounded consecutive clean catch-up rounds, VERIFIED generation evaluation, snapshot artifact before integrated evidence finalization, durable reconstruction, PostgreSQL publication, final ingestion health check, and fenced PostgreSQL baseline adoption.

Published-but-not-adopted failures retain the publication and return `PUBLISHED_NOT_ADOPTED`; no second sweep or publication deletion is attempted. The runtime requires VERIFIED/FENCE_ELIGIBLE evidence and keeps deactivation authority false throughout.
