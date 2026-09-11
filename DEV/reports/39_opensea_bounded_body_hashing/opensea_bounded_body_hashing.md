# Task 39 — bounded body hashing remediation

Baseline: `13219a183479b9b22d119ffb92543d071fbee0bb`.

The remaining defect was that the generic `failure()` factory hashed any supplied
Uint8Array, including bodies on already-classified 503/404/429/timeout/reset
branches. The HTTP-200 path also computed SHA-256 before checking the 1 MiB cap,
then hashed an oversized body again in failure handling.

The factory now performs no body inspection or hashing and defaults
`responseBodySha256` to null. Status/transport failures therefore do not inspect
irrelevant body bytes. On HTTP 200, body type is checked first, size is checked
before SHA-256, and a bounded body is hashed once. The resulting hash is retained
for the normal valid observation; early and oversize failures carry null. Existing
status precedence, hash comparison, header hardening, timing sanitization, and
authority flags remain unchanged.

Adapter version was bumped from `opensea-exact-order-adapter-v9-2026-09` to
`opensea-exact-order-adapter-v10-2026-09`. Provider contract, normalizer, policy,
durable schema, candidate, envelope, generation, and barrier versions are
unchanged.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
