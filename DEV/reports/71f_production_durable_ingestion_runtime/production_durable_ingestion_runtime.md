# Task 71F — Production durable stream ingestion runtime

The production runtime is an explicit, operator-confirmed entrypoint (`ingest:production`). It hard-pins the `all` Stream profile: item listed, cancelled, sold, transferred, invalidate, and revalidate.

Startup validates `server_otg` / `public` and the migration-008 prerequisite tables before constructing the Stream client. Each callback crosses `persistRawEventToInbox`; state application remains exclusively in the accepted `DurableInboxRuntimeController` / `runDurableInboxWorkerOnce` path. The ingress chain is serialized, errors are contained, and shutdown unsubscribes, disconnects, drains ingress, stops the controller, and closes the pool.

This task does not bootstrap Active Listings, run REST or exact-order requests, publish generation evidence, run shadow evaluation, or mutate listings. Transfer applications retain their accepted `reconciliation_required` behavior. `npm start` remains the diagnostic probe entrypoint.
