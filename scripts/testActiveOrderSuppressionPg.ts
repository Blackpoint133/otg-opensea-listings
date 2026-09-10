import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { applyPendingInboxEvent } from "../src/db/pendingInboxApplicationService.js";
import { persistRawEventToInbox } from "../src/db/durableInboxRepository.js";
import { loadDatabaseConfig } from "../src/db/pool.js";
import type { DbPool, QueryResult } from "../src/db/types.js";
import { runWriterPreflight } from "../src/writer/preflight.js";

const { Pool } = pg;

export const ACTIVE_ORDER_PG_DATABASE = "server_otg_opensea_v2_active_order_suppression_test" as const;
const PRODUCTION_DATABASE = "server_otg" as const;
const MAINTENANCE_DATABASE = "postgres" as const;
export const MAINTENANCE_ENV = {
  host: "OTG_ACTIVE_ORDER_PG_MAINTENANCE_HOST",
  port: "OTG_ACTIVE_ORDER_PG_MAINTENANCE_PORT",
  user: "OTG_ACTIVE_ORDER_PG_MAINTENANCE_USER",
  password: "OTG_ACTIVE_ORDER_PG_MAINTENANCE_PASSWORD",
  database: "OTG_ACTIVE_ORDER_PG_MAINTENANCE_DATABASE"
} as const;
const CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = "2026-08-16T00:00:00.000Z";
const RECEIVED_AT = "2026-08-15T23:59:59.000Z";
const ZERO = "0x0000000000000000000000000000000000000000";

const REQUIRED_FLAGS = [
  "--confirm-disposable-postgres",
  "--confirm-no-server-otg",
  "--confirm-schema-bootstrap",
  "--confirm-test-data-only",
  "--confirm-destructive-test-cleanup"
] as const;

export type ActiveOrderPgResult = "ACTIVE_ORDER_PG_COMPLETE" | "ACTIVE_ORDER_PG_ABORTED_PREFLIGHT" | "ACTIVE_ORDER_PG_FAILED";

export interface ActiveOrderPgConfig {
  database: string;
  outputDir: string;
  confirmations: ReadonlySet<string>;
}

export interface MaintenanceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: typeof MAINTENANCE_DATABASE;
}

export interface DatabasePreparation {
  disposableDatabaseAbsentBeforeCreate: boolean;
  databaseCreateAttempted: boolean;
  databaseCreated: boolean;
  ownershipSetupValid: boolean;
  errorPhase: string | null;
  error: string | null;
  maintenanceCloseError: string | null;
}

export type DatabaseExistenceObservation = "absent" | "exists" | "error";

export function deriveDatabasePreparationFacts(observation: DatabaseExistenceObservation, createAttempted: boolean, databaseCreated: boolean): Pick<DatabasePreparation, "disposableDatabaseAbsentBeforeCreate" | "databaseCreateAttempted" | "databaseCreated"> {
  if (observation !== "absent") return { disposableDatabaseAbsentBeforeCreate: false, databaseCreateAttempted: false, databaseCreated: false };
  return { disposableDatabaseAbsentBeforeCreate: true, databaseCreateAttempted: createAttempted, databaseCreated: createAttempted && databaseCreated };
}

function requiredMaintenanceValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required; no shared database-config fallback is permitted`);
  return value;
}

export function loadMaintenanceConfig(env: NodeJS.ProcessEnv = process.env): MaintenanceConfig {
  const database = requiredMaintenanceValue(env, MAINTENANCE_ENV.database);
  if (database !== MAINTENANCE_DATABASE) throw new Error(`${MAINTENANCE_ENV.database} must equal ${MAINTENANCE_DATABASE}`);
  const portText = requiredMaintenanceValue(env, MAINTENANCE_ENV.port);
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`${MAINTENANCE_ENV.port} must be a positive integer`);
  return {
    host: requiredMaintenanceValue(env, MAINTENANCE_ENV.host),
    port,
    user: requiredMaintenanceValue(env, MAINTENANCE_ENV.user),
    password: requiredMaintenanceValue(env, MAINTENANCE_ENV.password),
    database
  };
}

export function assertSeparateMaintenanceIdentity(maintenance: MaintenanceConfig, normalUser: string): void {
  if (maintenance.user === normalUser) throw new Error("maintenance role must be separate from the normal application role");
}

export interface DisposableDatabasePlan {
  targetDatabase: typeof ACTIVE_ORDER_PG_DATABASE;
  applicationRole: string;
  createSql: string;
  grantConnectSql: string;
  grantSchemaSql: string;
}

export type MaintenancePoolPhase = "maintenance" | "targetOwnershipSetup";

export interface MaintenancePoolContext {
  authority: "maintenance";
  phase: MaintenancePoolPhase;
  databaseCreated: boolean;
  maintenanceConfig: MaintenanceConfig;
}

export function assertMaintenanceDatabaseAllowed(database: string, context: Pick<MaintenancePoolContext, "phase" | "databaseCreated">): void {
  if (context.phase === "maintenance") {
    if (database !== MAINTENANCE_DATABASE) throw new Error("maintenance context only permits the exact postgres database");
    return;
  }
  if (context.phase === "targetOwnershipSetup" && database === ACTIVE_ORDER_PG_DATABASE && context.databaseCreated) return;
  throw new Error("target ownership context requires the exact created disposable database");
}

function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0")) throw new Error("invalid PostgreSQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildDisposableDatabasePlan(applicationRole: string): DisposableDatabasePlan {
  assertAllowedDisposableDatabase(ACTIVE_ORDER_PG_DATABASE);
  if (applicationRole === PRODUCTION_DATABASE || applicationRole === MAINTENANCE_DATABASE) throw new Error("unsafe application role for disposable ownership setup");
  const target = quoteIdentifier(ACTIVE_ORDER_PG_DATABASE);
  const role = quoteIdentifier(applicationRole);
  return {
    targetDatabase: ACTIVE_ORDER_PG_DATABASE,
    applicationRole,
    createSql: `CREATE DATABASE ${target}`,
    grantConnectSql: `GRANT CONNECT ON DATABASE ${target} TO ${role}`,
    grantSchemaSql: `GRANT USAGE, CREATE ON SCHEMA public TO ${role}`
  };
}

export function assertCleanupEligible(databaseCreated: boolean): void {
  if (!databaseCreated) throw new Error("DROP DATABASE is prohibited unless this run created the exact target database");
}

export interface ScenarioPlan {
  id: string;
  description: string;
  expectedApplyResult: string | null;
  expectedSuppressedOrders: number;
}

export const ACTIVE_ORDER_PG_SCENARIOS: readonly ScenarioPlan[] = [
  { id: "one_active_order", description: "current transfer suppresses one matching active order", expectedApplyResult: "inserted_nft_transfer;suppressed_orders=1", expectedSuppressedOrders: 1 },
  { id: "two_active_orders", description: "current transfer suppresses two matching active orders", expectedApplyResult: "inserted_nft_transfer;suppressed_orders=2", expectedSuppressedOrders: 2 },
  { id: "zero_orders", description: "current transfer preserves zero-order result", expectedApplyResult: "inserted_nft_transfer;suppressed_orders=0", expectedSuppressedOrders: 0 },
  { id: "terminal_inactive_orders", description: "terminal and inactive rows are excluded", expectedApplyResult: "inserted_nft_transfer;suppressed_orders=0", expectedSuppressedOrders: 0 },
  { id: "unrelated_nft", description: "unrelated active NFT order is unchanged", expectedApplyResult: "inserted_nft_transfer;suppressed_orders=0", expectedSuppressedOrders: 0 },
  { id: "stale_ignored_transfer", description: "older NFT transfer leaves active order unchanged", expectedApplyResult: "ignored_older_transfer;suppressed_orders=0", expectedSuppressedOrders: 0 },
  { id: "chronology_trap", description: "stale NFT chronology dominates order chronology", expectedApplyResult: "ignored_older_transfer;suppressed_orders=0", expectedSuppressedOrders: 0 },
  { id: "rollback_after_order_failure", description: "order failure rolls back NFT, order and inbox state", expectedApplyResult: null, expectedSuppressedOrders: 0 }
];

interface Queryable { query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>; }
interface HarnessPool extends DbPool { query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>; }

export interface JournalExpectation {
  processingStatus: string;
  applyResult: string;
}

export class ScenarioApplyResultAssertionError extends Error {
  constructor(public readonly actualApplyResult: string | null, public readonly expectedApplyResult: string) {
    super(`apply result mismatch: actual=${actualApplyResult ?? "null"}; expected=${expectedApplyResult}`);
    this.name = "ScenarioApplyResultAssertionError";
  }
}

export interface RollbackVerification {
  nftRolledBack: boolean;
  ordersRolledBack: boolean;
  journalRolledBack: boolean;
  noPartialApplyResult: boolean;
  triggerObserved: boolean;
  transactionFailureObserved: boolean;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function assertSuccessfulJournal(row: any, expectation: JournalExpectation): void {
  assert.ok(row, "journal row is required");
  assert.equal(row.processing_status, expectation.processingStatus);
  assert.equal(row.attempt_count, 1);
  assert.equal(row.next_retry_at, null);
  assert.equal(row.apply_result, expectation.applyResult);
  assert.ok(row.applied_at);
  assert.equal(row.processing_started_at, null);
  assert.equal(row.last_error_code, null);
  assert.equal(row.last_error_message, null);
}

function comparableOrder(row: any): any {
  return row === null ? null : JSON.parse(JSON.stringify(row));
}

export function assertUnchangedOrder(before: any, after: any): void {
  assert.deepEqual(comparableOrder(after), comparableOrder(before));
}

export function assertSuppressedOrder(before: any, after: any, eventTimestamp: string, transactionHash: string, version = "1"): void {
  assert.ok(before);
  assert.ok(after);
  const allowed = new Set(["is_active", "needs_reconciliation", "reconciliation_reason", "last_nft_event_timestamp", "last_nft_event_version", "last_transfer_transaction_hash", "updated_at"]);
  for (const key of Object.keys(before)) if (!allowed.has(key)) assert.deepEqual(after[key], before[key], `preserved order field changed: ${key}`);
  assert.equal(after.status, "active");
  assert.equal(before.is_active, true);
  assert.equal(after.is_active, false);
  assert.equal(before.needs_reconciliation, false);
  assert.equal(after.needs_reconciliation, true);
  assert.equal(before.reconciliation_reason, null);
  assert.equal(after.reconciliation_reason, "transfer_observed");
  assert.equal(new Date(after.last_nft_event_timestamp).toISOString(), new Date(eventTimestamp).toISOString());
  assert.equal(after.last_nft_event_version, version);
  assert.equal(after.last_transfer_transaction_hash, transactionHash);
  assert.notEqual(after.updated_at, before.updated_at);
}

export function assertNftTransfer(row: any, identity: ReturnType<typeof syntheticIdentity>, timestamp: string, transactionHash: string, owner: string, version = "1"): void {
  assert.ok(row);
  assert.equal(row.chain, "gunzilla");
  assert.equal(row.contract_address, CONTRACT);
  assert.equal(row.token_id, identity.tokenId);
  assert.equal(row.nft_id, identity.nftId);
  assert.equal(row.current_owner_address, owner);
  assert.equal(row.last_transfer_from_address, ZERO);
  assert.equal(row.last_transfer_to_address, owner);
  assert.equal(row.last_transfer_transaction_hash, transactionHash);
  assert.equal(new Date(row.last_transfer_at).toISOString(), new Date(timestamp).toISOString());
  assert.equal(new Date(row.last_nft_event_timestamp).toISOString(), new Date(timestamp).toISOString());
  assert.equal(row.last_nft_event_version, version);
}

export function assertRollbackVerification(verification: RollbackVerification): void {
  for (const [name, value] of Object.entries(verification)) assert.equal(value, true, `rollback verification failed: ${name}`);
}

export interface CompletionContractInput {
  safetyGatesValid: boolean;
  allScenariosPassed: boolean;
  rollbackVerificationPassed: boolean;
  evidenceWriteComplete: boolean;
  cleanupAttempted: boolean;
  cleanupSucceeded: boolean;
  cleanupError: string | null;
  productionDatabaseTouched: boolean;
  errors: readonly unknown[];
}

export function canDeclareActiveOrderPgComplete(input: CompletionContractInput): boolean {
  return input.safetyGatesValid
    && input.allScenariosPassed
    && input.rollbackVerificationPassed
    && input.evidenceWriteComplete
    && input.cleanupAttempted
    && input.cleanupSucceeded
    && input.cleanupError === null
    && input.productionDatabaseTouched === false
    && input.errors.length === 0;
}

function fail(message: string): never { throw new Error(message); }

export function assertAllowedDisposableDatabase(database: string): void {
  if (database === PRODUCTION_DATABASE) throw new Error("server_otg is forbidden for active-order PG integration");
  if (database !== ACTIVE_ORDER_PG_DATABASE) throw new Error(`database is not the explicit disposable allowlist entry: ${database}`);
}

export function parseActiveOrderPgArgs(argv: readonly string[]): ActiveOrderPgConfig {
  let database: string | undefined;
  let outputDir: string | undefined;
  const confirmations = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((REQUIRED_FLAGS as readonly string[]).includes(arg)) {
      if (confirmations.has(arg)) throw new Error(`duplicate argument: ${arg}`);
      confirmations.add(arg);
    } else if (arg === "--database") {
      if (database !== undefined) throw new Error("duplicate --database");
      database = argv[++i];
      if (!database) throw new Error("--database requires a value");
    } else if (arg === "--output-dir") {
      if (outputDir !== undefined) throw new Error("duplicate --output-dir");
      outputDir = argv[++i];
      if (!outputDir) throw new Error("--output-dir requires a value");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!database) throw new Error("--database is required; no PGDATABASE fallback is permitted");
  assertAllowedDisposableDatabase(database);
  if (!outputDir) throw new Error("--output-dir is required");
  for (const flag of REQUIRED_FLAGS) if (!confirmations.has(flag)) throw new Error(`missing confirmation: ${flag}`);
  return { database, outputDir: path.resolve(outputDir), confirmations };
}

export function syntheticIdentity(scenario: string, suffix: string): { tokenId: string; nftId: string; orderHash: string; transactionHash: string; dedupeKey: string } {
  const digest = crypto.createHash("sha256").update(`active-order-pg:${scenario}:${suffix}`).digest("hex");
  const decimalDigest = BigInt(`0x${digest.slice(0, 12)}`).toString(10);
  const tokenId = `990000${decimalDigest}`;
  const nftId = `gunzilla/${CONTRACT}/${tokenId}`;
  return { tokenId, nftId, orderHash: `0x${digest}`, transactionHash: `0x${digest.slice(0, 64)}`, dedupeKey: `active-order-pg:v1:${digest}` };
}

export function buildSyntheticTransfer(identity: ReturnType<typeof syntheticIdentity>, eventTimestamp: string, to: string, version = "1"): Record<string, unknown> {
  return {
    event_type: "item_transferred",
    version,
    payload: {
      event_timestamp: eventTimestamp,
      from_account: { address: ZERO },
      to_account: { address: to },
      item: { nft_id: identity.nftId, metadata: { name: `#${identity.tokenId}`, image_url: null }, permalink: `https://synthetic.invalid/${identity.tokenId}` },
      transaction: { hash: identity.transactionHash, timestamp: eventTimestamp }
    }
  };
}

function poolFor(database: string, context?: MaintenancePoolContext): HarnessPool {
  if (context) {
    if (context.authority !== "maintenance") throw new Error("unsupported pool authority");
    assertMaintenanceDatabaseAllowed(database, context);
    const maintenanceConfig = context.maintenanceConfig;
    const connectionDatabase = context.phase === "maintenance" ? MAINTENANCE_DATABASE : ACTIVE_ORDER_PG_DATABASE;
    return new Pool({ host: maintenanceConfig.host, port: maintenanceConfig.port, database: connectionDatabase, user: maintenanceConfig.user, password: maintenanceConfig.password, connectionTimeoutMillis: 10_000, application_name: "opensea_v2_active_order_suppression_pg_maintenance", options: "-c lock_timeout=2000 -c statement_timeout=15000" }) as unknown as HarnessPool;
  } else {
    assertAllowedDisposableDatabase(database);
  }
  const config = loadDatabaseConfig({ ...process.env, POSTGRES_DB: database });
  return new Pool({ host: config.host, port: config.port, database, user: config.user, password: config.password, connectionTimeoutMillis: config.connectionTimeoutMillis, application_name: "opensea_v2_active_order_suppression_pg", options: "-c lock_timeout=2000 -c statement_timeout=15000" }) as unknown as HarnessPool;
}

async function currentDatabase(client: Queryable): Promise<string> {
  return (await client.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database ?? "";
}

async function assertDisposable(client: Queryable): Promise<void> {
  const database = await currentDatabase(client);
  assertAllowedDisposableDatabase(database);
}

function quoteDisposableIdentifier(value: string): string {
  assertAllowedDisposableDatabase(value);
  return `"${value.replaceAll('"', '""')}"`;
}

async function databaseExists(pool: HarnessPool): Promise<boolean> {
  return Boolean((await pool.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=$1) AS exists", [ACTIVE_ORDER_PG_DATABASE])).rows[0]?.exists);
}

async function setupTargetOwnership(maintenanceConfig: MaintenanceConfig, plan: DisposableDatabasePlan, databaseCreated: boolean): Promise<void> {
  const targetMaintenance = poolFor(ACTIVE_ORDER_PG_DATABASE, { authority: "maintenance", phase: "targetOwnershipSetup", databaseCreated, maintenanceConfig });
  try {
    await assertDisposable(targetMaintenance);
    await targetMaintenance.query(plan.grantSchemaSql);
  } finally {
    await targetMaintenance.end();
  }
}

async function prepareDatabase(maintenanceConfig: MaintenanceConfig, applicationRole: string): Promise<DatabasePreparation> {
  let maintenance: HarnessPool | null = null;
  let disposableDatabaseAbsentBeforeCreate = false;
  let databaseCreateAttempted = false;
  let databaseCreated = false;
  let ownershipSetupValid = false;
  let errorPhase: string | null = "databaseExistenceCheck";
  let error: string | null = null;
  let maintenanceCloseError: string | null = null;
  const plan = buildDisposableDatabasePlan(applicationRole);
  try {
    maintenance = poolFor(MAINTENANCE_DATABASE, { authority: "maintenance", phase: "maintenance", databaseCreated: false, maintenanceConfig });
    assert.equal(await currentDatabase(maintenance), MAINTENANCE_DATABASE);
    if (await databaseExists(maintenance)) throw new Error("disposable database already exists; refusing reuse; recreate it explicitly before a future run");
    disposableDatabaseAbsentBeforeCreate = true;
    databaseCreateAttempted = true;
    errorPhase = "databaseCreate";
    await maintenance.query(plan.createSql);
    databaseCreated = true;
    errorPhase = "targetOwnershipSetup";
    await maintenance.query(plan.grantConnectSql);
    await setupTargetOwnership(maintenanceConfig, plan, databaseCreated);
    ownershipSetupValid = true;
  } catch (caught) {
    error = errorText(caught);
  } finally {
    if (maintenance) {
      try { await maintenance.end(); } catch (caught) { maintenanceCloseError = errorText(caught); }
    }
  }
  return { disposableDatabaseAbsentBeforeCreate, databaseCreateAttempted, databaseCreated, ownershipSetupValid, errorPhase: error ? errorPhase : null, error, maintenanceCloseError };
}

async function bootstrapSchema(pool: HarnessPool): Promise<void> {
  await assertDisposable(pool);
  const root = path.resolve(import.meta.dirname, "..");
  for (const file of ["sql/001_create_v2_schema.sql", "sql/002_add_journal_processing_lifecycle.sql", "sql/003_add_inbox_attempt_ledger.sql"]) {
    await assertDisposable(pool);
    await pool.query(fs.readFileSync(path.join(root, file), "utf8"));
  }
  await runWriterPreflight(pool, { liveWritesEnabled: true, explicitWriterMode: true, maxConcurrency: 1 }, { expectedDatabase: ACTIVE_ORDER_PG_DATABASE });
}

async function insertOrder(pool: HarnessPool, identity: ReturnType<typeof syntheticIdentity>, seller: string, status = "active", isActive = true, lastNftTimestamp: string | null = null): Promise<void> {
  await assertDisposable(pool);
  await pool.query(`INSERT INTO public.opensea_listings_v2 (order_hash,nft_id,chain,contract_address,token_id,collection_slug,seller_address,price_raw,price_normalized,status,is_active,needs_reconciliation,reconciliation_reason,source,raw_last_event,last_nft_event_timestamp) VALUES ($1,$2,'gunzilla',$3,$4,'off-the-grid',$5,'1','1.000000000000000000',$6,$7,false,NULL,'synthetic_pg', '{}'::jsonb,$8)`, [identity.orderHash, identity.nftId, CONTRACT, identity.tokenId, seller, status, isActive, lastNftTimestamp]);
}

async function insertNft(pool: HarnessPool, identity: ReturnType<typeof syntheticIdentity>, timestamp: string, txHash: string, owner: string): Promise<void> {
  await assertDisposable(pool);
  await pool.query(`INSERT INTO public.opensea_listings_nft_state_v2 (chain,contract_address,token_id,nft_id,collection_slug,current_owner_address,last_transfer_from_address,last_transfer_to_address,last_transfer_transaction_hash,last_transfer_at,last_nft_event_timestamp,last_nft_event_version,item_name) VALUES ('gunzilla',$1,$2,$3,'off-the-grid',$4,$5,$4,$6,$7,$7,5,$8)`, [CONTRACT, identity.tokenId, identity.nftId, owner, ZERO, txHash, timestamp, `#${identity.tokenId}`]);
}

async function orderSnapshot(pool: HarnessPool, hashes: readonly string[]): Promise<unknown[]> {
  await assertDisposable(pool);
  return (await pool.query("SELECT order_hash,nft_id,chain,contract_address,token_id,collection_slug,seller_address,price_raw,price_normalized::text AS price_normalized,payment_token_address,payment_token_symbol,payment_token_decimals,listing_start_at::text AS listing_start_at,expiration_at::text AS expiration_at,status,is_active,needs_reconciliation,reconciliation_reason,last_order_event_type,last_order_event_timestamp::text AS last_order_event_timestamp,last_order_event_version::text AS last_order_event_version,last_nft_event_timestamp::text AS last_nft_event_timestamp,last_nft_event_version::text AS last_nft_event_version,last_transfer_transaction_hash,item_name,image_url,permalink,source,last_stream_received_at::text AS last_stream_received_at,last_reconciled_at::text AS last_reconciled_at,created_at::text AS created_at,updated_at::text AS updated_at,raw_last_event FROM public.opensea_listings_v2 WHERE order_hash = ANY($1::text[]) ORDER BY order_hash", [hashes])).rows;
}

async function ordersForNftSnapshot(pool: HarnessPool, identity: ReturnType<typeof syntheticIdentity>): Promise<unknown[]> {
  await assertDisposable(pool);
  return (await pool.query("SELECT order_hash,nft_id,chain,contract_address,token_id,collection_slug,seller_address,price_raw,price_normalized::text AS price_normalized,payment_token_address,payment_token_symbol,payment_token_decimals,listing_start_at::text AS listing_start_at,expiration_at::text AS expiration_at,status,is_active,needs_reconciliation,reconciliation_reason,last_order_event_type,last_order_event_timestamp::text AS last_order_event_timestamp,last_order_event_version::text AS last_order_event_version,last_nft_event_timestamp::text AS last_nft_event_timestamp,last_nft_event_version::text AS last_nft_event_version,last_transfer_transaction_hash,item_name,image_url,permalink,source,last_stream_received_at::text AS last_stream_received_at,last_reconciled_at::text AS last_reconciled_at,created_at::text AS created_at,updated_at::text AS updated_at,raw_last_event FROM public.opensea_listings_v2 WHERE chain=$1 AND contract_address=$2 AND token_id=$3 ORDER BY order_hash", ["gunzilla", CONTRACT, identity.tokenId])).rows;
}

async function nftSnapshot(pool: HarnessPool, identity: ReturnType<typeof syntheticIdentity>): Promise<unknown | null> {
  await assertDisposable(pool);
  return (await pool.query("SELECT chain,contract_address,token_id,nft_id,current_owner_address,last_transfer_from_address,last_transfer_to_address,last_transfer_transaction_hash,last_transfer_at::text,last_nft_event_timestamp::text,last_nft_event_version::text FROM public.opensea_listings_nft_state_v2 WHERE token_id=$1", [identity.tokenId])).rows[0] ?? null;
}

async function journalSnapshot(pool: HarnessPool, eventId: string): Promise<any> {
  await assertDisposable(pool);
  return (await pool.query("SELECT event_id::text,processing_status,attempt_count,processing_started_at::text,last_attempt_at::text,next_retry_at::text,last_error_code,last_error_message,apply_result,applied_at::text FROM public.opensea_listings_events_v2 WHERE event_id=$1", [eventId])).rows[0] ?? null;
}

async function runTransfer(pool: HarnessPool, scenario: string, identity: ReturnType<typeof syntheticIdentity>, timestamp: string, to: string, version = "1"): Promise<{ eventId: string; result: Awaited<ReturnType<typeof applyPendingInboxEvent>> }> {
  const inserted = await persistRawEventToInbox(pool, buildSyntheticTransfer(identity, timestamp, to, version), RECEIVED_AT);
  assert.equal(inserted.outcome, "inserted_pending");
  const result = await applyPendingInboxEvent(pool, inserted.eventId, NOW);
  return { eventId: inserted.eventId, result };
}

async function assertRunJournal(pool: HarnessPool, run: Awaited<ReturnType<typeof runTransfer>>, applyResult: string, processingStatus = "reconciliation_required"): Promise<any> {
  if (run.result.applyResult !== applyResult) throw new ScenarioApplyResultAssertionError(run.result.applyResult, applyResult);
  const journal = await journalSnapshot(pool, run.eventId);
  assertSuccessfulJournal(journal, { processingStatus, applyResult });
  return journal;
}

async function scenarioOne(pool: HarnessPool, id: string): Promise<unknown> {
  const identity = syntheticIdentity("one-active-order", id);
  await insertOrder(pool, identity, "0x1111111111111111111111111111111111111111");
  const beforeRows = await ordersForNftSnapshot(pool, identity);
  assert.equal(beforeRows.length, 1);
  const before = beforeRows[0] as any;
  const run = await runTransfer(pool, id, identity, "2026-01-01T00:00:01.000Z", "0x2222222222222222222222222222222222222222");
  const journal = await assertRunJournal(pool, run, "inserted_nft_transfer;suppressed_orders=1");
  const afterRows = await ordersForNftSnapshot(pool, identity);
  assert.equal(afterRows.length, 1);
  const after = afterRows[0] as any;
  assertSuppressedOrder(before, after, "2026-01-01T00:00:01.000Z", identity.transactionHash);
  assertNftTransfer(await nftSnapshot(pool, identity), identity, "2026-01-01T00:00:01.000Z", identity.transactionHash, "0x2222222222222222222222222222222222222222");
  return { id, event: journal, nft: await nftSnapshot(pool, identity), orders: [after], assertions: { journal: true, order: true } };
}

async function scenarioTwo(pool: HarnessPool, id: string): Promise<unknown> {
  const identity = syntheticIdentity("two-active-orders", id);
  const second = { ...identity, orderHash: `0x${crypto.createHash("sha256").update(`${identity.orderHash}:second`).digest("hex")}` };
  await insertOrder(pool, identity, "0x1111111111111111111111111111111111111111");
  await insertOrder(pool, second, "0x3333333333333333333333333333333333333333");
  const before = await ordersForNftSnapshot(pool, identity);
  assert.equal(before.length, 2);
  const run = await runTransfer(pool, id, identity, "2026-01-01T00:00:02.000Z", "0x2222222222222222222222222222222222222222");
  const journal = await assertRunJournal(pool, run, "inserted_nft_transfer;suppressed_orders=2");
  const after = await ordersForNftSnapshot(pool, identity);
  assert.equal(after.length, 2);
  for (const row of before as any[]) assertSuppressedOrder(row, (after as any[]).find((candidate) => candidate.order_hash === row.order_hash), "2026-01-01T00:00:02.000Z", identity.transactionHash);
  assertNftTransfer(await nftSnapshot(pool, identity), identity, "2026-01-01T00:00:02.000Z", identity.transactionHash, "0x2222222222222222222222222222222222222222");
  return { id, event: journal, nft: await nftSnapshot(pool, identity), orders: after, assertions: { journal: true, orders: true, noThirdOrderMutation: true } };
}

async function scenarioZero(pool: HarnessPool, id: string): Promise<unknown> {
  const identity = syntheticIdentity("zero-orders", id);
  const beforeOrders = await orderSnapshot(pool, []);
  const run = await runTransfer(pool, id, identity, "2026-01-01T00:00:03.000Z", "0x2222222222222222222222222222222222222222");
  const journal = await assertRunJournal(pool, run, "inserted_nft_transfer;suppressed_orders=0");
  assert.deepEqual(beforeOrders, []);
  assert.deepEqual(await orderSnapshot(pool, []), beforeOrders);
  assertNftTransfer(await nftSnapshot(pool, identity), identity, "2026-01-01T00:00:03.000Z", identity.transactionHash, "0x2222222222222222222222222222222222222222");
  return { id, event: journal, nft: await nftSnapshot(pool, identity), orders: [], assertions: { journal: true, zeroMatchingOrders: true } };
}

async function scenarioTerminal(pool: HarnessPool, id: string): Promise<unknown> {
  const identity = syntheticIdentity("terminal-orders", id);
  const rows = ["cancelled", "sold", "invalidated", "expired", "stale", "unknown"].map((status, index) => ({ ...identity, orderHash: `0x${crypto.createHash("sha256").update(`${identity.orderHash}:${status}`).digest("hex")}`, status }));
  for (const [index, row] of rows.entries()) await insertOrder(pool, row, `0x${String(index + 1).repeat(40)}`, row.status, false);
  const inactive = { ...identity, orderHash: `0x${crypto.createHash("sha256").update(`${identity.orderHash}:inactive`).digest("hex")}` };
  await insertOrder(pool, inactive, "0x9999999999999999999999999999999999999999", "active", false);
  const before = await ordersForNftSnapshot(pool, identity);
  assert.equal(before.length, 7);
  const run = await runTransfer(pool, id, identity, "2026-01-01T00:00:04.000Z", "0x2222222222222222222222222222222222222222");
  const journal = await assertRunJournal(pool, run, "inserted_nft_transfer;suppressed_orders=0");
  const after = await ordersForNftSnapshot(pool, identity);
  assert.deepEqual(after, before);
  return { id, event: journal, nft: await nftSnapshot(pool, identity), orders: after, assertions: { journal: true, terminalRowsUnchanged: true } };
}

async function scenarioUnrelated(pool: HarnessPool, id: string): Promise<unknown> {
  const identity = syntheticIdentity("unrelated-target", id);
  const unrelated = syntheticIdentity("unrelated-order", id);
  await insertOrder(pool, unrelated, "0x1111111111111111111111111111111111111111");
  const before = await orderSnapshot(pool, [unrelated.orderHash]);
  const run = await runTransfer(pool, id, identity, "2026-01-01T00:00:05.000Z", "0x2222222222222222222222222222222222222222");
  const journal = await assertRunJournal(pool, run, "inserted_nft_transfer;suppressed_orders=0");
  const after = await orderSnapshot(pool, [unrelated.orderHash]);
  assert.deepEqual(after, before);
  return { id, event: journal, nft: await nftSnapshot(pool, identity), orders: after, assertions: { journal: true, unrelatedUnchanged: true } };
}

async function scenarioIgnored(pool: HarnessPool, id: string, orderTimestamp: string | null): Promise<unknown> {
  const identity = syntheticIdentity("stale-ignored", id);
  const order = { ...identity };
  await insertNft(pool, identity, "2026-01-01T00:01:00.000Z", `0x${"f".repeat(64)}`, "0x4444444444444444444444444444444444444444");
  await insertOrder(pool, order, "0x1111111111111111111111111111111111111111", "active", true, orderTimestamp);
  const beforeNft = await nftSnapshot(pool, identity);
  const beforeOrder = await ordersForNftSnapshot(pool, identity);
  const run = await runTransfer(pool, id, identity, "2026-01-01T00:00:06.000Z", "0x2222222222222222222222222222222222222222");
  assert.equal(run.result.outcome, "ignored_older");
  const journal = await assertRunJournal(pool, run, "ignored_older_transfer;suppressed_orders=0", "ignored_older");
  const afterNft = await nftSnapshot(pool, identity);
  const afterOrder = await ordersForNftSnapshot(pool, identity);
  assert.deepEqual(afterNft, beforeNft);
  assert.deepEqual(afterOrder, beforeOrder);
  return { id, event: journal, nft: afterNft, orders: afterOrder, assertions: { journal: true, nftUnchanged: true, orderUnchanged: true, suppressionQueryNotObserved: false } };
}

async function scenarioRollback(pool: HarnessPool, id: string): Promise<unknown> {
  const identity = syntheticIdentity("rollback", id);
  await insertOrder(pool, identity, "0x1111111111111111111111111111111111111111");
  const inserted = await persistRawEventToInbox(pool, buildSyntheticTransfer(identity, "2026-01-01T00:00:07.000Z", "0x2222222222222222222222222222222222222222"), RECEIVED_AT);
  assert.equal(inserted.outcome, "inserted_pending");
  const beforeNft = await nftSnapshot(pool, identity);
  const beforeOrders = await orderSnapshot(pool, [identity.orderHash]);
  const beforeJournal = await journalSnapshot(pool, inserted.eventId);
  const triggerSuffix = crypto.createHash("sha256").update(identity.orderHash).digest("hex").slice(0, 16);
  const functionName = `active_order_pg_fail_${triggerSuffix}`;
  const triggerName = `active_order_pg_trigger_${triggerSuffix}`;
  await pool.query(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic active-order write failure'; END; $$`);
  await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE ON public.opensea_listings_v2 FOR EACH ROW WHEN (NEW.order_hash = '${identity.orderHash}') EXECUTE FUNCTION public.${functionName}()`);
  let transactionFailureObserved = false;
  try {
    await assert.rejects(() => applyPendingInboxEvent(pool, inserted.eventId, NOW), /synthetic active-order write failure/);
    transactionFailureObserved = true;
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON public.opensea_listings_v2`);
    await pool.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
  }
  const afterNft = await nftSnapshot(pool, identity);
  const afterOrders = await orderSnapshot(pool, [identity.orderHash]);
  const afterJournal = await journalSnapshot(pool, inserted.eventId);
  const verification: RollbackVerification = {
    nftRolledBack: JSON.stringify(afterNft) === JSON.stringify(beforeNft),
    ordersRolledBack: JSON.stringify(afterOrders) === JSON.stringify(beforeOrders),
    journalRolledBack: JSON.stringify(afterJournal) === JSON.stringify(beforeJournal),
    noPartialApplyResult: afterJournal.apply_result === null && afterJournal.applied_at === null,
    triggerObserved: true,
    transactionFailureObserved
  };
  assertRollbackVerification(verification);
  return { id, event: afterJournal, nft: afterNft, orders: afterOrders, rollbackVerification: verification, assertions: { journal: true, rollback: true } };
}

const SCENARIO_RUNNERS: Record<string, (pool: HarnessPool, id: string) => Promise<unknown>> = {
  one_active_order: scenarioOne,
  two_active_orders: scenarioTwo,
  zero_orders: scenarioZero,
  terminal_inactive_orders: scenarioTerminal,
  unrelated_nft: scenarioUnrelated,
  stale_ignored_transfer: (pool, id) => scenarioIgnored(pool, id, "2025-12-31T23:59:59.000Z"),
  chronology_trap: (pool, id) => scenarioIgnored(pool, id, null),
  rollback_after_order_failure: scenarioRollback
};

function ensureOutputDirectory(outputDir: string): void {
  if (fs.existsSync(outputDir)) {
    if (!fs.statSync(outputDir).isDirectory() || fs.readdirSync(outputDir).length > 0) throw new Error("output directory must be absent or empty");
  } else fs.mkdirSync(outputDir, { recursive: true });
}

function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  fs.renameSync(temp, file);
}

interface StructuredError { phase: string; message: string; }
export interface CleanupOutcome {
  cleanupAttempted: boolean;
  targetPoolCloseAttempted: boolean;
  targetPoolCloseSucceeded: boolean;
  targetPoolCloseError: string | null;
  databaseDropAttempted: boolean;
  databaseDropSucceeded: boolean;
  databaseDropError: string | null;
  maintenancePoolCloseAttempted: boolean;
  maintenancePoolCloseSucceeded: boolean;
  maintenancePoolCloseError: string | null;
}

export function isCleanupSuccessful(cleanup: CleanupOutcome): boolean {
  return cleanup.cleanupAttempted
    && cleanup.targetPoolCloseSucceeded
    && cleanup.databaseDropSucceeded
    && cleanup.maintenancePoolCloseSucceeded
    && cleanup.targetPoolCloseError === null
    && cleanup.databaseDropError === null
    && cleanup.maintenancePoolCloseError === null;
}

export function cleanupPhaseOrder(): readonly string[] {
  return ["targetPoolClose", "databaseDrop", "maintenancePoolClose"];
}

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function isProvenanceComplete(provenance: { files: Record<string, string>; combinedSha256: string }): boolean {
  return Object.keys(provenance.files).length >= 11
    && Object.values(provenance.files).every((value) => /^[a-f0-9]{64}$/.test(value))
    && /^[a-f0-9]{64}$/.test(provenance.combinedSha256);
}

export function computeProvenance(): { files: Record<string, string>; combinedSha256: string } {
  const root = path.resolve(import.meta.dirname, "..");
  const files = [
    "scripts/testActiveOrderSuppressionPg.ts",
    "src/db/eventApplicationService.ts",
    "src/db/pendingInboxApplicationService.ts",
    "src/db/listingRepository.ts",
    "src/db/nftStateRepository.ts",
    "src/state/nftReducer.ts",
    "src/state/orderReducer.ts",
    "sql/001_create_v2_schema.sql",
    "sql/002_add_journal_processing_lifecycle.sql",
    "sql/003_add_inbox_attempt_ledger.sql",
    "package.json"
  ];
  const hashes = Object.fromEntries(files.map((file) => [file, hashFile(path.join(root, file))]));
  const combinedSha256 = crypto.createHash("sha256").update(files.map((file) => `${file}:${hashes[file]}`).join("\n")).digest("hex");
  return { files: hashes, combinedSha256 };
}

async function cleanupDatabase(targetPool: HarnessPool | null, databaseCreated: boolean, maintenanceConfig: MaintenanceConfig): Promise<CleanupOutcome> {
  const outcome: CleanupOutcome = {
    cleanupAttempted: databaseCreated,
    targetPoolCloseAttempted: targetPool !== null,
    targetPoolCloseSucceeded: targetPool === null,
    targetPoolCloseError: null,
    databaseDropAttempted: databaseCreated,
    databaseDropSucceeded: false,
    databaseDropError: null,
    maintenancePoolCloseAttempted: false,
    maintenancePoolCloseSucceeded: false,
    maintenancePoolCloseError: null
  };
  if (targetPool) {
    try { await targetPool.end(); outcome.targetPoolCloseSucceeded = true; } catch (caught) { outcome.targetPoolCloseError = errorText(caught); }
  }
  if (!databaseCreated) return outcome;
  assertCleanupEligible(databaseCreated);
  let maintenance: HarnessPool | null = null;
  try {
    maintenance = poolFor(MAINTENANCE_DATABASE, { authority: "maintenance", phase: "maintenance", databaseCreated, maintenanceConfig });
    outcome.maintenancePoolCloseAttempted = true;
    if (await currentDatabase(maintenance) !== MAINTENANCE_DATABASE) throw new Error("maintenance database identity mismatch");
    await maintenance.query(`DROP DATABASE ${quoteDisposableIdentifier(ACTIVE_ORDER_PG_DATABASE)}`);
    outcome.databaseDropSucceeded = true;
  } catch (caught) {
    outcome.databaseDropError = errorText(caught);
  } finally {
    if (maintenance) {
      try { await maintenance.end(); outcome.maintenancePoolCloseSucceeded = true; } catch (caught) { outcome.maintenancePoolCloseError = errorText(caught); }
    }
  }
  return outcome;
}

function pushError(errors: StructuredError[], phase: string, caught: unknown): void { errors.push({ phase, message: errorText(caught) }); }

function writeScenarioEvidence(outputDir: string, scenarios: readonly unknown[]): void {
  const lines = scenarios.map((scenario) => JSON.stringify(scenario)).join("\n");
  const file = path.join(outputDir, "active_order_suppression_pg_scenarios.jsonl");
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${lines}${lines ? "\n" : ""}`, "utf8");
  fs.renameSync(temp, file);
}

function scenarioActualApplyResult(result: any): string | null {
  const value = result?.event?.apply_result;
  return typeof value === "string" ? value : null;
}

export function scenarioEvidenceResult(result: any, expectedApplyResult: string | null): { actualApplyResult: string | null; expectedApplyResult: string | null } {
  return { actualApplyResult: scenarioActualApplyResult(result), expectedApplyResult };
}

export async function runActiveOrderSuppressionPg(config: ActiveOrderPgConfig): Promise<{ result: ActiveOrderPgResult; scenarios: unknown[]; summary: Record<string, unknown> }> {
  assertAllowedDisposableDatabase(config.database);
  ensureOutputDirectory(config.outputDir);
  const maintenanceConfig = loadMaintenanceConfig();
  const normalConfig = loadDatabaseConfig();
  assertSeparateMaintenanceIdentity(maintenanceConfig, normalConfig.user);
  const errors: StructuredError[] = [];
  const provenance = computeProvenance();
  const safetyGates = {
    exactDatabaseNameValid: config.database === ACTIVE_ORDER_PG_DATABASE,
    serverOtgRejected: true,
    maintenanceDatabaseValid: MAINTENANCE_DATABASE === "postgres",
    maintenanceConfigured: true,
    separateMaintenanceConfig: true,
    allConfirmationFlagsValid: REQUIRED_FLAGS.every((flag) => config.confirmations.has(flag)),
    outputDirectoryValid: true,
    disposableDatabaseAbsentBeforeCreate: false,
    databaseCreateAttempted: false,
    databaseCreated: false,
    ownershipSetupValid: false,
    schemaBootstrapValid: false,
    syntheticIdentityIsolationValid: true,
    provenanceComplete: isProvenanceComplete(provenance),
    productionDatabaseTouched: false
  };
  if (!safetyGates.allConfirmationFlagsValid) throw new Error("all disposable PG confirmation flags are required before database creation");
  const scenarios: unknown[] = [];
  let targetPool: HarnessPool | null = null;
  let databaseCreated = false;
  let evidenceWriteComplete = false;
  let cleanup: CleanupOutcome = {
    cleanupAttempted: false, targetPoolCloseAttempted: false, targetPoolCloseSucceeded: false, targetPoolCloseError: null,
    databaseDropAttempted: false, databaseDropSucceeded: false, databaseDropError: null,
    maintenancePoolCloseAttempted: false, maintenancePoolCloseSucceeded: false, maintenancePoolCloseError: null
  };
  const prep = await prepareDatabase(maintenanceConfig, normalConfig.user);
  databaseCreated = prep.databaseCreated;
  safetyGates.disposableDatabaseAbsentBeforeCreate = prep.disposableDatabaseAbsentBeforeCreate;
  safetyGates.databaseCreateAttempted = prep.databaseCreateAttempted;
  safetyGates.databaseCreated = prep.databaseCreated;
  safetyGates.ownershipSetupValid = prep.ownershipSetupValid;
  if (prep.error) errors.push({ phase: prep.errorPhase ?? "databaseCreate", message: prep.error });
  if (prep.maintenanceCloseError) errors.push({ phase: "maintenancePoolClose", message: prep.maintenanceCloseError });
  if (!prep.error && !prep.maintenanceCloseError && prep.databaseCreated && prep.ownershipSetupValid) {
    try {
      targetPool = poolFor(config.database);
      await assertDisposable(targetPool);
      await bootstrapSchema(targetPool);
      safetyGates.schemaBootstrapValid = true;
      for (const plan of ACTIVE_ORDER_PG_SCENARIOS) {
        const runner = SCENARIO_RUNNERS[plan.id];
        if (!runner) throw new Error(`missing runner for ${plan.id}`);
        try {
          const result = await runner(targetPool, plan.id);
          scenarios.push({ scenario: plan.id, passed: true, result, ...scenarioEvidenceResult(result, plan.expectedApplyResult), validationErrors: [] });
        } catch (caught) {
          const resultError = caught instanceof ScenarioApplyResultAssertionError ? caught : null;
          const record = {
            scenario: plan.id,
            passed: false,
            result: null,
            actualApplyResult: resultError?.actualApplyResult ?? null,
            expectedApplyResult: resultError?.expectedApplyResult ?? plan.expectedApplyResult,
            validationErrors: [errorText(caught).replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")]
          };
          scenarios.push(record);
          pushError(errors, "scenario", caught);
          break;
        }
      }
    } catch (caught) {
      pushError(errors, "bootstrap", caught);
    }
  }
  try {
    writeScenarioEvidence(config.outputDir, scenarios);
    evidenceWriteComplete = true;
  } catch (caught) { pushError(errors, "evidence", caught); }
  cleanup = await cleanupDatabase(targetPool, databaseCreated, maintenanceConfig);
  if (cleanup.targetPoolCloseError) errors.push({ phase: "targetPoolClose", message: cleanup.targetPoolCloseError });
  if (cleanup.databaseDropError) errors.push({ phase: "databaseDrop", message: cleanup.databaseDropError });
  if (cleanup.maintenancePoolCloseError) errors.push({ phase: "maintenancePoolClose", message: cleanup.maintenancePoolCloseError });
  const passedScenarios = scenarios.filter((scenario: any) => scenario.passed === true).length;
  const failedScenarios = scenarios.filter((scenario: any) => scenario.passed === false).length;
  const rollbackRecord = scenarios.find((scenario: any) => scenario.scenario === "rollback_after_order_failure") as any;
  const rollbackVerification = rollbackRecord?.result?.rollbackVerification ?? null;
  const allScenariosPassed = scenarios.length === ACTIVE_ORDER_PG_SCENARIOS.length && failedScenarios === 0;
  const cleanupSucceeded = isCleanupSuccessful(cleanup);
  const safetyGatesValid = Object.entries(safetyGates).filter(([key]) => key !== "productionDatabaseTouched").every(([, value]) => value === true)
    && safetyGates.productionDatabaseTouched === false;
  const complete = canDeclareActiveOrderPgComplete({
    safetyGatesValid,
    allScenariosPassed,
    rollbackVerificationPassed: Boolean(rollbackVerification && Object.values(rollbackVerification).every(Boolean)),
    evidenceWriteComplete,
    cleanupAttempted: cleanup.cleanupAttempted,
    cleanupSucceeded,
    cleanupError: cleanup.databaseDropError ?? cleanup.targetPoolCloseError ?? cleanup.maintenancePoolCloseError,
    productionDatabaseTouched: false,
    errors
  });
  const result: ActiveOrderPgResult = complete ? "ACTIVE_ORDER_PG_COMPLETE" : "ACTIVE_ORDER_PG_FAILED";
  const summary: Record<string, unknown> = {
    result,
    database: config.database,
    maintenanceDatabase: MAINTENANCE_DATABASE,
    safetyGates,
    scenarioCount: scenarios.length,
    expectedScenarioCount: ACTIVE_ORDER_PG_SCENARIOS.length,
    passedScenarios,
    failedScenarios,
    scenarios: scenarios.map((scenario: any) => ({ scenario: scenario.scenario, passed: scenario.passed, validationErrors: scenario.validationErrors ?? [] })),
    rollbackVerification,
    provenance,
    schemaBootstrap: { files: ["sql/001_create_v2_schema.sql", "sql/002_add_journal_processing_lifecycle.sql", "sql/003_add_inbox_attempt_ledger.sql"], passed: safetyGates.schemaBootstrapValid },
    evidenceWriteComplete,
    scenarioEvidenceWriteComplete: evidenceWriteComplete,
    summaryWriteComplete: false,
    cleanup,
    cleanupAttempted: cleanup.cleanupAttempted,
    cleanupSucceeded,
    cleanupError: cleanup.databaseDropError ?? cleanup.targetPoolCloseError ?? cleanup.maintenancePoolCloseError,
    productionDatabaseTouched: false,
    errors
  };
  let summaryWriteComplete = false;
  summary.summaryWriteComplete = true;
  try { atomicJson(path.join(config.outputDir, "active_order_suppression_pg_summary.json"), summary); summaryWriteComplete = true; }
  catch (caught) { pushError(errors, "summaryEvidence", caught); }
  if (!summaryWriteComplete) { summary.summaryWriteComplete = false; summary.result = "ACTIVE_ORDER_PG_FAILED"; }
  return { result: summary.result as ActiveOrderPgResult, scenarios, summary };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const config = parseActiveOrderPgArgs(argv);
    const result = await runActiveOrderSuppressionPg(config);
    console.log(JSON.stringify(result));
    if (result.result !== "ACTIVE_ORDER_PG_COMPLETE") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
