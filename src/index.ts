import { loadConfig } from "./config.js";
import { runProbe } from "./streamProbe.js";

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const stop = () => process.emit("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runProbe(config);
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} | ERROR | ${String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
