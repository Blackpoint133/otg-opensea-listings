# Task 67AR — generation publication closure

Task 67A’s publication path admitted any structurally valid offline result, including a valid `ABORTED`/`FENCE_BLOCKED` result. It also trusted duplicated PostgreSQL columns independently of the canonical payload and allowed the caller to choose the protocol address. This remediation keeps migration 007 unchanged and closes those boundaries.

Only trusted reconstructed evidence with `VERIFIED`, eligible transport, stable catch-up, an eligible final fence, no abort reasons, and false deactivation authority can create an `ACCEPTED` publication. Publication state is derived by the production API. Manifest scope is checked against the supported OTG scope and the protocol address must occur in trusted candidate identities.

The store decodes raw rows as unknown, validates the complete payload, then cross-binds every duplicated SQL column, bigint sequence, JSON scope, and normalized timestamp to that payload. Current-generation selection uses only decoded accepted rows and exact protocol scope; malformed or conflicting rows fail closed. Existing accepted evidence is idempotent, while sequence allocation remains transactional and monotonic. ActiveListingsEvidenceV1, shadow evaluation, Fence B, and mutation authority remain unimplemented.

Migration 008: none. Migration 007 was not modified.
