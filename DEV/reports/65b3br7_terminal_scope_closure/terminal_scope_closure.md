# Task 65B.3BR7 — Terminal and Scope Closure

BR6 correctly closed retry-child context/recovery evidence and preserved the accepted semantic-hash and identity contracts. This remediation tightens the remaining durable trust boundary.

BR6 FAILED admission grouped terminal classifications too broadly. It also did not enforce the accepted chain/collection/contract scope at durable admission. Failure classification is operational metadata and is not included in `operationalSemanticMaterial`; therefore lifecycle admission now binds each classification to its exact reachable semantic state, including retry metadata and final status.

BR7 adds exact COMPLETE and FAILED state/classification constraints and rejects self-consistent records outside the supported targeted-verifier scope. The existing hash format/material, journal semantics, retry/context behavior, PostgreSQL CAS/throttle, and authority flags are unchanged.

Migration 007: NO. Authority granted: FALSE. Deactivation authority granted: FALSE. No live OpenSea requests, API-key reads, production DB connections, or listing mutations.
