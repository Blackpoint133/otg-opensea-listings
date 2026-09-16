# Task 71CONFIG-ENV-ROOT6

Baseline: `60732e7cc6cf5a8a542fbea0f9cc5bfeabd3fa28`

The defect was a historical parent-level environment path (`<repository-root>\\..\\.env`) used by production credential and database configuration. This service now has one module-relative boundary, `resolveProjectEnvPath()`, resolving `<repository-root>\\.env` from both source and compiled locations without consulting `process.cwd()` or searching parent directories.

`loadCanonicalProductionOpenSeaApiKey()` now uses that project-local path. Its isolated parsing, single-assignment validation, trimming, and fail-closed ambient-conflict behavior are unchanged. `loadDatabaseConfig()` now parses the same project-local file without dotenv process-environment side effects, while retaining explicit file/environment seams for hermetic callers.

The production ingestion entrypoint and bootstrap CLI continue to inject the explicitly resolved OpenSea credential. Probe/canary configuration modules were redirected to the shared project-local path as well. Remaining `process.env` references in diagnostic probes, test fixtures, and explicit configuration seams are non-production or caller-supplied and do not select a parent `.env`.

No database schema, Stream, ingestion, reconciliation, bootstrap, adoption, authority, or migration behavior changed. Neither real `.env` file was modified and no live operation or secret was accessed or exposed.
