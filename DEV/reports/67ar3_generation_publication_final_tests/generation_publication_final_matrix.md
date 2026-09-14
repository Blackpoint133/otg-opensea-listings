# Task 67AR3 — matrix and gates

The row decoder now has executable coverage for all 17 duplicated fields: publication and commitment IDs, sequence, state, sweep/root/artifact hashes, every model/version column, scope, source evidence hash, and created timestamp. Each mutation leaves the canonical payload valid and expects `GENERATION_PUBLICATION_DURABLE_CORRUPTION`.

The initial replay path is proven fail-closed when SQL lookup metadata points at the intended publication but the payload is another independently valid publication. No sequence allocation or insert occurs. Sequential replay performs no allocator update; the overlapping replay and rollback tests from 67AR2 remain green.
