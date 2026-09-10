import { createDatabasePool, loadDatabaseConfig } from "../db/pool.js";
import { RestEventsClient } from "../backfill/restEventsClient.js";
import {
  createRestTxaOnlyCanaryClientOptions,
  loadRestTxaOnlyCanaryConfig,
  runRestTxaOnlyCanary,
  type RestTxaOnlyCanaryConfig,
  type RestTxaOnlyCanarySummary
} from "./restTxaOnlyCanary.js";

export interface RestTxaOnlyCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  runCanary?: (config: RestTxaOnlyCanaryConfig) => Promise<RestTxaOnlyCanarySummary>;
}

function sanitizeCliError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD|x-api-key|api[_-]?key|password|token|secret)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>");
}

export async function runRestTxaOnlyCanaryCli(options: RestTxaOnlyCliOptions = {}): Promise<{ exitCode: number; summary: RestTxaOnlyCanarySummary | null }> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const config = loadRestTxaOnlyCanaryConfig(options.argv ?? process.argv.slice(2), options.env ?? process.env);
    const summary = await (options.runCanary ?? (async (candidate) => {
      const pool = createDatabasePool({ ...loadDatabaseConfig(options.env ?? process.env), applicationName: "opensea_listings_v2_rest_txa_only_canary" });
      try {
        const client = new RestEventsClient(createRestTxaOnlyCanaryClientOptions(candidate));
        return await runRestTxaOnlyCanary(candidate, { pool, client });
      } finally {
        await pool.end();
      }
    }))(config);
    stdout.write(`${JSON.stringify({ summary })}\n`);
    return { exitCode: summary.result === "REST_TXA_ONLY_CANARY_COMPLETE" ? 0 : 1, summary };
  } catch (error) {
    stderr.write(`${sanitizeCliError(error)}\n`);
    return { exitCode: 1, summary: null };
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/dist/canary/runRestTxaOnlyCanary.js")) {
  void runRestTxaOnlyCanaryCli().then((result) => {
    process.exitCode = result.exitCode;
  });
}
