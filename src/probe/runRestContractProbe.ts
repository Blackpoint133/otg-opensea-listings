import { runRestContractProbe, parseRestContractProbeArgs } from "./restContractProbe.js";

async function main(): Promise<void> {
  try {
    const config = parseRestContractProbeArgs(process.argv.slice(2));
    const result = await runRestContractProbe(config);
    process.stdout.write(`${JSON.stringify({ result: result.result, outputDir: config.outputDir, databaseTouched: result.databaseTouched, streamConnected: result.streamConnected, txAInvoked: result.txAInvoked, txBInvoked: result.txBInvoked })}\n`);
    if (result.result === "REST_CONTRACT_PROBE_FAILED") process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.replace(/(x-api-key|api[_-]?key|password|connection\s*string)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 300)}\n`);
    process.exitCode = 1;
  }
}

void main();

