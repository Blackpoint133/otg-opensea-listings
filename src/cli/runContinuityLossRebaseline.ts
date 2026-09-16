import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabasePool, loadDatabaseConfig, closeDatabasePool } from "../db/pool.js";
import { loadCanonicalProductionOpenSeaApiKey } from "../runtime/productionOpenSeaCredential.js";
import { ProductionIngestionRuntime } from "../runtime/productionIngestionRuntime.js";
import { captureRecoveryEntryAnchor, PostgresContinuityLossBaselineAdoptionStore, createContinuityLossRebaselinePlan } from "../reconciliation/continuityLossRebaseline.js";
import { runContinuityLossRebaseline } from "../runtime/continuityLossRebaselineRuntime.js";
import { runContinuityLossGeneration } from "../runtime/continuityLossGeneration.js";
import { probeExternalIngestionLease } from "../runtime/initialGenerationBootstrapRuntime.js";

const REQUIRED = [
  "--confirm-production-continuity-loss-rebaseline",
  "--confirm-supersede-unadopted-publication",
  "--confirm-no-deactivation-authority",
  "--confirm-new-stream-epoch"
] as const;

export interface ContinuityLossRebaselineArgs { readonly supersededPublicationId: string; readonly supersededSweepId: string; readonly evidenceRoot: string; }

export function parseContinuityLossRebaselineArgs(argv: readonly string[]): ContinuityLossRebaselineArgs {
  const flags = new Set<string>(); let publicationId: string | null = null; let sweepId: string | null = null; let evidenceRoot: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((REQUIRED as readonly string[]).includes(arg)) { if (flags.has(arg)) throw new Error("duplicate_argument"); flags.add(arg); continue; }
    if (arg === "--superseded-publication-id" || arg === "--superseded-sweep-id" || arg === "--evidence-root") {
      const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`missing_${arg.slice(2).replace(/-/g, "_")}`);
      if (arg === "--superseded-publication-id") { if (publicationId !== null) throw new Error("duplicate_argument"); publicationId = value; }
      else if (arg === "--superseded-sweep-id") { if (sweepId !== null) throw new Error("duplicate_argument"); sweepId = value; }
      else { if (evidenceRoot !== null) throw new Error("duplicate_argument"); evidenceRoot = value; }
      continue;
    }
    throw new Error("unknown_argument");
  }
  for (const flag of REQUIRED) if (!flags.has(flag)) throw new Error(`missing_${flag.slice(2).replace(/-/g, "_")}`);
  if (!publicationId) throw new Error("superseded_publication_id_required");
  if (!sweepId) throw new Error("superseded_sweep_id_required");
  if (!evidenceRoot || !path.isAbsolute(evidenceRoot)) throw new Error("evidence_root_must_be_absolute");
  return { supersededPublicationId: publicationId, supersededSweepId: sweepId, evidenceRoot: path.normalize(evidenceRoot) };
}

/** The executable coordinator is intentionally dependency-injected; importing this module has no DB or network side effects. */
export async function runContinuityLossRebaselineCli(argv: readonly string[], execute: (args: ContinuityLossRebaselineArgs) => Promise<unknown>): Promise<unknown> {
  return execute(parseContinuityLossRebaselineArgs(argv));
}

function safeError(error: unknown): string { return (error instanceof Error ? error.message : "CONTINUITY_LOSS_REBASELINE_FAILED").replace(/(password|secret|api[_-]?key|authorization|token|connection string)\s*[:=]\s*[^,\s]+/gi, "$1=<redacted>").slice(0, 300); }

/** Production executable. All dependencies are resolved here; the exported
 * callback seam above remains test-only and is never required by main(). */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: ContinuityLossRebaselineArgs;
  try { args = parseContinuityLossRebaselineArgs(argv); } catch (error) { console.error(safeError(error)); process.exitCode = 1; return; }
  let pool: any;
  try {
    const apiKey = loadCanonicalProductionOpenSeaApiKey();
    const config = loadDatabaseConfig();
    pool = createDatabasePool({ ...config, applicationName: "opensea_listings_v2_continuity_rebaseline" });
    const publicationRow = await pool.query("SELECT publication_sequence FROM public.targeted_verifier_generation_publications WHERE generation_publication_id=$1", [args.supersededPublicationId]);
    if (publicationRow.rows.length !== 1) throw new Error("CONTINUITY_LOSS_RECOVERY_PUBLICATION_BINDING_INVALID");
    const supersededSequence = Number(publicationRow.rows[0].publication_sequence);
    const adoptionStore = new PostgresContinuityLossBaselineAdoptionStore(pool);
    const result = await runContinuityLossRebaseline({
      pool,
      apiKey,
      supersededPublicationId: args.supersededPublicationId,
      supersededSweepId: args.supersededSweepId,
      evidenceRoot: args.evidenceRoot,
      captureAnchor: () => captureRecoveryEntryAnchor(pool, args.supersededPublicationId, supersededSequence, args.supersededSweepId),
      leaseProbe: () => probeExternalIngestionLease(pool),
      runtimeFactory: (key) => new ProductionIngestionRuntime({ confirmProductionIngestion: true, apiKey: key }),
      generation: (initialLease) => runContinuityLossGeneration({ pool, apiKey, evidenceRoot: args.evidenceRoot, leaseProbe: () => probeExternalIngestionLease(pool), expectedLease: initialLease }),
      planFactory: createContinuityLossRebaselinePlan,
      adoptionStore,
      waitForTermination: (runtime) => runtime.waitForTermination()
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "VERIFIED_REBASELINED_ADOPTED" ? 0 : 2;
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
  finally { if (pool) await closeDatabasePool(pool); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
