# Task 65A.1 PostgreSQL throttle

Replaced the PostgreSQL permit transaction with separate database-time queries: transaction timestamp, expired-permit cleanup, singleton throttle row lock, active permit count, permit insertion, and persistent throttle-state update. The invalid aggregate-plus-`FOR UPDATE` query was removed. Permit release deletes only the active permit, preserving spacing history.

Scope is limited to the PostgreSQL throttle path and direct throttle tests. No worker orchestration, fence, semantic evidence, retry, or listing-state behavior was changed.
