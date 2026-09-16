import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryEntryAnchor, isTrustedRecoveryEntryAnchor } from "../src/reconciliation/continuityLossRebaseline.js";
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
