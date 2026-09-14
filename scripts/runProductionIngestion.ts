import { ProductionIngestionRuntime, assertProductionProfile } from "../src/runtime/productionIngestionRuntime.js";

const args = process.argv.slice(2);
if (!args.includes("--confirm-production-ingestion")) {
  throw new Error("--confirm-production-ingestion is required");
}
const profileIndex = args.indexOf("--profile");
assertProductionProfile(profileIndex >= 0 ? args[profileIndex + 1] : undefined);

const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true });
const shutdown = () => { void runtime.stop(); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await runtime.start();
  const termination = await runtime.waitForTermination();
  if (termination.fatal) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
