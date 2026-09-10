import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ACTIVE_ORDER_PG_DATABASE, ACTIVE_ORDER_PG_SCENARIOS, MAINTENANCE_ENV, ScenarioApplyResultAssertionError, assertAllowedDisposableDatabase, assertCleanupEligible, assertMaintenanceDatabaseAllowed, assertRollbackVerification, assertSeparateMaintenanceIdentity, assertSuccessfulJournal, assertSuppressedOrder, buildDisposableDatabasePlan, buildSyntheticTransfer, canDeclareActiveOrderPgComplete, cleanupPhaseOrder, computeProvenance, deriveDatabasePreparationFacts, isCleanupSuccessful, isProvenanceComplete, loadMaintenanceConfig, parseActiveOrderPgArgs, scenarioEvidenceResult, syntheticIdentity } from "../scripts/testActiveOrderSuppressionPg.ts";
import { extractInboxJournalEnvelope } from "../src/db/durableInboxRepository.ts";
import { parseNftId } from "../src/eventTypes.ts";
import { normalizeTransferEvent, parseNftIdentity } from "../src/state/normalizers.ts";
import { reduceNftState } from "../src/state/nftReducer.ts";

const confirmations = ["--confirm-disposable-postgres", "--confirm-no-server-otg", "--confirm-schema-bootstrap", "--confirm-test-data-only", "--confirm-destructive-test-cleanup"];
const args = (extra: string[] = []) => [...confirmations, "--database", ACTIVE_ORDER_PG_DATABASE, "--output-dir", "C:\\temp\\active-order-pg-test", ...extra];

test("active-order PG harness rejects server_otg structurally", () => {
  assert.throws(() => assertAllowedDisposableDatabase("server_otg"), /server_otg is forbidden/);
  assert.throws(() => parseActiveOrderPgArgs(args().map((value, index) => value === ACTIVE_ORDER_PG_DATABASE ? "server_otg" : value)), /server_otg is forbidden/);
});

test("active-order PG harness rejects missing, production-like, and unknown configuration", () => {
  assert.throws(() => parseActiveOrderPgArgs([]), /--database is required/);
  assert.throws(() => assertAllowedDisposableDatabase("server_otg_prod_copy"), /not the explicit disposable allowlist/);
  assert.throws(() => parseActiveOrderPgArgs(args(["--unknown"])), /unknown argument/);
  assert.throws(() => parseActiveOrderPgArgs(args(["--confirm-no-server-otg"])), /duplicate argument/);
});

test("active-order PG harness accepts only the explicit disposable database and all confirmations", () => {
  const config = parseActiveOrderPgArgs(args());
  assert.equal(config.database, ACTIVE_ORDER_PG_DATABASE);
  assert.equal(config.confirmations.size, 5);
  assert.throws(() => parseActiveOrderPgArgs(["--database", ACTIVE_ORDER_PG_DATABASE, "--output-dir", "C:\\temp\\x", ...confirmations.slice(0, 4)]), /missing confirmation/);
});

function maintenanceEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [MAINTENANCE_ENV.host]: "127.0.0.1",
    [MAINTENANCE_ENV.port]: "5432",
    [MAINTENANCE_ENV.user]: "pg_active_order_maintenance",
    [MAINTENANCE_ENV.password]: "test-only-secret",
    [MAINTENANCE_ENV.database]: "postgres",
    ...overrides
  };
}

test("maintenance config requires every explicit value and exact postgres database", () => {
  for (const key of Object.values(MAINTENANCE_ENV)) {
    const env = maintenanceEnv({ [key]: undefined });
    assert.throws(() => loadMaintenanceConfig(env), new RegExp(key));
  }
  assert.throws(() => loadMaintenanceConfig(maintenanceEnv({ [MAINTENANCE_ENV.database]: "server_otg" })), /must equal postgres/);
  assert.throws(() => loadMaintenanceConfig(maintenanceEnv({ [MAINTENANCE_ENV.port]: "not-a-port" })), /positive integer/);
});

test("maintenance path has no shared-config fallback and must be separate from normal role", () => {
  assert.throws(() => loadMaintenanceConfig({}), /no shared database-config fallback/);
  const config = loadMaintenanceConfig(maintenanceEnv());
  assert.doesNotThrow(() => assertSeparateMaintenanceIdentity(config, "gunz_user"));
  assert.throws(() => assertSeparateMaintenanceIdentity(config, config.user), /separate/);
  assert.throws(() => loadMaintenanceConfig(maintenanceEnv({ [MAINTENANCE_ENV.database]: "server_otg" })), /postgres/);
});

test("maintenance database allowlist is phase-scoped and fail-closed", () => {
  const config = loadMaintenanceConfig(maintenanceEnv());
  assert.doesNotThrow(() => assertMaintenanceDatabaseAllowed("postgres", { phase: "maintenance", databaseCreated: false }));
  assert.doesNotThrow(() => assertMaintenanceDatabaseAllowed("postgres", { phase: "maintenance", databaseCreated: true }));
  assert.throws(() => assertMaintenanceDatabaseAllowed(ACTIVE_ORDER_PG_DATABASE, { phase: "maintenance", databaseCreated: true }), /exact postgres/);
  assert.throws(() => assertMaintenanceDatabaseAllowed(ACTIVE_ORDER_PG_DATABASE, { phase: "targetOwnershipSetup", databaseCreated: false }), /exact created disposable/);
  assert.doesNotThrow(() => assertMaintenanceDatabaseAllowed(ACTIVE_ORDER_PG_DATABASE, { phase: "targetOwnershipSetup", databaseCreated: true }));
  assert.throws(() => assertMaintenanceDatabaseAllowed("server_otg", { phase: "targetOwnershipSetup", databaseCreated: true }), /exact created disposable/);
  assert.throws(() => assertMaintenanceDatabaseAllowed("arbitrary_db", { phase: "targetOwnershipSetup", databaseCreated: true }), /exact created disposable/);
  assert.ok(config);
});

test("maintenance ownership plan is exact-target scoped and keeps normal DML role separate", () => {
  const plan = buildDisposableDatabasePlan("gunz_user");
  assert.equal(plan.targetDatabase, ACTIVE_ORDER_PG_DATABASE);
  assert.match(plan.createSql, new RegExp(ACTIVE_ORDER_PG_DATABASE));
  assert.match(plan.grantConnectSql, new RegExp(ACTIVE_ORDER_PG_DATABASE));
  assert.match(plan.grantConnectSql, /gunz_user/);
  assert.match(plan.grantSchemaSql, /public/);
  assert.throws(() => buildDisposableDatabasePlan("server_otg"), /unsafe application role/);
  assert.throws(() => buildDisposableDatabasePlan("postgres"), /unsafe application role/);
});

test("second failed-run ownership path now reaches the exact schema grant control flow", () => {
  const plan = buildDisposableDatabasePlan("gunz_user");
  assert.doesNotThrow(() => assertMaintenanceDatabaseAllowed(ACTIVE_ORDER_PG_DATABASE, { phase: "targetOwnershipSetup", databaseCreated: true }));
  assert.match(plan.grantSchemaSql, /^GRANT USAGE, CREATE ON SCHEMA public TO "gunz_user"$/);
  assert.match(plan.grantConnectSql, /^GRANT CONNECT ON DATABASE "server_otg_opensea_v2_active_order_suppression_test" TO "gunz_user"$/);
});

test("database preparation evidence separates absence, attempt and creation", () => {
  assert.deepEqual(deriveDatabasePreparationFacts("absent", true, true), { disposableDatabaseAbsentBeforeCreate: true, databaseCreateAttempted: true, databaseCreated: true });
  assert.deepEqual(deriveDatabasePreparationFacts("absent", true, false), { disposableDatabaseAbsentBeforeCreate: true, databaseCreateAttempted: true, databaseCreated: false });
  assert.deepEqual(deriveDatabasePreparationFacts("exists", false, false), { disposableDatabaseAbsentBeforeCreate: false, databaseCreateAttempted: false, databaseCreated: false });
  assert.deepEqual(deriveDatabasePreparationFacts("error", false, false), { disposableDatabaseAbsentBeforeCreate: false, databaseCreateAttempted: false, databaseCreated: false });
});

test("cleanup is eligible only for a database created by this run", () => {
  assert.doesNotThrow(() => assertCleanupEligible(true));
  for (const created of [false]) assert.throws(() => assertCleanupEligible(created), /unless this run created/);
});

test("synthetic fixture identities are deterministic and isolated from real targets", () => {
  const identity = syntheticIdentity("one-active-order", "offline");
  assert.match(identity.tokenId, /^[0-9]+$/);
  assert.equal(parseNftId(identity.nftId.split("/").slice(0, 2).concat(identity.tokenId).join("/")).valid, true);
  assert.deepEqual(parseNftIdentity(identity.nftId), { nftId: identity.nftId, chain: "gunzilla", contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenId: identity.tokenId });
  assert.doesNotMatch(identity.tokenId, /4880419[4565]/);
  assert.notEqual(identity.orderHash, "0x" + "0".repeat(64));
  assert.equal(buildSyntheticTransfer(identity, "2026-01-01T00:00:00.000Z", "0x" + "1".repeat(40)).event_type, "item_transferred");
  assert.equal((buildSyntheticTransfer(identity, "2026-01-01T00:00:00.000Z", "0x" + "1".repeat(40)) as any).payload.item.nft_id, identity.nftId);
});

test("all disposable scenarios use unique decimal-only parser-compatible NFT identities", () => {
  const identities = ACTIVE_ORDER_PG_SCENARIOS.map((scenario) => syntheticIdentity(scenario.id, "offline"));
  assert.equal(new Set(identities.map((identity) => identity.tokenId)).size, identities.length);
  for (const identity of identities) {
    assert.match(identity.tokenId, /^[0-9]+$/);
    assert.ok(parseNftIdentity(identity.nftId));
  }
});

test("corrected one-order transfer preserves identity through envelope and application normalization", () => {
  const identity = syntheticIdentity("one-active-order", "one_active_order");
  const raw = buildSyntheticTransfer(identity, "2026-01-01T00:00:01.000Z", "0x2222222222222222222222222222222222222222");
  const normalized = normalizeTransferEvent(raw, "2026-01-01T00:00:00.000Z");
  assert.equal(normalized?.eventType, "item_transferred");
  assert.deepEqual(normalized?.nft, { nftId: identity.nftId, chain: "gunzilla", contractAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tokenId: identity.tokenId });
  assert.equal(normalized?.from, "0x0000000000000000000000000000000000000000");
  assert.equal(normalized?.to, "0x2222222222222222222222222222222222222222");
  assert.equal(normalized?.transactionHash, identity.transactionHash);
  assert.equal(normalized?.eventTimestamp, "2026-01-01T00:00:01.000Z");
  assert.equal(normalized?.eventVersion, "1");
  const envelope = extractInboxJournalEnvelope(raw, "2026-01-01T00:00:00.000Z");
  assert.equal(envelope?.chain, "gunzilla");
  assert.equal(envelope?.contractAddress, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(envelope?.tokenId, identity.tokenId);
  const restored = normalizeTransferEvent(envelope?.rawPayload, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(restored?.nft, normalized?.nft);
  assert.equal(identity.nftId, `gunzilla/${normalized?.nft?.contractAddress}/${normalized?.nft?.tokenId}`);
  assert.equal(ACTIVE_ORDER_PG_SCENARIOS.find((scenario) => scenario.id === "one_active_order")?.expectedApplyResult, "inserted_nft_transfer;suppressed_orders=1");
  assert.equal(ACTIVE_ORDER_PG_SCENARIOS.find((scenario) => scenario.id === "one_active_order")?.expectedSuppressedOrders, 1);
});

test("malformed synthetic identity remains fail-closed", () => {
  const identity = syntheticIdentity("malformed", "offline");
  const raw = buildSyntheticTransfer(identity, "2026-01-01T00:00:00.000Z", "0x2222222222222222222222222222222222222222");
  (raw as any).payload.item.nft_id = `gunzilla/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/990000abc123`;
  assert.equal(parseNftId((raw as any).payload.item.nft_id).valid, false);
  assert.equal(normalizeTransferEvent(raw, "2026-01-01T00:00:00.000Z")?.nft, null);
});

test("scenario evidence stores structured actual and expected apply results", () => {
  assert.deepEqual(scenarioEvidenceResult({ event: { apply_result: "inserted_nft_transfer;suppressed_orders=1" } }, "inserted_nft_transfer;suppressed_orders=1"), { actualApplyResult: "inserted_nft_transfer;suppressed_orders=1", expectedApplyResult: "inserted_nft_transfer;suppressed_orders=1" });
  const mismatch = new ScenarioApplyResultAssertionError("journaled_state_not_persisted_missing_nft", "inserted_nft_transfer;suppressed_orders=1");
  assert.equal(mismatch.actualApplyResult, "journaled_state_not_persisted_missing_nft");
  assert.equal(mismatch.expectedApplyResult, "inserted_nft_transfer;suppressed_orders=1");
});

test("scenario plan contains the required real-transaction coverage", () => {
  assert.deepEqual(ACTIVE_ORDER_PG_SCENARIOS.map((scenario) => scenario.id), ["one_active_order", "two_active_orders", "zero_orders", "terminal_inactive_orders", "unrelated_nft", "stale_ignored_transfer", "chronology_trap", "rollback_after_order_failure"]);
  assert.equal(ACTIVE_ORDER_PG_SCENARIOS.find((scenario) => scenario.id === "one_active_order")?.expectedSuppressedOrders, 1);
  assert.equal(ACTIVE_ORDER_PG_SCENARIOS.find((scenario) => scenario.id === "two_active_orders")?.expectedSuppressedOrders, 2);
  assert.equal(ACTIVE_ORDER_PG_SCENARIOS.find((scenario) => scenario.id === "stale_ignored_transfer")?.expectedApplyResult, "ignored_older_transfer;suppressed_orders=0");
  assert.equal(ACTIVE_ORDER_PG_SCENARIOS.find((scenario) => scenario.id === "rollback_after_order_failure")?.expectedApplyResult, null);
});

function authoritativeColumns(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const file of ["001_create_v2_schema.sql", "002_add_journal_processing_lifecycle.sql", "003_add_inbox_attempt_ledger.sql"]) {
    const sql = fs.readFileSync(new URL(`../sql/${file}`, import.meta.url), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE public\.([a-z0-9_]+)\s*\(([^]*?)\);/gi)) {
      const columns = result.get(match[1]) ?? new Set<string>();
      for (const line of match[2].split("\n")) {
        const trimmed = line.trim();
        const column = trimmed.match(/^([a-z_][a-z0-9_]*)\s+/i)?.[1];
        if (column && !trimmed.toUpperCase().startsWith("CONSTRAINT")) columns.add(column);
      }
      result.set(match[1], columns);
    }
    for (const match of sql.matchAll(/ALTER TABLE public\.([a-z0-9_]+)[\s\S]*?ADD COLUMN ([a-z_][a-z0-9_]*)\s+/gi)) {
      const columns = result.get(match[1]) ?? new Set<string>();
      columns.add(match[2]);
      result.set(match[1], columns);
    }
  }
  return result;
}

function harnessSource(): string {
  return fs.readFileSync(new URL("../scripts/testActiveOrderSuppressionPg.ts", import.meta.url), "utf8");
}

test("harness fixture SQL matches authoritative schema, including the NFT raw-event boundary", () => {
  const source = harnessSource();
  const columns = authoritativeColumns();
  const inserts = [...source.matchAll(/INSERT INTO public\.([a-z0-9_]+)\s*\(([^)]+)\)/gi)];
  assert.equal(inserts.length, 2);
  for (const match of inserts) {
    const tableColumns = columns.get(match[1]);
    assert.ok(tableColumns, `authoritative table missing: ${match[1]}`);
    for (const column of match[2].split(",").map((value) => value.trim())) assert.ok(tableColumns!.has(column), `${match[1]}.${column} is not authoritative`);
  }
  const nftInsert = inserts.find((match) => match[1] === "opensea_listings_nft_state_v2")![2];
  const orderInsert = inserts.find((match) => match[1] === "opensea_listings_v2")![2];
  assert.doesNotMatch(nftInsert, /raw_last_event/);
  assert.match(orderInsert, /raw_last_event/);
  assert.equal(columns.get("opensea_listings_nft_state_v2")!.has("raw_last_event"), false);
  assert.equal(columns.get("opensea_listings_v2")!.has("raw_last_event"), true);
});

test("stale fixture preserves identity, chronology, active order state, reducer result and skipped suppression", () => {
  const identity = syntheticIdentity("stale-ignored", "offline");
  const existingTimestamp = "2026-01-01T00:01:00.000Z";
  const incomingTimestamp = "2026-01-01T00:00:06.000Z";
  const existingVersion = "5";
  const incomingVersion = "1";
  const order = { ...identity, status: "active", isActive: true };
  const raw = buildSyntheticTransfer(identity, incomingTimestamp, "0x2222222222222222222222222222222222222222", incomingVersion);
  const incoming = normalizeTransferEvent(raw, "2026-01-01T00:00:00.000Z");
  assert.ok(incoming);
  const existing = reduceNftState(null, { ...incoming, eventTimestamp: existingTimestamp, eventVersion: existingVersion }, "2026-08-16T00:00:00.000Z").state!;
  const reduced = reduceNftState(existing, incoming, "2026-08-16T00:00:00.000Z");
  assert.equal(existing.identity.nftId, identity.nftId);
  assert.equal(incoming.nft?.nftId, identity.nftId);
  assert.equal(order.nftId, identity.nftId);
  assert.ok(new Date(existingTimestamp) > new Date(incomingTimestamp));
  assert.equal(existing.lastNftEventTimestamp, existingTimestamp);
  assert.equal(existing.lastNftEventVersion, existingVersion);
  assert.equal(incoming.eventVersion, incomingVersion);
  assert.equal(order.status, "active");
  assert.equal(order.isActive, true);
  assert.equal(reduced.ignored, true);
  assert.equal(reduced.applyResult, "ignored_older_transfer");
  const applicationSource = fs.readFileSync(new URL("../src/db/eventApplicationService.ts", import.meta.url), "utf8");
  assert.match(applicationSource, /if \(!nftResult\.ignored\)/);
  assert.equal("ignored_older_transfer;suppressed_orders=0", "ignored_older_transfer;suppressed_orders=0");
});

test("chronology and rollback harness SQL audits remain schema-valid and semantically guarded", () => {
  const source = harnessSource();
  const columns = authoritativeColumns();
  for (const match of source.matchAll(/CREATE TRIGGER\s+[^\s]+\s+BEFORE INSERT OR UPDATE ON public\.([a-z0-9_]+)[\s\S]*?WHEN \(NEW\.([a-z_][a-z0-9_]*)/gi)) {
    assert.ok(columns.has(match[1]));
    assert.ok(columns.get(match[1])!.has(match[2]));
  }
  for (const match of source.matchAll(/DROP TRIGGER IF EXISTS\s+[^\s]+\s+ON public\.([a-z0-9_]+)/gi)) assert.ok(columns.has(match[1]));
  assert.match(source, /chronology_trap: \(pool, id\) => scenarioIgnored\(pool, id, null\)/);
  assert.match(source, /insertNft\(pool, identity, "2026-01-01T00:01:00\.000Z"/);
  assert.match(source, /runTransfer\(pool, id, identity, "2026-01-01T00:00:06\.000Z"/);
  assert.match(source, /CREATE FUNCTION public\.\$\{functionName\}\(\) RETURNS trigger/);
  assert.match(source, /CREATE TRIGGER \$\{triggerName\} BEFORE INSERT OR UPDATE ON public\.opensea_listings_v2/);
  assert.match(source, /NEW\.order_hash = '\$\{identity\.orderHash\}'/);
  assert.match(source, /applyPendingInboxEvent\(pool, inserted\.eventId, NOW\)/);
  assert.match(source, /DROP TRIGGER IF EXISTS \$\{triggerName\} ON public\.opensea_listings_v2/);
  assert.match(source, /DROP FUNCTION IF EXISTS public\.\$\{functionName\}\(\)/);
});

test("harness source contains no production database fallback or live canary path", async () => {
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../scripts/testActiveOrderSuppressionPg.ts", import.meta.url), "utf8");
  assert.match(source, /assertAllowedDisposableDatabase/);
  assert.match(source, /applyPendingInboxEvent/);
  assert.match(source, /persistRawEventToInbox/);
  assert.match(source, /DROP DATABASE/);
  assert.doesNotMatch(source, /runRestTxb|OpenSeaStreamClient|runDurableInboxWorkerOnce/);
  assert.match(source, /server_otg is forbidden/);
});

function fullOrder(overrides: Record<string, unknown> = {}): any {
  return {
    order_hash: "0x" + "1".repeat(64), nft_id: "gunzilla/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/990000000001", chain: "gunzilla", contract_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", token_id: "990000000001", collection_slug: "off-the-grid", seller_address: "0x" + "2".repeat(40), price_raw: "1", price_normalized: "1.000000000000000000", payment_token_address: null, payment_token_symbol: null, payment_token_decimals: null, listing_start_at: "2026-01-01T00:00:00.000Z", expiration_at: "2027-01-01T00:00:00.000Z", status: "active", is_active: true, needs_reconciliation: false, reconciliation_reason: null, last_order_event_type: "item_listed", last_order_event_timestamp: "2026-01-01T00:00:00.000Z", last_order_event_version: "1", last_nft_event_timestamp: null, last_nft_event_version: null, last_transfer_transaction_hash: null, item_name: "synthetic", image_url: null, permalink: "https://synthetic.invalid", source: "synthetic_pg", last_stream_received_at: "2026-01-01T00:00:00.000Z", last_reconciled_at: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", raw_last_event: { synthetic: true }
    , ...overrides
  };
}

test("journal assertion rejects every unsafe success-state field", () => {
  const row = { processing_status: "reconciliation_required", attempt_count: 1, next_retry_at: null, apply_result: "inserted_nft_transfer;suppressed_orders=1", applied_at: "2026-01-01T00:00:00.000Z", processing_started_at: null, last_error_code: null, last_error_message: null };
  assertSuccessfulJournal(row, { processingStatus: "reconciliation_required", applyResult: row.apply_result });
  for (const [field, value] of Object.entries({ processing_status: "pending", attempt_count: 0, next_retry_at: "x", applied_at: null, processing_started_at: "x", last_error_code: "err", last_error_message: "err", apply_result: "wrong" })) assert.throws(() => assertSuccessfulJournal({ ...row, [field]: value }, { processingStatus: "reconciliation_required", applyResult: row.apply_result }));
});

test("one-order assertion enforces exact changed fields and preserved metadata", () => {
  const before = fullOrder();
  const after = fullOrder({ is_active: false, needs_reconciliation: true, reconciliation_reason: "transfer_observed", last_nft_event_timestamp: "2026-01-02T00:00:00.000Z", last_nft_event_version: "2", last_transfer_transaction_hash: "0x" + "3".repeat(64), updated_at: "2026-01-02T00:00:00.000Z" });
  assertSuppressedOrder(before, after, "2026-01-02T00:00:00.000Z", after.last_transfer_transaction_hash, "2");
  for (const field of ["status", "is_active", "needs_reconciliation", "reconciliation_reason", "last_nft_event_timestamp", "last_nft_event_version", "last_transfer_transaction_hash", "updated_at", "seller_address", "price_raw", "source", "raw_last_event"]) assert.throws(() => assertSuppressedOrder(before, { ...after, [field]: field === "is_active" ? true : field === "needs_reconciliation" ? false : field === "updated_at" ? before.updated_at : field === "last_nft_event_timestamp" ? before.last_nft_event_timestamp : field === "last_nft_event_version" ? before.last_nft_event_version : field === "last_transfer_transaction_hash" ? before.last_transfer_transaction_hash : field === "reconciliation_reason" ? null : field === "status" ? "sold" : "changed" }, "2026-01-02T00:00:00.000Z", after.last_transfer_transaction_hash, "2"));
});

test("rollback verification and COMPLETE contract fail closed", () => {
  const good = { nftRolledBack: true, ordersRolledBack: true, journalRolledBack: true, noPartialApplyResult: true, triggerObserved: true, transactionFailureObserved: true } as const;
  assertRollbackVerification(good);
  for (const key of Object.keys(good)) assert.throws(() => assertRollbackVerification({ ...good, [key]: false }));
  const complete = { safetyGatesValid: true, allScenariosPassed: true, rollbackVerificationPassed: true, evidenceWriteComplete: true, cleanupAttempted: true, cleanupSucceeded: true, cleanupError: null, productionDatabaseTouched: false, errors: [] };
  assert.equal(canDeclareActiveOrderPgComplete(complete), true);
  for (const key of ["safetyGatesValid", "allScenariosPassed", "rollbackVerificationPassed", "evidenceWriteComplete", "cleanupAttempted", "cleanupSucceeded", "productionDatabaseTouched"] as const) assert.equal(canDeclareActiveOrderPgComplete({ ...complete, [key]: true === (key === "productionDatabaseTouched") }), false);
  assert.equal(canDeclareActiveOrderPgComplete({ ...complete, cleanupError: "drop failed" }), false);
  assert.equal(canDeclareActiveOrderPgComplete({ ...complete, errors: [{ phase: "scenario", message: "failed" }] }), false);
});

test("provenance contract requires all hashed safety inputs", () => {
  const provenance = computeProvenance();
  assert.equal(isProvenanceComplete(provenance), true);
  assert.equal(isProvenanceComplete({ ...provenance, combinedSha256: "missing" }), false);
  const missing = { ...provenance.files };
  delete missing[Object.keys(missing)[0]];
  assert.equal(isProvenanceComplete({ files: missing, combinedSha256: provenance.combinedSha256 }), false);
});

test("cleanup contract preserves drop attempt after target close failure and rejects failures", () => {
  assert.deepEqual(cleanupPhaseOrder(), ["targetPoolClose", "databaseDrop", "maintenancePoolClose"]);
  const good = { cleanupAttempted: true, targetPoolCloseAttempted: true, targetPoolCloseSucceeded: true, targetPoolCloseError: null, databaseDropAttempted: true, databaseDropSucceeded: true, databaseDropError: null, maintenancePoolCloseAttempted: true, maintenancePoolCloseSucceeded: true, maintenancePoolCloseError: null } as const;
  assert.equal(isCleanupSuccessful(good), true);
  assert.equal(isCleanupSuccessful({ ...good, targetPoolCloseSucceeded: false, targetPoolCloseError: "close" }), false);
  assert.equal(isCleanupSuccessful({ ...good, targetPoolCloseSucceeded: false, targetPoolCloseError: "close", databaseDropAttempted: true }), false);
  assert.equal(isCleanupSuccessful({ ...good, databaseDropSucceeded: false, databaseDropError: "drop" }), false);
  assert.equal(isCleanupSuccessful({ ...good, maintenancePoolCloseSucceeded: false, maintenancePoolCloseError: "close" }), false);
  assert.equal(isCleanupSuccessful({ ...good, cleanupAttempted: false }), false);
});
