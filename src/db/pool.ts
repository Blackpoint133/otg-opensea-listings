import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import type { DbPool } from "./types.js";

const { Pool, types } = pg;

types.setTypeParser(1700, (value) => value);
types.setTypeParser(20, (value) => value);

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionTimeoutMillis: number;
  applicationName: string;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
  queryTimeoutMillis?: number;
}

const rootDir = path.resolve(import.meta.dirname, "..", "..");
const envPath = path.resolve(rootDir, "..", ".env");

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const fileEnv = dotenv.config({ path: envPath }).parsed ?? {};
  const merged = env === process.env ? { ...fileEnv, ...process.env } : { ...fileEnv, ...env };
  const portText = required(merged.POSTGRES_PORT, "POSTGRES_PORT");
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0) throw new Error("POSTGRES_PORT must be a positive integer");
  return {
    host: required(merged.POSTGRES_HOST, "POSTGRES_HOST"),
    port,
    database: required(merged.POSTGRES_DB, "POSTGRES_DB"),
    user: required(merged.POSTGRES_USER, "POSTGRES_USER"),
    password: required(merged.POSTGRES_PASSWORD, "POSTGRES_PASSWORD"),
    connectionTimeoutMillis: 10_000,
    applicationName: "opensea_listings_v2"
  };
}

export function createDatabasePool(config: DatabaseConfig = loadDatabaseConfig()): DbPool {
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    application_name: config.applicationName,
    statement_timeout: config.statementTimeoutMillis,
    lock_timeout: config.lockTimeoutMillis,
    query_timeout: config.queryTimeoutMillis
  }) as unknown as DbPool;
}

export async function checkDatabaseConnection(pool: DbPool): Promise<{ database: string; serverTime: string }> {
  const result = await pool.query<{ database: string; server_time: string }>(
    "SELECT current_database() AS database, now()::text AS server_time"
  );
  const row = result.rows[0];
  if (!row) throw new Error("database connection check returned no row");
  return { database: row.database, serverTime: row.server_time };
}

export async function closeDatabasePool(pool: DbPool): Promise<void> {
  await pool.end();
}
