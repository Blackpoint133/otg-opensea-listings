# Task 65B.1 permit-before-claim

Fresh NOT_STARTED attempts now acquire the provider permit before durable claim. Permit denial returns CADENCE_BLOCKED without claim or mutation. Recovery lifecycles RESPONSE_OBSERVED and PENDING_FENCE claim directly without provider permit, credential, or executor access. Claim races release the acquired permit exactly once; pre-provider failures are released by the existing finally path.

Worker orchestration only was changed. PostgreSQL store/throttle and accepted verifier/fence layers were not modified.
