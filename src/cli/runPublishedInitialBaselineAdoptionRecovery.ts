import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabasePool, loadDatabaseConfig, closeDatabasePool } from "../db/pool.js";
import { runPublishedInitialBaselineAdoptionRecovery } from "../runtime/publishedInitialBaselineAdoptionRecovery.js";

const REQUIRED = [
  "--confirm-production-published-baseline-recovery",
  "--confirm-no-new-sweep",
  "--confirm-existing-publication",
  "--confirm-external-ingestion-running",
  "--confirm-no-deactivation-authority"
] as const;
export interface PublishedRecoveryArgs { readonly publicationId: string; readonly sweepId: string; readonly evidenceRoot: string; }
export function parsePublishedRecoveryArgs(argv: readonly string[]): PublishedRecoveryArgs {
  const flags = new Set<string>(); let publicationId: string | null = null; let sweepId: string | null = null; let evidenceRoot: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((REQUIRED as readonly string[]).includes(arg)) { if (flags.has(arg)) throw new Error("duplicate_argument"); flags.add(arg); continue; }
    if (arg === "--publication-id" || arg === "--sweep-id" || arg === "--evidence-root") {
      const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`missing_${arg.slice(2).replace(/-/g, "_")}`);
      if (arg === "--publication-id") { if (publicationId !== null) throw new Error("duplicate_argument"); publicationId = value; }
      else if (arg === "--sweep-id") { if (sweepId !== null) throw new Error("duplicate_argument"); sweepId = value; }
      else { if (evidenceRoot !== null) throw new Error("duplicate_argument"); evidenceRoot = value; }
      continue;
    }
    throw new Error("unknown_argument");
  }
  for (const flag of REQUIRED) if (!flags.has(flag)) throw new Error(`missing_${flag.slice(2).replace(/-/g, "_")}`);
  if (!publicationId) throw new Error("publication_id_required");
  if (!sweepId) throw new Error("sweep_id_required");
  if (!evidenceRoot || !path.isAbsolute(evidenceRoot)) throw new Error("evidence_root_must_be_absolute");
  return { publicationId, sweepId, evidenceRoot: path.normalize(evidenceRoot) };
}
function safeError(error: unknown): string { return (error instanceof Error ? error.message : "INITIAL_BASELINE_RECOVERY_FAILED").replace(/(password|secret|api[_-]?key|authorization|token|connection string)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 300); }
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: PublishedRecoveryArgs;
  try { args = parsePublishedRecoveryArgs(argv); } catch (error) { console.error(safeError(error)); process.exitCode = 1; return; }
  const pool = createDatabasePool(loadDatabaseConfig());
  try {
    const result = await runPublishedInitialBaselineAdoptionRecovery({ pool, publicationId: args.publicationId, sweepId: args.sweepId, evidenceRoot: args.evidenceRoot });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "VERIFIED_ADOPTED" || result.status === "ALREADY_VERIFIED_ADOPTED" ? 0 : 2;
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
  finally { await closeDatabasePool(pool); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
