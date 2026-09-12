# Task 49 — corrected single live OpenSea exact-order probe

## Classification

**LIVE_PROBE_PROVIDER_CONTRACT_FINDING**.

Baseline: `020ce64519beda4f8f11db63893f962a512cc4b6`.

The repository root was resolved from Git and the environment path was resolved as `repoRoot/.env` (not by suffix concatenation):

`C:\VAMBAM\Projects\OTG\parsers\parser_opensea_listings_v2\.env`

`PROJECT_ROOT_ENV_PATH_RESOLVED=PASS` and `PROJECT_ROOT_ENV_PRESENT=YES`. The file was parsed in an isolated object; only `OPENSEA_API_KEY` was extracted. Its value was never printed, measured, hashed, persisted, or logged.

## Selected real order

Source: `tests/fixtures/real/item_listed_ordinary.json`.

- chain: `gunzilla`
- protocol: `0x00000000006687982678b03100b9bdc8be440814`
- order hash: `0xfcbac149c380568c692e1dd3f3e3a6c4308c27995b6a43c78d30bf4dc896f9fb`
- contract: `0x9ed98e159be43a8d42b64053831fcae5e4d7d271`
- token: `6394148`

The trusted context was constructed through the accepted production evidence/candidate/generation/reconstruction path. No test helper, clone, database, or mutation path was used.

## Single result

Exactly one production invocation and one OpenSea application request were made. The safe observation summary was:

- HTTP status: `200`
- transport outcome: `HTTP`
- adapter outcome: `MALFORMED`
- reason codes: `OFFICIAL_SCHEMA_INVALID`
- provider status: `null`
- supported listing: `false`
- temporal proof: `UNTRUSTED`
- response body SHA: `null`
- raw artifact hash: `null`
- observedAt/order identity fields from observation: `null` (the adapter rejected before trusted listing evidence)
- authorityGranted: `false`
- deactivationAuthorityGranted: `false`

This is classified as a provider-contract finding. No remediation or second request was attempted.

## Safety

No raw response body, request headers, API key, or `.env` contents were persisted. `.env` remained ignored and untracked. No PostgreSQL, mutation, worker, scheduler, or Active Listings operation occurred. Task-32 immutable evidence was untouched. Production source was unchanged.
