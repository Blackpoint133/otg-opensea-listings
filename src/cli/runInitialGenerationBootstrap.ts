import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabasePool, loadDatabaseConfig, closeDatabasePool } from "../db/pool.js";
import { runInitialGenerationBootstrap } from "../runtime/initialGenerationBootstrapRuntime.js";
import { loadCanonicalProductionOpenSeaApiKey } from "../runtime/productionOpenSeaCredential.js";

const REQUIRED_FLAGS = ["--confirm-production-bootstrap", "--confirm-migration-009-applied", "--confirm-external-ingestion-running", "--confirm-no-deactivation-authority"] as const;
function parse(argv: readonly string[]): { evidenceRoot: string } {
  const flags = new Set<string>(); let evidenceRoot: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((REQUIRED_FLAGS as readonly string[]).includes(arg)) { if (flags.has(arg)) throw new Error("duplicate_argument"); flags.add(arg); continue; }
    if (arg === "--evidence-root") { if (evidenceRoot !== null) throw new Error("duplicate_argument"); const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error("missing_evidence_root"); evidenceRoot = value; continue; }
    throw new Error("unknown_argument");
  }
  for (const flag of REQUIRED_FLAGS) if (!flags.has(flag)) throw new Error(`missing_${flag.slice(2)}`);
  if (!evidenceRoot || !path.isAbsolute(evidenceRoot)) throw new Error("evidence_root_must_be_absolute");
  return { evidenceRoot: path.normalize(evidenceRoot) };
}
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/(api[_-]?key|authorization|password|secret)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 300); }
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: { evidenceRoot: string };
  try { args = parse(argv); } catch (error) { console.error(safeError(error)); process.exitCode = 1; return; }
  let apiKey: string;
  try { apiKey = loadCanonicalProductionOpenSeaApiKey(); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; return; }
  const pool = createDatabasePool(loadDatabaseConfig());
  try {
    const result = await runInitialGenerationBootstrap({ pool, evidenceRoot: args.evidenceRoot, apiKey });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "VERIFIED_ADOPTED" ? 0 : 2;
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
  finally { await closeDatabasePool(pool); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
