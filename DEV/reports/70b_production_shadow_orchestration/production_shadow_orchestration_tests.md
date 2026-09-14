# Task 70B — Test and gate evidence

Tests cover durable candidate filtering, current-generation/current-active acquisition, two-pass equality, dry-run no-insert behavior, race suppression, retry-exhausted exclusion, and deterministic sequential batch processing. The later-provider reader uses repeatable-read/read-only acquisition, strict rehydration, exact identity binding, and accepted generation-publication binding. The manual CLI is not executed during this task and no production database, OpenSea request, API key, or listing mutation is used.
