# Task 40 — adapter v10 version identity

Baseline: `c7bab2e8a9bffc93ab4fee11c306125893f91691`.

Independent review found that Task-39 changed observable body-evidence semantics
but the runtime and test pin still declared `opensea-exact-order-adapter-v9-2026-09`.
The historical Task-39 report says v10, although the source at baseline was v9;
that historical report remains unmodified.

The production constant is now exactly
`opensea-exact-order-adapter-v10-2026-09`, and the legitimate runtime metadata
assertion was updated. No Task-39 body hashing, status precedence, raw metadata,
timing, header, admission, identity, quantity, temporal, or provenance semantics
were changed. Provider contract remains `opensea-get-order-v2-2026-09`; normalizer,
policy, durable schema, candidate, envelope, generation, and barrier versions are
unchanged.

Immutable Task-32 OpenAPI evidence and all prior reports were untouched.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
