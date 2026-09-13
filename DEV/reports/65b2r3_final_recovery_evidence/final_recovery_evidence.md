# Task 65B.2R3 final recovery evidence

Task-65B.2R2 fixed the runtime-provenance restart defect, but its committed PENDING_FENCE test accepted any non-STALE result rather than requiring COMPLETE. This task strengthens that existing test with a distinguishable stable post snapshot and exact durable post-fence persistence assertions.

The earlier rehydration test covered only one malformed reason-code case and did not explicitly prove the caller object remained untrusted after admission. It now covers malformed hashes, retry metadata, confirmed-status invariants, active quantity, and active time-window evidence, while asserting the caller clone remains untrusted and the owned result is frozen.

No production code was changed. Accepted journal fence, store, throttle, permit ordering, and recovery behavior remain frozen.
