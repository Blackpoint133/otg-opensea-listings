# Task 30 — stateless OpenSea admission gate

Baseline: `ef667507a28e7ee943432b2aa1ede4fa458721b6`.

## Finding and remediation

The pre-fix adapter used module-global `schemaAdmissionFailed` and invoked schema validation as a side effect of reading `order_hash`. A schema-invalid body could therefore still finish with `VALID`; the failure helper only replaced reason codes. The mutable flag also allowed cross-request contamination.

The flag and side-effect accessor were removed. After strict lossless parsing and root/order object checks, `adaptOpenSeaExactOrder` now executes the direct early return:

```ts
const o = ...;
if (!validateOfficialListingRequired(o))
  return failure(i, "MALFORMED", ["OFFICIAL_SCHEMA_INVALID"]);
```

This precedes identity, status, quantity, temporal, and targeted-listing interpretation. Failure observations retain `providerStatus: null`, `supportedListing: false`, and `temporalProof: "UNTRUSTED"`.

`OFFICIAL_SCHEMA_INVALID` is now in the closed normalizer reason vocabulary and survives the adapter-observation handoff as `MALFORMED_RESPONSE`, with both authority flags false. No normalizer exception is used for schema-invalid input.

## Fixture and state isolation

The new `openSeaAdmissionRuntimeGate.test.ts` constructs a complete object first, then clones/deletes fields and encodes bytes directly. The reusable provider fixture's shorthand repair is now explicit (`repairShorthand: true`) and is not used by negative admission tests. A regression verifies invalid → valid → 404 requests do not inherit reasons.

The three baseline failures were fixed by making legacy test bodies schema-complete and updating the numeric replacement assertions to mutate compact JSON bytes. Missing `remaining_quantity` is now correctly schema-invalid; present zero remains semantic `ACTIVE_QUANTITY_UNPROVEN`.

OpenAPI extractor/fixture files were intentionally not modified in this narrow task.

## Version and boundaries

Adapter v5 remains: this task completes the already-declared v5 behavior rather than introducing a new durable observation shape. Normalizer/policy versions remain unchanged; adding the closed in-memory reason does not alter durable AttemptEvidence bytes. Candidate/envelope/generation/barrier versions remain unchanged.

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE

## Result

The implementation is ready for source audit after the recorded gates below.
