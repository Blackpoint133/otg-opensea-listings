# Task 50 — live Get Order schema diagnosis

## Outcome

Primary classification: **CASE_D_AMBIGUOUS_CONTRACT_RESULT**.

The single authorized diagnostic request was initiated once, but the temporary in-memory diagnostic runner failed after the response-processing phase before emitting structural results. It selected the immutable fixture media type as `application/json`; the committed fixture actually stores the response content under `*/*`. The runner discarded its in-memory body and no second request is authorized.

Baseline: `2a015071bf881185176a8fbd8632eb382b119d82`.

## Request and safety

Selected order: `tests/fixtures/real/item_listed_ordinary.json`.

- chain: `gunzilla`
- protocol: `0x00000000006687982678b03100b9bdc8be440814`
- order hash: `0xfcbac149c380568c692e1dd3f3e3a6c4308c27995b6a43c78d30bf4dc896f9fb`
- contract: `0x9ed98e159be43a8d42b64053831fcae5e4d7d271`
- token: `6394148`

The request used native HTTPS, fixed `api.opensea.io`, GET, the exact order path, JSON Accept, normal TLS, a 10-second bound, no redirect/retry/decompression, and bounded in-memory collection. The API key was loaded only from the isolated project-root `.env` object and was never output or persisted.

Live diagnostic request count: `1`. No safe HTTP status or response hash was emitted by the failed diagnostic runner; therefore `RAW_RESPONSE_SHA256`, root/order key sets, branch results, and exact failing paths are **NOT RECOVERED**. The prior Task-49 HTTP-200 / `OFFICIAL_SCHEMA_INVALID` result remains the only available provider observation.

## Contract diagnosis status

- `TASK32_LISTING_VALID`: NOT RECOVERED
- `TASK32_OFFER_VALID`: NOT RECOVERED
- branch classification: `CASE_D_AMBIGUOUS_CONTRACT_RESULT`
- `CURRENT_LISTING_ADMISSION`: NOT RECOVERED
- `ADAPTER_REPRODUCED_TASK49`: NOT RECOVERED in this diagnostic run
- current official SDK cross-check: the repository’s accepted SDK contract remains `{ order: Offer | Listing }`; no network or SDK request was made here

The failure is diagnostic-runner-only; no production source or schema was changed and no root-envelope conclusion was drawn.

Authority remains `false`; deactivation authority remains `false`. Raw body was discarded after the failed in-memory analysis and was not written to disk, reports, or evidence.

Severity: BLOCKER 0, HIGH 0, MEDIUM 1 (live provider incompatibility remains unresolved), LOW 0.
