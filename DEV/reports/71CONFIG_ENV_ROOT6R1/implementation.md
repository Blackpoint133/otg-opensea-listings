# Task 71CONFIG-ENV-ROOT6R1

Baseline: `f7af395bd6efe0e31c2d6bbc22211d95e92a02cd`

The default PostgreSQL configuration path now treats the project-local file as authoritative. Relevant ambient `POSTGRES_*` values are compared after trimming; identical values are tolerated as consistency checks, while any difference fails closed with `PRODUCTION_POSTGRES_CONFIG_SOURCE_CONFLICT:<VARIABLE>`. No pool is constructed after a conflict. Explicit callers may continue to provide a controlled environment or file seam.

The project-local resolver remains cwd-independent and shared with OpenSea credential loading. Parent environment files are never consulted by the production database path. Database identity, pool options, timeout behavior, and schema semantics are unchanged.

No live network or database activity occurred, and neither real environment file was modified.
