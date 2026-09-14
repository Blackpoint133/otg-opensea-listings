import { closeDatabasePool, createDatabasePool, loadDatabaseConfig } from "../src/db/pool.js";
import { PostgresGenerationPublicationStore } from "../src/reconciliation/generationPublication.js";
import { CurrentActiveListingsEvidenceSource } from "../src/reconciliation/activeListingsEvidence.js";
import { FileIntegratedGenerationEvidenceResolver } from "../src/reconciliation/fileIntegratedGenerationEvidenceResolver.js";
import { ShadowProductionOrchestrator, createDefaultShadowProductionOrchestrator } from "../src/reconciliation/shadowProductionOrchestrator.js";

function option(name: string): string | null { const prefix = `--${name}=`; const value = process.argv.find((arg) => arg.startsWith(prefix)); return value ? value.slice(prefix.length) : null; }
const attemptId = option("attempt-id");
const limitText = option("limit");
const persist = process.argv.includes("--persist");
if ((attemptId && limitText) || (!attemptId && !limitText)) throw new Error("use exactly one of --attempt-id or --limit");
const evidenceRoot = option("evidence-root") ?? process.env.SHADOW_EVIDENCE_ROOT;
if (!evidenceRoot) throw new Error("SHADOW_EVIDENCE_ROOT or --evidence-root is required");
const limit = limitText === null ? null : Number(limitText);
if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
const pool = createDatabasePool({ ...loadDatabaseConfig(), applicationName: "opensea_shadow_audit" });
try {
  const generationStore = new PostgresGenerationPublicationStore(pool);
  const activeSource = new CurrentActiveListingsEvidenceSource(generationStore, new FileIntegratedGenerationEvidenceResolver(evidenceRoot));
  const orchestrator = createDefaultShadowProductionOrchestrator(pool, { generationStore, activeSource });
  const result = attemptId ? await orchestrator.runAttempt(attemptId, { persist }) : await orchestrator.runBatch({ limit: limit!, persist });
  const summary = "results" in result ? { ...result, results: result.results.map(safeResult) } : safeResult(result);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally { await closeDatabasePool(pool); }

function safeResult(result: any): unknown { return { outcome: result.outcome, attemptId: result.decision?.attemptId, orderHash: result.decision?.orderHash, shadowDecisionId: result.decision?.shadowDecisionId, state: result.decision?.state, reasonCodes: result.reasonCodes ?? result.decision?.reasonCodes, persistSequence: result.persistence?.persistSequence }; }
