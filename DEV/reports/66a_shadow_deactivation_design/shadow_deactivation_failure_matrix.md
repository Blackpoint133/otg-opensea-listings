# Task 66AR — Deterministic Shadow Failure Matrix

| Evidence/state | Shadow result | Reason |
|---|---|---|
| Stable inactive result, unique current generation, consistent snapshot, Fence A equivalent with no **new** event | `SHADOW_ELIGIBLE` | `ELIGIBLE_STABLE_INACTIVE` |
| Historical relevant event appears identically in both Fence-A fingerprints | `SHADOW_ELIGIBLE` candidate remains valid | `HISTORICAL_EVENT_NOT_NEW` |
| New relevant event across Fence A | `RECONCILIATION_REQUIRED` | `RELEVANT_ORDER_EVENT_ACROSS_FENCE` |
| `ACTIVE_CONFIRMED` with provably newer accepted evidence | `BLOCKED_BY_LATER_EVIDENCE` | `ACTIVE_EVIDENCE_DOMINATES` |
| `ACTIVE_CONFIRMED` with unprovable ordering | `RECONCILIATION_REQUIRED` | `ACTIVE_ORDERING_UNPROVEN` |
| `TERMINAL_CONFIRMED` or `EXPIRED_CONFIRMED` | `SHADOW_INELIGIBLE` | `NOT_INACTIVE_CONFIRMED` |
| `UNKNOWN` | `SHADOW_INELIGIBLE` | `PROVIDER_STATUS_NOT_ELIGIBLE` |
| `AMBIGUOUS` | `RECONCILIATION_REQUIRED` | `AMBIGUOUS_PROVIDER_RESULT` |
| `RATE_LIMITED` or `TRANSPORT_FAILED` | `SHADOW_INELIGIBLE` | `PROVIDER_RETRYABLE` |
| `MALFORMED_RESPONSE` or `PROVENANCE_MISMATCH` | `RECONCILIATION_REQUIRED` | `PROVIDER_EVIDENCE_INVALID` |
| Retry exhausted with non-inactive provider result | `SHADOW_INELIGIBLE` | `RETRY_EXHAUSTED_NOT_INACTIVE` |
| `RECONCILIATION_REQUIRED` result | `RECONCILIATION_REQUIRED` | `JOURNAL_RECONCILIATION_REQUIRED` |
| Stale fence | `RECONCILIATION_REQUIRED` | `STALE_FENCE` |
| Changed fingerprint, ambiguity, watermark regression, or order mismatch | `RECONCILIATION_REQUIRED` | `FENCE_EVIDENCE_INVALID` |
| No authoritative accepted current generation | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_UNPROVEN` |
| Conflicting accepted current generations | `RECONCILIATION_REQUIRED` | `CURRENT_GENERATION_CONFLICT` |
| Generation changes during evaluation snapshot | `RECONCILIATION_REQUIRED` | `EVALUATION_SNAPSHOT_CHANGED` |
| Newer accepted generation after evaluation | `SUPERSEDED` | `NEWER_GENERATION` |
| Old-generation replay | `SUPERSEDED` | `STALE_GENERATION` |
| Active-evidence source unavailable or unversioned | `RECONCILIATION_REQUIRED` | `ACTIVE_EVIDENCE_UNPROVEN` |
| Wrong identity or unsupported scope | `RECONCILIATION_REQUIRED` | `IDENTITY_OR_SCOPE_CONFLICT` |
| Semantic hash corruption | `RECONCILIATION_REQUIRED` | `SEMANTIC_HASH_INVALID` |
| `SHADOW_ELIGIBLE` before Fence B | `SHADOW_ELIGIBLE` remains audit-only | `NO_MUTATION_AUTHORITY` |
| Fence B later stable (conceptual future stage) | Not a shadow state; future prerequisites conceptually satisfied | `FUTURE_MUTATION_PREREQUISITES_SATISFIED` |
| Fence B changes/fails (conceptual future stage) | Historical shadow decision remains auditable; future mutation suppressed | `FENCE_B_FAILED` |

Precedence is deterministic: corruption, ambiguity, identity conflict, unsupported currentness, and snapshot races require reconciliation; a newer generation supersedes; provably newer active/relevant evidence blocks; ordinary non-inactive provider states are then ineligible. Missing evidence never upgrades a decision.

This matrix is design-only. It grants no deactivation or mutation authority and performs no listing mutation.
