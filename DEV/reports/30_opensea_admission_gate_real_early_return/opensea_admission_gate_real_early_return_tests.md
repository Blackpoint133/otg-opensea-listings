# Task 30 — executable test and gate record

## Permanent coverage

- Positive complete canonical Listing reaches `ACTIVE_CONFIRMED`.
- Independent deletion tests cover `price`, `type`, `counter`, `consideration`, `offerer`, and `remaining_quantity`.
- Separate status tests cover missing `remaining_quantity` for ACTIVE, INACTIVE, FULFILLED, CANCELLED, and EXPIRED.
- Zero quantity remains schema-valid and yields `UNKNOWN / ACTIVE_QUANTITY_UNPROVEN`.
- State-leak sequence covers schema-invalid, valid, then HTTP 404.
- Parseable malformed shapes (missing offer, empty offer, wrong item, missing parameters, missing asset) fail without throwing.
- Existing numeric-type, temporal, and quantity regressions were corrected rather than skipped.

## Fixture workflow

`providerResultFixtures.ts` no longer repairs by default. Its shorthand normalization is opt-in for historical provenance fixtures; admission negatives encode the mutated object directly and never pass through that repair path. No OpenAPI extractor or fixture was changed.

## Gate results

`npm test`: 770 tests, 770 pass, 0 fail, 0 skipped; duration 6,757.835 ms (hermetic runner output).

`npm run build`: PASS.

`npm run typecheck`: PASS.

`git diff --check`: PASS.

The runtime source contains no `schemaAdmissionFailed`; `openSeaExactOrderAdapter.ts` contains the direct `validateOfficialListingRequired(o)` call, and the normalizer accepts `OFFICIAL_SCHEMA_INVALID`.

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE
