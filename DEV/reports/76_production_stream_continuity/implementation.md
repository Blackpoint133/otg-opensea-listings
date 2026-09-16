# Task 71STREAM-CONT1 — Production Stream Continuity

Guard-holder identity alone is not delivery continuity. OpenSea Stream delivery is best-effort and missed messages are not replayed; the pinned `@opensea/stream-js` 0.4.0 client uses Phoenix, whose socket/channel machinery can reconnect and rejoin after transport or heartbeat failures. A reconnecting session therefore cannot silently remain a continuous ingestion epoch.

The production runtime now wraps the pinned client with a lifecycle adapter. The adapter validates the expected private SDK shape and fails closed if socket/channel instrumentation cannot be attached. `start()` resolves only after the underlying socket reports OPEN and the exact `collection:off-the-grid` channel reports join acknowledgement, bounded by a 15-second readiness timeout. Subscription registration alone is not readiness.

The adapter records one socket epoch. Any unexpected socket close (including clean server close), socket error, heartbeat teardown, channel error/timeout/close, or second socket OPEN invokes the existing fatal Stream failure path. Phoenix reconnect/rejoin callbacks cannot restore readiness or admit events after the epoch is invalid. Event admission is additionally fenced on the runtime's ready state.

`stop()` marks shutdown expected before unsubscribe/disconnect, so operator stop and external abort remain non-fatal and their lifecycle close/leave callbacks are not misclassified. Disconnect cleanup remains bounded. The existing runtime guard, worker, journal, diagnostics, and fail-closed semantics are unchanged; no deactivation authority is granted.
