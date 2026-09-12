# Task 56 durable worker correctness

Offline remediation of Task-55 operational defects M1–M7. The exact-order transport, adapter, schema, normalizer, and policy modules remain unchanged at v1/v11/v3/v5/v8.

M1 separates provider execution from RESPONSE_OBSERVED/PENDING_FENCE local recovery; recovery never acquires a provider permit, reads credentials, or invokes the executor. M2 applies lease-expiry predicates to claims and due work. M3 normalizes terminal leases and preserves indexed/payload state. M4 persists retry metadata. M5 adds migration 006 for persistent request-start spacing. M6 hashes an explicit semantic whitelist, excluding leases and scheduler fields. M7 provides a production factory without an injectable fence and an explicitly test-only seam.

No live network, credential, database, listing mutation, worker, scheduler, or Active Listings execution was used. Authority and deactivation authority remain false.

Outcome: A, subject to the recorded gates and focused regression suite.
