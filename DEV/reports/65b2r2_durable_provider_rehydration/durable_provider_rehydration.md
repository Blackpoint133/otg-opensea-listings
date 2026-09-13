# Task 65B.2R2 durable provider rehydration

Operational recovery now reconstructs durable provider evidence through `rehydrateProviderResult`. The admission clones the serialized value, validates the complete ProviderResult shape and invariants, adds only the owned clone to the private runtime-proof WeakSet, freezes it, and revalidates provenance. Plain caller objects remain untrusted and malformed evidence is rejected deterministically.

Recovery additionally verifies normalized-order identity against the resolved context before invoking the accepted production journal fence. RESPONSE_OBSERVED and PENDING_FENCE production-factory restart paths now complete through the accepted fence with zero provider permit, credential, and executor operations. The pre-existing PENDING_FENCE evidence was a false positive because the earlier test accepted any non-STALE outcome, including INVALID_PROVIDER_RESULT converted to FAILED.

The provider-reconciliation-plus-journal-change edge is exercised using a safely rehydrated RECONCILIATION_REQUIRED result; the accepted journal reason remains visible and the worker fails closed. Accepted fence, store, throttle, and Task-65B.1 semantics remain unchanged.
