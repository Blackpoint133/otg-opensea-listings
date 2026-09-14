# Task 71FR2 — Production ingestion fatal-integrity closure

Task 71FR retained the production pending-readiness policy, continuous worker pump, inserted-pending wake, and bounded ingress. It still logged durable-persistence failures and Stream SDK errors without poisoning continuity, and the entrypoint waited only on operator signals.

This remediation adds one idempotent fail-closed termination path. A received event that cannot be persisted terminates with `INGRESS_PERSISTENCE_FAILURE`; an unproven Stream error terminates with `STREAM_ERROR`; worker exceptions terminate with `WORKER_ERROR`; and ingress capacity exhaustion terminates with `INGRESS_OVERLOAD`. The first fatal reason is retained, acceptance stops immediately, admitted work drains, Stream disconnect is bounded, and controller/pool cleanup completes.

`waitForTermination()` is the runtime-owned terminal promise. Operator stop is non-fatal; fatal termination causes the manual entrypoint to set `process.exitCode = 1` only after cleanup. No production ingestion was executed, and no baseline, generation, shadow, Fence B, or mutation behavior was added.
