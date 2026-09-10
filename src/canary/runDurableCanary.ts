import { redactString } from "../logger.js";
import { loadDurableCanaryConfig, runDurableCanary, type DurableCanaryConfig, type DurableCanarySummary } from "./durableCanary.js";

export interface SignalRegistrar {
  once(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

export interface DurableCanaryCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  signals?: SignalRegistrar;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  runCanary?: (config: DurableCanaryConfig, signal: AbortSignal) => Promise<DurableCanarySummary>;
}

function sanitizeCliError(error: unknown): string {
  return redactString(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/\b(password|token|secret|api[_-]?key)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>")
    .replace(/\b(OPENSEA_API_KEY|POSTGRES_PASSWORD)\s*=\s*[^,\s]+/gi, "$1=<REDACTED>");
}

export async function runDurableCanaryCli(options: DurableCanaryCliOptions = {}): Promise<{ exitCode: number; summary: DurableCanarySummary | null }> {
  const controller = new AbortController();
  const signals = options.signals ?? process;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const onSigint = () => { if (!controller.signal.aborted) controller.abort("SIGINT"); };
  const onSigterm = () => { if (!controller.signal.aborted) controller.abort("SIGTERM"); };
  signals.once("SIGINT", onSigint);
  signals.once("SIGTERM", onSigterm);
  try {
    const config = loadDurableCanaryConfig(options.argv ?? process.argv.slice(2), options.env ?? process.env);
    const summary = await (options.runCanary ?? ((candidate, signal) => runDurableCanary(candidate, { externalStopSignal: signal })))(config, controller.signal);
    stdout.write(`${JSON.stringify({ summary })}\n`);
    return { exitCode: summary.result === "DURABLE_CANARY_COMPLETED" ? 0 : 1, summary };
  } catch (error) {
    stderr.write(`${sanitizeCliError(error)}\n`);
    return { exitCode: 1, summary: null };
  } finally {
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/dist/canary/runDurableCanary.js")) {
  void runDurableCanaryCli().then((result) => {
    process.exitCode = result.exitCode;
  });
}
