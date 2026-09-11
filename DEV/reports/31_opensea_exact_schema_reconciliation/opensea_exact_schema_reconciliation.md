# Task 31 — official OpenAPI pin conflict

Baseline: `c02c406c5c20e5964038bbfa5db8fcd66382ede2`.

## Retrieval result

The public documentation endpoint `https://api.opensea.io/api/v2/openapi.json` was retrieved as exact response bytes on `2026-09-11T06:22:50.8861516Z`. No Get Order request and no authenticated request was made.

Expected repository pin:

- SHA-256: `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922`
- byte length: `590486`

Retrieved official document:

- SHA-256: `f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e`
- byte length: `581930`

The exact bytes therefore do not match the authorized full-document pin. The downloaded temporary file was removed after hashing.

## Pinned-source fallback check

The tracked repository was searched across the current Git tree for an exact full OpenAPI copy. The only related tracked JSON file is `tests/fixtures/opensea_get_order_schema_pin.json`, which is the reduced and currently disputed extracted fixture—not the complete 590486-byte source document. No authoritative reproducible copy of the exact `feeb155…922` source bytes is present.

Per TASK-31 section 2, the schema extractor, committed fixture, runtime admission validator, contract metadata, and versions were not changed. Replacing the pin with the current bytes would require an explicit decision and a new provider-contract review.

## Decision required

Choose one of these inputs before schema reconciliation can proceed:

1. authorize repinning to the current official document `f9b794…e18e`; or
2. provide/commit the authoritative complete OpenAPI document whose exact SHA-256 is `feeb155…922`.

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE

C. OFFICIAL OPENAPI PIN CHANGED  DECISION REQUIRED
