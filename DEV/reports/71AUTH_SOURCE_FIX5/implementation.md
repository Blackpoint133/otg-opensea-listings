# Task 71AUTH-SOURCE-FIX5

Baseline: `08b60c25d48e29051525517c2631c8b5f982e9e4`

The production credential-source defect was ambient `process.env` precedence over the repository-adjacent canonical secret file. A module-relative loader now reads exactly `<repository-root>\\..\\.env` directly, parses it in isolation, requires one non-empty assignment, and rejects differing ambient values with `PRODUCTION_OPENSEA_API_KEY_SOURCE_CONFLICT`. Identical ambient values are accepted only as a consistency check; the file value remains authoritative.

`ProductionIngestionRuntime` now requires an explicitly injected API key and has no ambient fallback. The production ingestion script loads and injects the canonical key explicitly. The bootstrap CLI uses the same loader and no longer performs independent dotenv/environment precedence.

Production consumers were audited: durable ingestion and bootstrap are canonical-loader boundaries; Active Listings and other diagnostic/development paths continue to require explicitly supplied keys or remain out of production scope. Stream lifecycle, guard, worker, reconciliation, and authority semantics were unchanged.

No live OpenSea request, database access, credential rotation, or `.env` modification occurred.
