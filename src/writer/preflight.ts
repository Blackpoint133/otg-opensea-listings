import type { DbPool } from "../db/types.js";
import type { LiveWriterConfig } from "./writerConfig.js";
import { assertLiveWriterCanStart } from "./writerConfig.js";

export interface WriterPreflightResult {
  database: string;
  tables: Record<string, boolean>;
  journalEventTimestampNullable: boolean;
  journalReceivedAtNotNull: boolean;
  journalDedupeKeyUnique: boolean;
  journalLifecycleColumnsPresent: boolean;
  journalProcessingStatusNotNull: boolean;
  journalAttemptCountNotNull: boolean;
  journalProcessingStatusCheck: boolean;
  journalAttemptCountCheck: boolean;
  orderHashPrimaryKey: boolean;
  nftCompoundPrimaryKey: boolean;
  obsoleteTablesAbsent: boolean;
}

export interface WriterPreflightOptions {
  expectedDatabase?: string;
}

async function tableExists(pool: DbPool, tableName: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS exists",
    ["public", tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function columnNullable(pool: DbPool, tableName: string, columnName: string): Promise<boolean> {
  const result = await pool.query<{ is_nullable: string }>(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3",
    ["public", tableName, columnName]
  );
  return result.rows[0]?.is_nullable === "YES";
}

async function columnNotNull(pool: DbPool, tableName: string, columnName: string): Promise<boolean> {
  const result = await pool.query<{ is_nullable: string }>(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3",
    ["public", tableName, columnName]
  );
  return result.rows[0]?.is_nullable === "NO";
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

const lifecycleColumns: ColumnInfo[] = [
  { column_name: "processing_status", data_type: "text", is_nullable: "NO" },
  { column_name: "attempt_count", data_type: "integer", is_nullable: "NO" },
  { column_name: "processing_started_at", data_type: "timestamp with time zone", is_nullable: "YES" },
  { column_name: "last_attempt_at", data_type: "timestamp with time zone", is_nullable: "YES" },
  { column_name: "next_retry_at", data_type: "timestamp with time zone", is_nullable: "YES" },
  { column_name: "last_error_code", data_type: "text", is_nullable: "YES" },
  { column_name: "last_error_message", data_type: "text", is_nullable: "YES" }
];

async function lifecycleColumnsPresent(pool: DbPool): Promise<boolean> {
  const names = lifecycleColumns.map((column) => column.column_name);
  const result = await pool.query<ColumnInfo>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema=$1 AND table_name=$2 AND column_name = ANY($3::text[])`,
    ["public", "opensea_listings_events_v2", names]
  );
  const byName = new Map(result.rows.map((row) => [row.column_name, row]));
  return lifecycleColumns.every((expected) => {
    const actual = byName.get(expected.column_name);
    return actual?.data_type === expected.data_type && actual.is_nullable === expected.is_nullable;
  });
}

async function checkConstraintDefinition(pool: DbPool, tableName: string, constraintName: string): Promise<string | null> {
  const result = await pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     JOIN pg_class r ON r.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname=$1 AND r.relname=$2 AND c.conname=$3 AND c.contype='c'`,
    ["public", tableName, constraintName]
  );
  return result.rows[0]?.definition ?? null;
}

async function processingStatusCheck(pool: DbPool): Promise<boolean> {
  const definition = await checkConstraintDefinition(pool, "opensea_listings_events_v2", "opensea_listings_events_v2_processing_status_check");
  if (definition === null || !definition.includes("processing_status")) return false;
  return ["pending", "processing", "applied", "reconciliation_required", "failed", "ignored_duplicate", "ignored_older"].every((status) => definition.includes(status));
}

async function attemptCountCheck(pool: DbPool): Promise<boolean> {
  const definition = await checkConstraintDefinition(pool, "opensea_listings_events_v2", "opensea_listings_events_v2_attempt_count_check");
  return definition !== null && definition.includes("attempt_count") && definition.includes(">= 0");
}

async function uniqueConstraint(pool: DbPool, tableName: string, columnName: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
       WHERE tc.table_schema=$1 AND tc.table_name=$2 AND tc.constraint_type='UNIQUE' AND ccu.column_name=$3
     ) AS exists`,
    ["public", tableName, columnName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function primaryKey(pool: DbPool, tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema=$1 AND tc.table_name=$2 AND tc.constraint_type='PRIMARY KEY'
     ORDER BY kcu.ordinal_position`,
    ["public", tableName]
  );
  return result.rows.map((row) => row.column_name);
}

export async function runWriterPreflight(pool: DbPool, config: LiveWriterConfig, options: WriterPreflightOptions = {}): Promise<WriterPreflightResult> {
  assertLiveWriterCanStart(config);
  const database = await pool.query<{ database: string }>("SELECT current_database() AS database");
  const tables = {
    "public.opensea_listings_v2": await tableExists(pool, "opensea_listings_v2"),
    "public.opensea_listings_nft_state_v2": await tableExists(pool, "opensea_listings_nft_state_v2"),
    "public.opensea_listings_events_v2": await tableExists(pool, "opensea_listings_events_v2")
  };
  const obsoleteTablesAbsent = !(await tableExists(pool, "opensea_nft_state_v2")) && !(await tableExists(pool, "opensea_listing_events_v2"));
  const orderPk = await primaryKey(pool, "opensea_listings_v2");
  const nftPk = await primaryKey(pool, "opensea_listings_nft_state_v2");
  const result: WriterPreflightResult = {
    database: database.rows[0]?.database ?? "",
    tables,
    journalEventTimestampNullable: await columnNullable(pool, "opensea_listings_events_v2", "event_timestamp"),
    journalReceivedAtNotNull: await columnNotNull(pool, "opensea_listings_events_v2", "received_at"),
    journalDedupeKeyUnique: await uniqueConstraint(pool, "opensea_listings_events_v2", "dedupe_key"),
    journalLifecycleColumnsPresent: await lifecycleColumnsPresent(pool),
    journalProcessingStatusNotNull: await columnNotNull(pool, "opensea_listings_events_v2", "processing_status"),
    journalAttemptCountNotNull: await columnNotNull(pool, "opensea_listings_events_v2", "attempt_count"),
    journalProcessingStatusCheck: await processingStatusCheck(pool),
    journalAttemptCountCheck: await attemptCountCheck(pool),
    orderHashPrimaryKey: orderPk.join(",") === "order_hash",
    nftCompoundPrimaryKey: nftPk.join(",") === "chain,contract_address,token_id",
    obsoleteTablesAbsent
  };
  if (!Object.values(result.tables).every(Boolean)) throw new Error("writer preflight failed: missing V2 table");
  if (options.expectedDatabase !== undefined && result.database !== options.expectedDatabase) throw new Error(`writer preflight failed: expected database ${options.expectedDatabase}`);
  if (!result.journalEventTimestampNullable || !result.journalReceivedAtNotNull || !result.journalDedupeKeyUnique || !result.journalLifecycleColumnsPresent || !result.journalProcessingStatusNotNull || !result.journalAttemptCountNotNull || !result.journalProcessingStatusCheck || !result.journalAttemptCountCheck || !result.orderHashPrimaryKey || !result.nftCompoundPrimaryKey || !result.obsoleteTablesAbsent) throw new Error("writer preflight failed: schema contract mismatch");
  return result;
}
