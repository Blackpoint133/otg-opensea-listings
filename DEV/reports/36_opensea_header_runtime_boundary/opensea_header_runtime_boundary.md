# Task 36 — malformed header runtime boundary remediation

Baseline: `f4864e7032210862c84f2a8a3232502cb85f8e19`.

Task-35 identified that `hs()` called `x.name.toLowerCase()` before runtime
header validation. A non-string name therefore escaped the coercing regex and
then raised a TypeError instead of producing trusted fail-closed evidence.

The adapter now validates a present `headers` value as an array of non-null
objects with string `name` and `value`, valid HTTP token names, and values without
CR/LF before any lookup. `hs()` accepts only this validated runtime-header type.
`headers === undefined` retains its prior meaning. No broad catch was added.

Malformed containers, entries, primitive names/values, empty names, and CR/LF
values return `MALFORMED` / `HEADER_INVALID` with untrusted temporal and authority
flags. Valid ordered headers continue through existing Content-Type, encoding,
Date, Age, Content-Length, hash, and semantic processing unchanged.

The adapter version was bumped from `opensea-exact-order-adapter-v7-2026-09` to
`opensea-exact-order-adapter-v8-2026-09`. Provider contract, normalizer, policy,
durable schema, candidate, envelope, generation, and barrier versions are
unchanged.

Immutable Task-32 OpenAPI evidence and all historical reports remain untouched.

HTTP TRANSPORT NOT IMPLEMENTED
LIVE GET ORDER NOT CALLED
API KEY NOT USED
DB/MUTATION NOT USED
DEACTIVATION AUTHORITY = FALSE
