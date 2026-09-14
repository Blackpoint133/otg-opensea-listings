import { ProductionIngestionRuntime, assertProductionProfile } from "../src/runtime/productionIngestionRuntime.js";

const args = process.argv.slice(2);
if (!args.includes("--confirm-production-ingestion")) {
  throw new Error("--confirm-production-ingestion is required");
}
const profileIndex = args.indexOf("--profile");
assertProductionProfile(profileIndex >= 0 ? args[profileIndex + 1] : undefined);

const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true });
let resolveShutdown: (() => void) | null = null;
const shutdown = () => { void runtime.stop().finally(() => resolveShutdown?.()); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await runtime.start();
  await new Promise<void>((resolve) => { resolveShutdown = resolve; });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
