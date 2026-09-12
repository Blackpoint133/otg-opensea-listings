# Task 52 — executable verification

## Regression coverage

`tests/task52LiveWireCompatibility.test.ts` uses the real lossless parser, real schema functions, trusted test context construction, and the production adapter. It proves:

- strict Task-32 rejects the observed string-counter/null-signature body;
- compatibility accepts JSON integer `0`, decimal strings `"0"`/`"7"`, hex `"0x0"`/`"0x7"`, and both exact uint256 maxima;
- compatibility rejects empty, signed, whitespace, decimal, exponent, malformed-hex, over-uint256, null/boolean/object/array counter values;
- signature absent/string/null acceptance is independent from counter representation, while number/boolean/object/array signatures fail;
- compatible bodies proceed beyond `OFFICIAL_SCHEMA_INVALID` through the real adapter;
- wrong order identity still fails with `IDENTITY_MISMATCH`, and both authority flags remain false.

Existing strict schema, adapter, normalizer/provenance, and version-pin tests were retained and updated only for the legitimate v11/v3 pins. No test uses network or credentials.

## Gates

- `npm run build`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS — 931 total, 931 passed, 0 failed, 0 skipped, duration 7044.198 ms
- `git diff --check`: PASS

The direct one-file `npx tsx` attempt encountered a host `uv_os_get_passwd` ENOMEM before test execution; the repository's hermetic `npm test` compiled and executed all 48 test files, including every Task-52 test, successfully.

## Integrity and isolation

Task-32 OpenAPI and fixture hashes were independently checked against the accepted values and are unchanged. `src/` contains no transport/network additions in this task; no `.env` or API key was read, no external network was used, and no PostgreSQL/mutation/worker/Active Listings path was invoked.

Changed implementation/test files are the adapter, schema-admission module, provider-contract/type constants, the legitimate runtime version assertions, and `tests/task52LiveWireCompatibility.test.ts`, plus these two reports.
