# Task 66A — Shadow Eligibility Failure Matrix

| Evidence/state | Shadow result | Deterministic reason |
|---|---|---|
| Stable `INACTIVE_CONFIRMED`, current generation, both fences stable | `SHADOW_ELIGIBLE` | `ELIGIBLE_STABLE_INACTIVE` |
| `ACTIVE_CONFIRMED` | `BLOCKED_BY_LATER_EVIDENCE` | `ACTIVE_EVIDENCE_DOMINATES` |
| `TERMINAL_CONFIRMED` | `SHADOW_INELIGIBLE` | `NOT_INACTIVE_CONFIRMED` |
| `EXPIRED_CONFIRMED` | `SHADOW_INELIGIBLE` | `NOT_INACTIVE_CONFIRMED` |
| `UNKNOWN` | `SHADOW_INELIGIBLE` | `PROVIDER_STATUS_NOT_ELIGIBLE` |
| `AMBIGUOUS` | `RECONCILIATION_REQUIRED` | `AMBIGUOUS_PROVIDER_RESULT` |
| `RATE_LIMITED` | `SHADOW_INELIGIBLE` | `PROVIDER_RETRYABLE` |
| `TRANSPORT_FAILED` | `SHADOW_INELIGIBLE` | `PROVIDER_RETRYABLE` |
| `MALFORMED_RESPONSE` | `RECONCILIATION_REQUIRED` | `PROVIDER_EVIDENCE_INVALID` |
| `PROVENANCE_MISMATCH` | `RECONCILIATION_REQUIRED` | `PROVENANCE_MISMATCH` |
| Retry exhausted (`COMPLETE`, provider status non-inactive) | `SHADOW_INELIGIBLE` | `RETRY_EXHAUSTED_NOT_INACTIVE` |
| `RECONCILIATION_REQUIRED` | `RECONCILIATION_REQUIRED` | `JOURNAL_RECONCILIATION_REQUIRED` |
| Stale fence | `RECONCILIATION_REQUIRED` | `STALE_FENCE` |
| Later `item_listed` | `BLOCKED_BY_LATER_EVIDENCE` | `LATER_ITEM_LISTED` |
| Later `order_revalidate` | `BLOCKED_BY_LATER_EVIDENCE` | `LATER_ORDER_REVALIDATE` |
| Later sale/cancel/order event | `BLOCKED_BY_LATER_EVIDENCE` | `LATER_RELEVANT_ORDER_EVENT` |
| Changed relevant fingerprint | `RECONCILIATION_REQUIRED` | `RELEVANT_FINGERPRINT_CHANGED` |
| Ambiguous fingerprint | `RECONCILIATION_REQUIRED` | `AMBIGUOUS_JOURNAL_ORDERING` |
| Watermark regression | `RECONCILIATION_REQUIRED` | `WATERMARK_REGRESSION` |
| Newer accepted generation | `SUPERSEDED` | `NEWER_GENERATION` |
| Old-generation replay | `SUPERSEDED` | `STALE_GENERATION` |
| Wrong attempt/request/expected identity | `RECONCILIATION_REQUIRED` | `IDENTITY_CONFLICT` |
| Unsupported chain/collection/contract | `SHADOW_INELIGIBLE` | `UNSUPPORTED_SCOPE` |
| Semantic hash corruption | `RECONCILIATION_REQUIRED` | `SEMANTIC_HASH_INVALID` |

Precedence is strict: corrupt or ambiguous evidence and identity conflicts are reconciliation-required; a newer generation is superseded; trustworthy later active/relevant evidence blocks the older inactive result; only then may ordinary non-inactive provider statuses be classified simply ineligible. Missing data never upgrades a result.

The matrix is audit-only. It grants no authority and performs no mutation.
