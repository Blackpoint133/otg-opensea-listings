# Task 66AR2 — Shadow Failure Matrix

| Evidence/state | Shadow result | Reason |
|---|---|---|
| Generation-publication prerequisite not implemented | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_SOURCE_UNAVAILABLE` |
| Active-listings evidence prerequisite not implemented | `RECONCILIATION_REQUIRED` | `ACTIVE_EVIDENCE_SOURCE_UNAVAILABLE` |
| Zero valid accepted publications | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_UNPROVEN` |
| Conflicting valid publications at greatest sequence | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_CONFLICT` |
| Attempt commitment differs from unique current commitment | `SUPERSEDED` | `STALE_GENERATION` |
| Attempt commitment matches current commitment | Continue prerequisite evaluation | `GENERATION_CURRENT` |
| Same commitment, newer publication record | Use unique greatest accepted sequence deterministically | `CURRENT_PUBLICATION_SELECTED` |
| Evidence changes between first read and consistency re-check | `RECONCILIATION_REQUIRED` | `EVALUATION_SNAPSHOT_CHANGED` |
| Stable inactive result, all prerequisites and Fence A pass | `SHADOW_ELIGIBLE` | `ELIGIBLE_STABLE_INACTIVE` |
| Historical relevant event identical in pre/post Fence-A fingerprints | Eligible remains possible | `HISTORICAL_EVENT_NOT_NEW` |
| New relevant event across Fence A | `RECONCILIATION_REQUIRED` | `RELEVANT_ORDER_EVENT_ACROSS_FENCE` |
| `ACTIVE_CONFIRMED` with greater generation publication sequence | `BLOCKED_BY_LATER_EVIDENCE` | `ACTIVE_EVIDENCE_DOMINATES` |
| `ACTIVE_CONFIRMED` same generation with strictly greater accepted journal watermark | `BLOCKED_BY_LATER_EVIDENCE` | `ACTIVE_EVIDENCE_DOMINATES` |
| `ACTIVE_CONFIRMED` equal/unordered watermark and same generation | `RECONCILIATION_REQUIRED` | `ACTIVE_ORDERING_UNPROVEN` |
| Active source unavailable or unversioned | `RECONCILIATION_REQUIRED` | `ACTIVE_EVIDENCE_SOURCE_UNAVAILABLE` |
| `TERMINAL_CONFIRMED` or `EXPIRED_CONFIRMED` | `SHADOW_INELIGIBLE` | `NOT_INACTIVE_CONFIRMED` |
| `UNKNOWN` | `SHADOW_INELIGIBLE` | `PROVIDER_STATUS_NOT_ELIGIBLE` |
| `AMBIGUOUS`, malformed, or provenance mismatch | `RECONCILIATION_REQUIRED` | `PROVIDER_EVIDENCE_INVALID` |
| `RATE_LIMITED`, `TRANSPORT_FAILED`, or retry exhausted non-inactive | `SHADOW_INELIGIBLE` | `PROVIDER_RETRYABLE_OR_NOT_INACTIVE` |
| Stale fence, changed fingerprint, ambiguity, regression, or order mismatch | `RECONCILIATION_REQUIRED` | `FENCE_EVIDENCE_INVALID` |
| Later evidence changes after immutable shadow append | Existing row remains auditable; successor evaluation determines current state | `SUCCESSOR_REQUIRED` |
| `SHADOW_ELIGIBLE` before Fence B | `SHADOW_ELIGIBLE` remains audit-only | `NO_MUTATION_AUTHORITY` |
| Fence B later stable (conceptual only) | Not a shadow state; future prerequisites conceptually satisfied | `FUTURE_MUTATION_PREREQUISITES_SATISFIED` |
| Fence B changes or fails (conceptual only) | Historical row remains auditable; future mutation suppressed | `FENCE_B_FAILED` |

Ordering never uses provider observation time or wall-clock time alone. Corruption, ambiguity, identity conflict, missing prerequisite evidence, and snapshot races take precedence over ordinary ineligibility. Fence B remains future-only. No row or state grants authority or performs mutation.
