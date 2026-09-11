# Task 31 — pin verification evidence

## Executed checks

- Verified local HEAD equals baseline `c02c406c5c20e5964038bbfa5db8fcd66382ede2` and the starting worktree was clean.
- Retrieved only the public OpenAPI documentation URL as raw bytes using a development-only process.
- Calculated SHA-256 over the exact downloaded bytes before any schema parsing.
- Observed `581930` bytes and SHA-256 `f9b79429a3e7b095785f14b36171dcc4fb769a5a7ee04685f6e81ff742a7e18e`.
- Compared against required pin `590486` bytes and SHA-256 `feeb155c9a12fe05e332177014a9d8e7e9ab37fe008c8f37d9bd17c5185cf922`: mismatch.
- Searched tracked Git paths for a complete pinned OpenAPI source copy; none exists.
- Removed the downloaded temporary file.

## Gates not run

Build, typecheck, and npm test were not run because TASK-31 mandates an immediate outcome C when the current public bytes differ and no exact pinned source copy exists. No runtime, test, extractor, fixture, or contract source was modified.

The extractor/fixture equality, JSON Pointer closure, Price/ConsiderationItem matrices, and schema-derived runtime tests remain pending the pin decision. Reporting them as passed would be unsupported.

HTTP TRANSPORT NOT IMPLEMENTED

LIVE GET ORDER NOT CALLED

API KEY NOT USED

DB/MUTATION NOT USED

DEACTIVATION AUTHORITY = FALSE

C. OFFICIAL OPENAPI PIN CHANGED  DECISION REQUIRED
