# Task 71STREAM-DIAG1 — Structured Stream Error Diagnostics

The Stream ingestion fail-closed policy is unchanged. SDK `onError` still increments `streamErrors`, records the fatal reason `STREAM_ERROR`, and initiates the existing shutdown path; no reconnect, retry, grace period, or error-threshold behavior was added.

Runtime failures now use the shared bounded diagnostic serializer. Error objects and plain SDK objects retain safe fields such as name, message, code, errno, syscall, hostname, status, statusCode, reason, and bounded stack material. Nested structures are depth/array/string bounded, circular references and throwing getters are handled safely, and secret-like keys (including token, API key, authorization, cookie, password, `DATABASE_URL`, and connection strings) are redacted. URL credentials and secret-bearing strings are redacted before output.

`ProductionTermination.fatalDiagnostic` stores the first redacted diagnostic for a fatal termination. The first-fatal guard prevents later failures from replacing it. `stream_disconnect_timeout` remains a secondary cleanup warning and cannot overwrite the initiating reason or diagnostic. Normal operator/external stops have no fatal diagnostic unless a prior fatal state exists.

No SDK error object is persisted to the database, journal, or evidence. Diagnostics remain bounded in memory and in runtime log lines.
