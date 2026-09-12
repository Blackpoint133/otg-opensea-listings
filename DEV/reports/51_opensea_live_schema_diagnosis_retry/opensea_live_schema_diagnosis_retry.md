# Task 51 — final live schema diagnosis

## Outcome

Primary classification: **CASE_C_PROVIDER_SCHEMA_DRIFT**.

Baseline: `4a12489da726b062f07cef4a5bffeb885ebce9e5`.

The mandatory offline rehearsal passed completely before network access. The fixture response media type was selected generically as `*/*`, exactly as required. One and only one diagnostic HTTPS request was then made for the previously selected real order.

## Offline rehearsal

All labels passed: `MEDIA_TYPE_SELECTION_PASS`, `LISTING_BRANCH_PASS`, `OFFER_BRANCH_PASS`, `NEITHER_BRANCH_PASS`, `MALFORMED_JSON_PASS`, `FAILURE_PATHS_PASS`, `ADAPTER_OFFLINE_PASS`, and `NO_THROW_PASS`.

The rehearsal covered valid Listing, valid Offer, invalid order, missing envelope, malformed JSON, each required Listing failure path, and adapter handoff without an official-schema failure.

## Live safe evidence

- HTTP status: `200`
- raw response SHA-256: `006fec1a08cf3688442aacc9e8a5d32239fd0de7b405143ec41c82cec09a171b`
- body length: `2451` bytes
- root keys: `order`
- order keys: `asset`, `chain`, `order_created_at`, `order_hash`, `price`, `protocol`, `protocol_address`, `protocol_data`, `remaining_quantity`, `status`, `type`
- price keys: `current`
- protocol_data keys: `parameters`, `signature`
- parameters keys: `conduitKey`, `consideration`, `counter`, `endTime`, `offer`, `offerer`, `orderType`, `salt`, `startTime`, `totalOriginalConsiderationItems`, `zone`, `zoneHash`
- asset keys: `contract`, `identifier`

## Branch results

`TASK32_LISTING_VALID = NO` and `TASK32_OFFER_VALID = NO`; branch classification is `NEITHER`.

Listing failures:

- `order.protocol_data.parameters.counter` — expected integer; actual string; present
- `order.protocol_data.signature` — expected string; actual null; present

Offer failures:

- `order.price.currency` — required; missing
- `order.price.decimals` — required; missing
- `order.price.value` — required; missing
- `order.protocol_data.parameters.counter` — expected integer; actual string; present
- `order.protocol_data.signature` — expected string; actual null; present

`CURRENT_LISTING_ADMISSION = FAIL`.

The same in-memory body reproduced `ADAPTER_OUTCOME = MALFORMED`, `ADAPTER_REASON_CODES = [OFFICIAL_SCHEMA_INVALID]`, and `ADAPTER_REPRODUCED_TASK49 = YES`.

The minimal provider-contract incompatibilities are the string-typed `counter` and null `protocol_data.signature` against the captured schema. No production remediation was performed.

The repository contains no separate installed official Get Order SDK source for an additional offline cross-check; no external lookup was made. The immutable Task-32 fixture remains the authority.

Severity: BLOCKER 0, HIGH 0, MEDIUM 1, LOW 0. Authority and deactivation authority are both `false`.
