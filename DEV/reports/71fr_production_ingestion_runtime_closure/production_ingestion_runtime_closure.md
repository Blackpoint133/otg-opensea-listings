# Task 71FR — Production ingestion runtime closure

Task 71F's generic one-hour oldest-pending readiness threshold was unsuitable for the actual drainable production backlog. The production factory now reuses `DurableInboxRuntimeController` with an explicit policy that permits safe pending age/count while retaining fatal failed-row and unrecovered-stale-processing gates. Startup recovery remains the accepted `prepareDurableInboxOnStartup` path.

The runtime now starts one sequential worker pump independent of Stream traffic. It drains pending work continuously, polls after idle, and wakes immediately after `inserted_pending`. Stream ingress only persists through `persistRawEventToInbox`; it never applies state directly.

Ingress uses a fixed-capacity executor. Capacity exhaustion is fatal: Stream acceptance stops, admitted work drains, and shutdown is performed. This runtime does not claim lossless upstream backpressure. Shutdown unsubscribes/disconnects Stream, drains admitted ingress, stops the pump/controller, and closes the pool.

No Active Listings baseline, generation publication, verifier, shadow audit, Fence B, migration 009, or mutation was added or executed.
