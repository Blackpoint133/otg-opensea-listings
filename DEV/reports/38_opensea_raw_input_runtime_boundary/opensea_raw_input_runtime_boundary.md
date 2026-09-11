# Task 38 — raw input runtime boundary remediation

Baseline: `54a3373d925cba510c66f02adf61393af80dc0e7`.

Task-37 identified two concrete exceptions: `httpStatus: Symbol()` reached a
numeric comparison, and `body: Symbol()` reached `new Uint8Array(...)`. The
adapter now validates transport outcome and HTTP status primitives before status
classification, accepts only byte bodies on the HTTP-200 body path, and
sanitizes failure-factory metadata. Invalid status/body/transport/hash values are
never copied into trusted observations. Timing shape is validated before use and
only semantically valid timing is retained. Task-36 header validation remains the
first guard before all header lookups.

Status-before-body precedence is preserved: 503/404/429 and timeout/reset return
their existing classifications even when the supplied body is a Symbol. Missing
or null body retains the established missing-body behavior. No broad catch-all was
introduced; the trusted-context exception remains deliberate.

The adapter version is `opensea-exact-order-adapter-v9-2026-09` (from v8). Provider
contract, normalizer, policy, durable schema, candidate, envelope, generation, and
barrier versions remain unchanged. Immutable Task-32 OpenAPI evidence and prior
reports were untouched.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
