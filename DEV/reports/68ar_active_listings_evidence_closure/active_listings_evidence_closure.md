# Task 68AR — Active Listings Evidence Closure

Task 68A architecture remains unchanged. Runtime validation now requires `orderHash` to already be a string before applying the canonical order-hash pattern; arbitrary values and coercion-capable objects cannot pass.

The current-source regression uses two real trusted reconstructed generations for the same exact order and scope: sequence 10 is `ABSENT_CANDIDATE`, while sequence 11 is `PRESENT`. The source resolves only the current publication and returns sequence 11 / `PRESENT` / `ACTIVE`. Supplying the historical same-scope evidence for the current publication fails publication/artifact binding.

The accepted upstream candidate validator rejects duplicate order identities as ambiguous, so duplicate trusted reconstructed candidate evidence cannot normally reach ActiveListingsEvidence derivation; reconstruction and trust semantics were not weakened.

The active-evidence prerequisite remains closed and deterministic. There is no independent publication clock, migration 008, shadow evaluator, shadow persistence, deactivation authority, or listing mutation.
