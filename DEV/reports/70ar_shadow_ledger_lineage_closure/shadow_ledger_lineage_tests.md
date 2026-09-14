# Task 70AR — Test evidence

The append/replay, source cross-binding, SQL/payload decoder, and migration tests remain green. Lineage validation is enforced at the store boundary and rejects self-links, missing/non-immediate predecessors, broken first-row links, and non-monotonic returned chains. Transactional source locking and rollback behavior remain represented by the store transaction contract; no mutation API exists.
