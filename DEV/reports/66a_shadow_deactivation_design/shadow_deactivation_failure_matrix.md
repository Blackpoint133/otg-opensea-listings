# Task 66AR3 — Deterministic Shadow Failure Matrix

| Evidence/state | Shadow result | Exact reason |
|---|---|---|
| Generation publication source not implemented | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_SOURCE_UNAVAILABLE` |
| Source exists but zero valid accepted publications | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_UNPROVEN` |
| Conflicting valid publications at greatest sequence | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_CONFLICT` |
| Attempt/publication commitment binding missing or ambiguous | `RECONCILIATION_REQUIRED` | `GENERATION_PUBLICATION_BINDING_UNPROVEN` |
| Attempt commitment differs from unique current commitment | `SUPERSEDED` | `STALE_GENERATION` |
| Active evidence source not implemented, unversioned, or missing V1 sequence | `RECONCILIATION_REQUIRED` | `ACTIVE_EVIDENCE_SOURCE_UNAVAILABLE` |
| Evidence changes during consistency re-check | `RECONCILIATION_REQUIRED` | `EVALUATION_SNAPSHOT_CHANGED` |
| Stable inactive result and all prerequisites pass | `SHADOW_ELIGIBLE` | `ELIGIBLE_STABLE_INACTIVE` |
| Historical relevant event identical in both Fence-A fingerprints | Eligible remains possible | `HISTORICAL_EVENT_NOT_NEW` |
| New relevant event across Fence A | `RECONCILIATION_REQUIRED` | `RELEVANT_ORDER_EVENT_ACROSS_FENCE` |
| Later ACTIVE, different commitments, valid publications, greater sequence | `BLOCKED_BY_LATER_EVIDENCE` | `ACTIVE_EVIDENCE_DOMINATES` |
| Later ACTIVE, same commitment, strictly greater accepted journal watermark | `BLOCKED_BY_LATER_EVIDENCE` | `ACTIVE_EVIDENCE_DOMINATES` |
| Later ACTIVE, same commitment, equal/unordered watermark | `RECONCILIATION_REQUIRED` | `ACTIVE_ORDERING_UNPROVEN` |
| Later ACTIVE, different commitment but missing/invalid publication proof | `RECONCILIATION_REQUIRED` | `ACTIVE_ORDERING_UNPROVEN` |
| `TERMINAL_CONFIRMED` or `EXPIRED_CONFIRMED` | `SHADOW_INELIGIBLE` | `NOT_INACTIVE_CONFIRMED` |
| `UNKNOWN` | `SHADOW_INELIGIBLE` | `PROVIDER_STATUS_NOT_ELIGIBLE` |
| `AMBIGUOUS`, malformed, or provenance mismatch | `RECONCILIATION_REQUIRED` | `PROVIDER_EVIDENCE_INVALID` |
| `RATE_LIMITED`, `TRANSPORT_FAILED`, or retry exhausted non-inactive | `SHADOW_INELIGIBLE` | `PROVIDER_RETRYABLE_OR_NOT_INACTIVE` |
| Stale fence, changed fingerprint, ambiguity, regression, or order mismatch | `RECONCILIATION_REQUIRED` | `FENCE_EVIDENCE_INVALID` |
| `SHADOW_ELIGIBLE` before Fence B | `SHADOW_ELIGIBLE` remains audit-only | `NO_MUTATION_AUTHORITY` |
| Fence B later stable (conceptual future stage) | Not a shadow state | `FUTURE_MUTATION_PREREQUISITES_SATISFIED` |
| Fence B changes/fails (conceptual future stage) | Historical row remains auditable; future mutation suppressed | `FENCE_B_FAILED` |

Precedence is deterministic: missing/corrupt prerequisites, ambiguity, identity conflicts, and snapshot races require reconciliation; newer-generation replay supersedes; provably newer active evidence blocks; ordinary non-inactive provider states are then ineligible. Missing evidence never upgrades a decision. All rows remain audit-only and grant no authority.
