import { ProductionIngestionRuntime, assertProductionProfile } from "../src/runtime/productionIngestionRuntime.js";
import { loadCanonicalProductionOpenSeaApiKey } from "../src/runtime/productionOpenSeaCredential.js";

const args = process.argv.slice(2);
if (!args.includes("--confirm-production-ingestion")) {
  throw new Error("--confirm-production-ingestion is required");
}
const profileIndex = args.indexOf("--profile");
assertProductionProfile(profileIndex >= 0 ? args[profileIndex + 1] : undefined);

let apiKey: string;
try {
  apiKey = loadCanonicalProductionOpenSeaApiKey();
} catch (error) {
  console.error(error instanceof Error ? error.message : "OPENSEA_API_KEY_MISSING");
  process.exitCode = 1;
  apiKey = "";
}
if (!apiKey) process.exit();
const runtime = new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey });
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
