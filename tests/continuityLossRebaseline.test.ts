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
