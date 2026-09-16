import path from "node:path";

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
