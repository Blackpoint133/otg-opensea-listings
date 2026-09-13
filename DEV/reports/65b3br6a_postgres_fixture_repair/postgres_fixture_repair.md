# BR6A PostgreSQL fixture repair

Baseline: `206b7499637e8040a7ac107fc84e15902ba6cfc2`.
The incoming production changes and retry/context work remain uncommitted. BR6A changes only test fixtures and these reports.

## Before-edit inventory

The focused run reproduced 16 tests: 5 passed, 11 failed, 0 skipped, duration 177.837686 ms.
All 11 failures throw `INVALID_OPERATIONAL_RECORD` from `validateOperationalRecordShape -> normalize`. Read/create failures enter through PostgreSQL `decode`; mutation-input failures enter through PostgreSQL `cas`. None of these rejected fixtures is equivalent to a worker-produced state.

The following default vector specifies **every requested field** for the old `rec(id, lifecycle)`; overrides below are exact, and omitted entries retain these defaults:

```json
{
  "lifecycle": "specified per row below",
  "providerResultStatus": null,
  "normalizedProviderStatus": null,
  "normalizedOrder": null,
  "providerObservedAt": null,
  "httpStatus": null,
  "transportOutcome": null,
  "responseBodySha256": null,
  "rawResponseArtifactHash": null,
  "providerReasonCodes": [],
  "providerResultReasonCodes": [],
  "reasonCodes": [],
  "retry": {"retryable": false, "retryReason": "NONE", "recommendedPolicyClass": "NONE"},
  "finalResultStatus": null,
  "semanticEvidenceHash": null,
  "postVerificationWatermark": null,
  "postRelevantFingerprint": null,
  "failureClassification": null
}
```

Hash notation below: `E64`, `A64`, `C64`, `D64`, `ZERO64`, `ONE64` denote the indicated lowercase hexadecimal character repeated exactly 64 times. `ORDER` is `0x` followed by 64 lowercase a characters. This notation avoids hiding any field value.

| Failing test (exact name) | Rejected fixture/state and exact overrides | Violated invariant / path |
|---|---|---|
| Postgres attempt store create/get/claim/CAS parity | COMPLETE; all default semantic fields | COMPLETE requires provider/final/hash/post evidence; cas, including wrong-token proposed record |
| Postgres recovery/reclaim/CAS transitions preserve evidence and retry | RESPONSE_OBSERVED; providerResultStatus UNKNOWN; providerObservedAt 2025-12-31T23:01:00.000Z; httpStatus 429; transportOutcome HTTP; responseBodySha256 E64; rawResponseArtifactHash A64; both provider reason arrays [HTTP_429]; reasonCodes []; retry {true,RATE_LIMITED,RATE_LIMITED} | Pre-fence final reasons disagree with provider reasons; create-return decode. The later PENDING_FENCE fixture uses UNKNOWN/httpStatus 500 rather than the normalizer's transport failure status; repair both from trusted normalization. |
| Postgres listDue excludes active recovery leases | RESPONSE_OBSERVED and PENDING_FENCE; default vector | Recovery requires provider evidence; create-return decode |
| Postgres listDue full lifecycle matrix | RESPONSE_OBSERVED and PENDING_FENCE variants (free, active, expired, future); default vector | Recovery requires provider evidence; create-return decode |
| Postgres CAS expiry, takeover, fail and retry parity | RESPONSE_OBSERVED; default vector | Recovery requires provider evidence; create-return decode. Later proposed EXECUTION_FAILED/COMPLETE payloads also need reachable semantic states. |
| Postgres successful fail clears both lease representations | FAILED; providerResultStatus UNKNOWN; retry {true,RATE_LIMITED,RATE_LIMITED}; failureClassification EXECUTION_FAILED; remaining defaults | EXECUTION_FAILED is pre-provider and cannot carry UNKNOWN provider evidence; cas |
| Postgres rejects future NOT_STARTED and terminal claims | COMPLETE and FAILED; default vector | COMPLETE lacks semantic result; FAILED has no classification; create-return decode |
| Postgres CAS rejects matching-token terminal current rows | COMPLETE and FAILED; default vector, injected terminal lease | Same semantic violations; raw get/decode. Matching-token terminal current-row rejection remains the test purpose. |
| Postgres RESPONSE_OBSERVED reclaim preserves rich provider evidence | RESPONSE_OBSERVED; providerResultStatus UNKNOWN; providerObservedAt 2025-12-31T23:01:00.000Z; httpStatus 429; transportOutcome HTTP; hashes C64/D64; both provider reason arrays and reasonCodes [HTTP_429]; retry {true,RATE_LIMITED,RATE_LIMITED}; failureClassification RETRY_SCHEDULED | Pre-fence recovery cannot carry RETRY_SCHEDULED terminal classification; create-return decode |
| Postgres PENDING_FENCE reclaim preserves rich provider and fence evidence | PENDING_FENCE; providerResultStatus TRANSPORT_FAILED; providerObservedAt 2025-12-31T23:01:00.000Z; httpStatus 200; transportOutcome HTTP; hashes C64/D64; all reason arrays []; retry {true,TRANSIENT_TRANSPORT,TRANSIENT_TRANSPORT}; postVerificationWatermark {eventId:5,receivedAt:2025-12-31T23:01:00.000Z}; postRelevantFingerprint {orderHash:ORDER,eventIds:[],events:[],digest:ONE64,orderingAmbiguous:false} | PENDING_FENCE cannot already contain post-fence evidence. Also synthetic transport/provider combination is not produced by the normalizer; create-return decode. |
| Postgres legacy payload policy and non-null final status parity | PENDING_FENCE; providerResultStatus UNKNOWN; finalResultStatus RECONCILIATION_REQUIRED; postVerificationWatermark {eventId:1,receivedAt:2026-01-01T00:00:01.000Z}; postRelevantFingerprint {orderHash:ORDER,eventIds:[],events:[],digest:ZERO64,orderingAmbiguous:false}; semanticEvidenceHash = operationalSemanticEvidenceHash(that exact original fixture) | PENDING_FENCE cannot contain final/hash/post evidence; create-return decode. Legacy missing-field negative cases themselves remain intentionally malformed. |

The full semantic hash in the last row is defined by the original record's exact material, not recomputed or repaired during admission.

## Repair approach

Use the existing trusted-context fixture and accepted adapter/normalizer to obtain provider results, then project their fields as the worker does. Generate complete post-fence records through the accepted production journal fence. Keep exact canonical attempt/idempotency material. Preserve CAS/reclaim/throttle production code and deliberate malformed-payload tests.

## Completed fixture repairs

- The generic lifecycle-only fixture was replaced with explicit builders for NOT_STARTED, REQUEST_PENDING, RESPONSE_OBSERVED, PENDING_FENCE, COMPLETE, RETRY_EXHAUSTED, REQUEST_OUTCOME_UNCERTAIN, EXECUTION_FAILED, RETRY_SCHEDULED, STALE, and RECONCILIATION_REQUIRED.
- Builders use captured real worker/store stages. Synthetic HTTP responses are interpreted through the accepted adapter and normalizer against the existing trusted-context helper. Stable/reconciliation results use the production fence bridge. STALE uses the existing explicit test-only stale-fence seam. REQUEST_OUTCOME_UNCERTAIN is captured after actual claim expiry/reclaim; EXECUTION_FAILED is captured after a synthetic credential-provider exception.
- Valid fixtures retain the trusted chain, collection, contract, protocol, sweep, artifacts, versions, and journal snapshot. Test labels map to distinct attempt numbers; both identities are derived with the production algorithms. New semantic hashes are computed for these newly constructed fixture records, never repaired during durable admission.
- Create/get/claim/CAS parity now proposes a captured COMPLETE semantic record even for the wrong-token CAS. Recovery/reclaim/CAS uses a genuine RATE_LIMITED provider and equal reason arrays throughout. The recovery-claim test also replaces its previously admitted but non-normalizer-derived UNKNOWN/429 combination.
- Both listDue tests use provider-observed builders for recovery stages. The existing ownership/due cases and expected result membership remain covered.
- CAS expiry/takeover now proposes valid RETRY_SCHEDULED and RETRY_EXHAUSTED records so a failed CAS proves ownership/expiry rejection rather than malformed-input rejection.
- Successful fail now uses the actual pre-provider EXECUTION_FAILED form, preserving null provider/final/hash/post fields.
- Terminal-claim tests use complete/failed builders. The terminal-current-row CAS test deliberately retains an injected terminal lease to test the SQL lifecycle predicate; its semantic record and proposed recovery payload are valid.
- Rich RESPONSE_OBSERVED reclaim uses an INACTIVE_CONFIRMED result with normalized order, response/artifact hashes, equal empty reasons, and null failure classification.
- Rich PENDING_FENCE reclaim preserves provider and pre-fence evidence while requiring post-fence fields, final status, and hash to remain null. Keeping post evidence here would contradict the strict stage contract.
- Non-null final/hash parity now uses a captured FAILED/RECONCILIATION_REQUIRED record. Legacy absent-field tests remain unchanged in intent. Corruption tests still reject stale hashes and missing final/hash fields; the stricter stage check rejects the latter earlier with INVALID_OPERATIONAL_RECORD.
- Added a direct provider-projection self-check, 11 positive lifecycle-family cases, and 22 negative cases through both InMemory admission and raw PostgreSQL get/decode. All original 16 test names remain.

## Scope and outcome

BR6A made **zero production edits**. The incoming uncommitted operational-worker diff remains intact (6 insertions / 2 deletions relative to baseline). No admission rule, context check, CAS, reclaim, throttle, or accepted verifier file was weakened or changed in this task. No bypass was added.

At the BR6A task boundary, the fixture repair passed but the complete suite still failed the existing worker test `maxAttempts=2 exhausts child one without creating child two`: expected failureClassification RETRY_EXHAUSTED, actual null. Retry/context remediation was explicitly excluded from BR6A, so that turn correctly ended Outcome B without commit or push. BR6B subsequently repaired that separate path; the combined BR6A/BR6B tree passes the complete suite and is eligible for one combined commit.

No commit, push, reset, or history rewrite was performed during BR6A. Remote main was verified at the baseline with git ls-remote. The prior br6.txt remained outside the BR6A changes.
