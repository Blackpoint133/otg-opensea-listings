import { createDatabasePool, loadDatabaseConfig } from "../db/pool.js";
import { loadRestTxbMultiEventConfig, runRestTxbMultiEventCanary, type MultiRestTxbSummary } from "./restTxbMultiEventCanary.js";

export interface MultiRestTxbCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  runCanary?: (config: ReturnType<typeof loadRestTxbMultiEventConfig>) => Promise<MultiRestTxbSummary>;
}

function sanitize(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD|authorization|x-api-key|password|token|secret)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>"); }

export async function runRestTxbMultiEventCanaryCli(options: MultiRestTxbCliOptions = {}): Promise<{ exitCode: number; summary: MultiRestTxbSummary | null }> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const config = loadRestTxbMultiEventConfig(options.argv ?? process.argv.slice(2));
    const summary = await (options.runCanary ?? (async (candidate) => {
      const pool = createDatabasePool({ ...loadDatabaseConfig(options.env ?? process.env), applicationName: "opensea_listings_v2_rest_txb_multi_event_canary" });
      try { return await runRestTxbMultiEventCanary(candidate, { pool }); } finally { await pool.end(); }
    }))(config);
    stdout.write(`${JSON.stringify({ summary })}\n`);
    return { exitCode: summary.result === "MULTI_REST_TXB_COMPLETE" ? 0 : 1, summary };
  } catch (error) { stderr.write(`${sanitize(error)}\n`); return { exitCode: 1, summary: null }; }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/dist/canary/runRestTxbMultiEventCanary.js")) void runRestTxbMultiEventCanaryCli().then((result) => { process.exitCode = result.exitCode; });
