import { createDatabasePool, loadDatabaseConfig } from "../db/pool.js";
import {
  loadRestTxbSingleEventConfig,
  runRestTxbSingleEventCanary,
  type RestTxbSingleEventConfig,
  type RestTxbSingleEventSummary
} from "./restTxbSingleEventCanary.js";

export interface RestTxbSingleEventCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  runCanary?: (config: RestTxbSingleEventConfig) => Promise<RestTxbSingleEventSummary>;
}

function sanitizeCliError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD|authorization|x-api-key|api[_-]?key|password|token|secret)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>");
}

export async function runRestTxbSingleEventCanaryCli(options: RestTxbSingleEventCliOptions = {}): Promise<{ exitCode: number; summary: RestTxbSingleEventSummary | null }> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const config = loadRestTxbSingleEventConfig(options.argv ?? process.argv.slice(2));
    const summary = await (options.runCanary ?? (async (candidate) => {
      const pool = createDatabasePool({ ...loadDatabaseConfig(options.env ?? process.env), applicationName: "opensea_listings_v2_rest_txb_single_event_canary" });
      try {
        return await runRestTxbSingleEventCanary(candidate, { pool });
      } finally {
        await pool.end();
      }
    }))(config);
    stdout.write(`${JSON.stringify({ summary })}\n`);
    return { exitCode: summary.result === "REST_TXB_SINGLE_EVENT_COMPLETE" ? 0 : 1, summary };
  } catch (error) {
    stderr.write(`${sanitizeCliError(error)}\n`);
    return { exitCode: 1, summary: null };
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/dist/canary/runRestTxbSingleEventCanary.js")) {
  void runRestTxbSingleEventCanaryCli().then((result) => {
    process.exitCode = result.exitCode;
  });
}
