import fs from "node:fs";
import dotenv from "dotenv";
import pg from "pg";
import type { DbPool } from "./types.js";
import { resolveProjectEnvPath } from "../config/projectEnv.js";

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

export interface DatabaseConfigLoadOptions {
  /** Hermetic seam; production uses the project-local file path. */
  readonly readFileSync?: (filePath: string, encoding: "utf8") => string;
  /** Hermetic seam for callers that provide a complete file-backed environment. */
  readonly fileEnv?: NodeJS.ProcessEnv;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env, options: DatabaseConfigLoadOptions = {}): DatabaseConfig {
  let fileEnv: NodeJS.ProcessEnv;
  if (options.fileEnv !== undefined) fileEnv = options.fileEnv;
  else {
    const readFileSync = options.readFileSync ?? ((filePath: string, encoding: "utf8") => fs.readFileSync(filePath, encoding));
    let contents: string;
    try { contents = readFileSync(resolveProjectEnvPath(), "utf8"); }
    catch { throw new Error("PROJECT_ENV_FILE_MISSING"); }
    try { fileEnv = dotenv.parse(contents); }
    catch { throw new Error("PROJECT_ENV_FILE_INVALID"); }
  }
  const merged = { ...fileEnv, ...env };
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
