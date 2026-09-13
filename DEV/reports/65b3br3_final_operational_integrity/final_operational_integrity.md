# Task 65B.3BR3 — Final Operational Integrity

Durable attempt admission now binds canonical attempt and idempotency identities to their derivation material, enforces supported scope and cross-field identity bindings, validates accepted journal evidence, and rejects unknown fields. Provider-stage lifecycle constraints and provider evidence admission remain fail-closed, with provider reason arrays bound for observed records.

BR2 correctly tightened versions, request, expected, and journal evidence, but still accepted arbitrary canonical attempt identifiers, lacked the complete lifecycle/provider matrix, did not equality-bind provider reason arrays, and did not fully close runtime context and local-failure evidence. This remediation addresses those store-layer boundaries without changing accepted verifier, fence, retry, throttle, or authority semantics.
