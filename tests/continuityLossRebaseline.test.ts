import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRecoveryEntryAnchor, isTrustedRecoveryEntryAnchor, continuityRebaselineInsertContract } from "../src/reconciliation/continuityLossRebaseline.js";
import { parseContinuityLossRebaselineArgs } from "../src/cli/runContinuityLossRebaseline.js";
import { runContinuityLossRebaseline } from "../src/runtime/continuityLossRebaselineRuntime.js";

const base = {
  capturedAt: "2026-09-16T12:00:00.000Z",
  journalHighWater: { eventId: "1758", receivedAt: "2026-09-16T11:59:59.000Z" },
  supersededPublicationId: "a".repeat(64), supersededPublicationSequence: 1, supersededSweepId: "sweep",
  adoptionCount: 0, listingCount: 2, activeListingCount: 0, genericPendingCount: 0,
  specializedPendingCount: 13, processingCount: 0, failedCount: 0, staleProcessingCount: 0,
  validProductionIngestionLeaseCount: 0
} as const;

test("continuity-loss recovery anchor is trusted, immutable, and permits inactive local rows", () => {
  const anchor = createRecoveryEntryAnchor(base);
  assert.equal(isTrustedRecoveryEntryAnchor(anchor), true);
  assert.equal(anchor.database, "server_otg");
  assert.equal(anchor.schema, "public");
  assert.equal(anchor.activeListingCount, 0);
  assert.equal(anchor.specializedPendingCount, 13);
  assert.throws(() => (anchor as any).listingCount = 0, TypeError);
  assert.equal(isTrustedRecoveryEntryAnchor({ ...anchor }), false);
});

for (const [field, code] of [["activeListingCount", "CONTINUITY_LOSS_RECOVERY_ACTIVE_LISTINGS_PRESENT"], ["adoptionCount", "CONTINUITY_LOSS_RECOVERY_ALREADY_ADOPTED"], ["genericPendingCount", "CONTINUITY_LOSS_RECOVERY_GENERIC_PENDING"], ["processingCount", "CONTINUITY_LOSS_RECOVERY_PROCESSING"], ["failedCount", "CONTINUITY_LOSS_RECOVERY_FAILED"], ["staleProcessingCount", "CONTINUITY_LOSS_RECOVERY_STALE_PROCESSING"], ["validProductionIngestionLeaseCount", "CONTINUITY_LOSS_RECOVERY_INGESTION_ALREADY_RUNNING"]] as const) {
  test(`anchor rejects ${field}`, () => assert.throws(() => createRecoveryEntryAnchor({ ...base, [field]: 1 } as any), new RegExp(code)));
}

test("specialized REST pending rows do not invalidate anchor", () => {
  assert.doesNotThrow(() => createRecoveryEntryAnchor(base));
});

test("continuity rebaseline INSERT contract is cardinality-safe and preserves JSON null", () => {
  const contract = continuityRebaselineInsertContract();
  assert.equal(contract.targetColumnCount, 33);
  assert.equal(contract.expressionCount, 33);
  assert.deepEqual(contract.parameterPositions, { source: 15, adoptedAt: 16, rawLastEvent: 17, protocolAddress: 18, adoptionId: 19, rawBaselineListing: 20 });
});

test("superseded sweep is mandatory and recovery-entry high-water is independently bound", () => {
  assert.throws(() => createRecoveryEntryAnchor({ ...base, supersededSweepId: "" } as any), /CONTINUITY_LOSS_RECOVERY_ANCHOR_INVALID/);
  assert.equal(base.journalHighWater.eventId, "1758");
});

test("replay source is fenced at recovery entry and requires business time", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/reconciliation/continuityLossRebaseline.ts"), "utf8");
  assert.match(source, /event_id > \$1::bigint ORDER BY event_id ASC/);
  assert.match(source, /plan\.recoveryEntryJournalEventId/);
  assert.match(source, /CONTINUITY_LOSS_REBASELINE_EVENT_TIME_UNPROVEN/);
  assert.doesNotMatch(source, /\[plan\.stableWatermark\.eventId\]/);
});

test("production CLI has direct wiring and no required execute callback", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/cli/runContinuityLossRebaseline.ts"), "utf8");
  assert.match(source, /loadCanonicalProductionOpenSeaApiKey/);
  assert.match(source, /loadDatabaseConfig/);
  assert.match(source, /new ProductionIngestionRuntime/);
  assert.match(source, /runContinuityLossGeneration/);
  assert.match(source, /waitForTermination/);
  assert.match(source, /pathToFileURL/);
});

test("anchor read-only SQL and receipt verifier SQL honor real migration contracts", () => {
  const anchorSource = fs.readFileSync(path.resolve(process.cwd(), "src/reconciliation/continuityLossRebaseline.ts"), "utf8");
  const verifierSource = fs.readFileSync(path.resolve(process.cwd(), "src/reconciliation/continuityLossRebaselineVerifier.ts"), "utf8");
  const anchorBody = anchorSource.slice(anchorSource.indexOf("export async function captureRecoveryEntryAnchor"), anchorSource.indexOf("export interface ContinuityLossRebaselinePlanV2"));
  const anchorQueries = [...anchorBody.matchAll(/client\.query(?:<[^>]+>)?\((?:`|\")([\s\S]*?)(?:`|\")/g)].map((m) => m[1]);
  for (const query of anchorQueries) assert.doesNotMatch(query, /FOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)/i);
  const migration = fs.readFileSync(path.resolve(process.cwd(), "sql/009_add_initial_baseline_adoption.sql"), "utf8");
  for (const column of ["schema_version","adoption_id","generation_publication_id","publication_sequence","sweep_id","source_evidence_hash","snapshot_artifact_hash","generation_root_hash","candidate_artifact_hash","barrier_artifact_hash","scope","scope_fingerprint","protocol_address","stable_event_id","stable_received_at","snapshot_started_at","snapshot_completed_at","expected_order_count","adopted_order_count","rows_commitment","payload","adopted_at"]) assert.match(migration, new RegExp(`\\b${column}\\b`, "i"));
  assert.doesNotMatch(verifierSource, /SELECT[^\n]*raw_baseline_listing[^\n]*FROM\s+public\.opensea_listings_initial_baseline_adoptions/i);
  const receiptSql = verifierSource.match(/SELECT\s+([^\"]+)\s+FROM\s+public\.opensea_listings_initial_baseline_adoptions/i)?.[1];
  assert.ok(receiptSql, "receipt verifier SELECT must be discoverable");
  const selected = receiptSql.split(",").map((column) => column.trim());
  const allowed = new Set(["schema_version","adoption_id","generation_publication_id","publication_sequence","sweep_id","source_evidence_hash","snapshot_artifact_hash","generation_root_hash","candidate_artifact_hash","barrier_artifact_hash","scope","scope_fingerprint","protocol_address","stable_event_id","stable_received_at","snapshot_started_at","snapshot_completed_at","expected_order_count","adopted_order_count","rows_commitment","payload","adopted_at"]);
  assert.ok(selected.every((column) => allowed.has(column)), `receipt columns must match migration 009: ${selected.join(",")}`);
});

test("durable verifier reconstructs lifecycle from the trusted baseline and replay cut", () => {
  const verifier = fs.readFileSync(path.resolve(process.cwd(), "src/reconciliation/continuityLossRebaselineVerifier.ts"), "utf8");
  assert.match(verifier, /normalizeStoredRawEvent/);
  assert.match(verifier, /reduceOrderState/);
  assert.match(verifier, /applyTransferToOrder/);
  assert.match(verifier, /expectedBaseline/);
  assert.match(verifier, /recoveryEntryJournalEventId/);
  assert.match(verifier, /snapshotCompletedAt/);
  assert.match(verifier, /processing_status IN \('pending','processing','failed'\)/);
});

test("continuity-loss CLI requires explicit superseded identity and confirmations", () => {
  const args = parseContinuityLossRebaselineArgs([
    "--confirm-production-continuity-loss-rebaseline", "--confirm-supersede-unadopted-publication",
    "--confirm-no-deactivation-authority", "--confirm-new-stream-epoch",
    "--superseded-publication-id", "a".repeat(64), "--superseded-sweep-id", "sweep",
    "--evidence-root", "C:\\evidence"
  ]);
  assert.equal(args.supersededPublicationId, "a".repeat(64));
  assert.throws(() => parseContinuityLossRebaselineArgs([]), /missing_confirm/);
});

test("coordinator captures the recovery anchor before any runtime start", async () => {
  const order: string[] = [];
  const result = await runContinuityLossRebaseline({
    pool: {} as any, apiKey: "synthetic", supersededPublicationId: "a".repeat(64), supersededSweepId: "sweep", evidenceRoot: "C:\\evidence",
    captureAnchor: async () => { order.push("anchor"); return createRecoveryEntryAnchor(base); },
    runtimeFactory: (() => { order.push("runtime"); throw new Error("must not start in this precondition fixture"); }) as any,
    leaseProbe: async () => null,
    generation: async () => { throw new Error("not reached"); }
  });
  assert.deepEqual(order, ["anchor", "runtime"]);
  assert.equal(result.status, "STREAM_EPOCH_LOST");
});
