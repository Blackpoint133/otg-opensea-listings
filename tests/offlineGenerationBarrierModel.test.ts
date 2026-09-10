import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOfflineCandidates, type OfflineLocalOrder, type OfflineSweepManifest } from "../src/reconciliation/offlineCandidateModel.js";
import { evaluateOfflineGeneration, type OfflineGenerationInput, type OfflineGenerationTransportEvidence } from "../src/reconciliation/offlineGenerationBarrierModel.js";

const START = "2026-08-23T13:00:00.000Z";
const END = "2026-08-23T13:12:00.000Z";
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_3 = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function watermark(eventId: string, receivedAt = END) {
  return { eventId, receivedAt };
}

function transport(overrides: Partial<OfflineGenerationTransportEvidence> = {}): OfflineGenerationTransportEvidence {
  return {
    transportResult: "COMPLETE",
    snapshotStartedAt: START,
    snapshotCompletedAt: END,
    paginationExhausted: true,
    nextCursor: null,
    truncatedByPageLimit: false,
    truncatedByListingLimit: false,
    malformedCount: 0,
    unsupportedCount: 0,
    conflictCount: 0,
    cursorCycleDetected: false,
    repeatedPageDetected: false,
    warnings: [],
    errors: [],
    sourceProvenance: { adapter: "a".repeat(64) },
    pageAttempts: 2,
    pagesFetched: 2,
    httpAttempts: 2,
    retryAttempts: 0,
    rawPagesCount: 2,
    responseHashesCount: 2,
    observedCount: 2,
    normalizedCount: 2,
    pageAttemptDetailsCount: 2,
    successfulPageAttempts: 2,
    ...overrides
  };
}

function round(roundNumber: number, eventId: string, overrides: Partial<OfflineGenerationInput["catchUpRounds"][number]> = {}) {
  return {
    roundNumber,
    observedHighWater: watermark(eventId),
    pendingCount: 0,
    processingCount: 0,
    failedCount: 0,
    reconciliationRequiredCount: 0,
    unknownStatusCount: 0,
    ...overrides
  };
}

function input(overrides: Partial<OfflineGenerationInput> = {}): OfflineGenerationInput {
  return {
    sweepId: "sweep-001",
    snapshotStartedAt: START,
    snapshotCompletedAt: END,
    sourceProvenance: { adapter: "a".repeat(64) },
    startBarrier: { sweepId: "sweep-001", snapshotStartedAt: START, eventHighWaterBefore: watermark("100", "2026-08-23T12:59:00.000Z") },
    endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("100") },
    transport: transport(),
    catchUpRounds: [round(1, "100"), round(2, "100")],
    maxCatchUpRounds: 4,
    ...overrides
  };
}

function candidateBundle(classes: Array<"PRESENT" | "ABSENT_CANDIDATE" | "BLOCKED">, sweepId = "sweep-001") {
  const localOrders: OfflineLocalOrder[] = classes.map((classification, index) => ({
    orderHash: index === 0 ? HASH : index === 1 ? HASH_2 : HASH_3,
    status: classification === "BLOCKED" ? "sold" : "active",
    isActive: classification !== "BLOCKED",
    needsReconciliation: classification === "BLOCKED",
    lastOrderEventTimestamp: "2026-08-23T12:00:00.000Z",
    lastOrderEventVersion: "1"
  }));
  const seenOrders = classes.flatMap((classification, index) => classification === "PRESENT" ? [{ sweepId, orderHash: index === 0 ? HASH : index === 1 ? HASH_2 : HASH_3, pageNumber: index + 1, rawPageHash: "b".repeat(64), normalizedMaterialHash: "c".repeat(64) }] : []);
  const manifest: OfflineSweepManifest = { sweepId, generationState: "TRANSPORT_COMPLETE", transportResult: "COMPLETE", snapshotStartedAt: START, snapshotCompletedAt: END, paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, sourceProvenance: { adapter: "a".repeat(64) } };
  return classifyOfflineCandidates({ manifest, seenOrders, localOrders, journalEvents: [] });
}

function frozenClone<T>(value: T, mutate?: (copy: any) => void): T {
  const copy = JSON.parse(JSON.stringify(value));
  mutate?.(copy);
  const freeze = (item: any): any => {
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
    return item;
  };
  return freeze(copy);
}

test("complete transport and stable catch-up produce a non-authoritative eligible fence", () => {
  const result = evaluateOfflineGeneration(input({ candidateBundle: candidateBundle(["ABSENT_CANDIDATE"]) }));
  assert.equal(result.state, "VERIFIED");
  assert.deepEqual(result.stateHistory, ["OPEN", "TRANSPORT_COMPLETE", "CATCHING_UP", "VERIFIED"]);
  assert.equal(result.catchUp.outcome, "STABLE");
  assert.equal(result.finalFence.outcome, "FENCE_ELIGIBLE");
  assert.equal(result.deactivationAuthorityGranted, false);
  assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, true);
  assert.equal(result.candidateAdvancement[0].authorityGranted, false);
});

test("PARTIAL transport is aborted and cannot reach the fence", () => {
  const result = evaluateOfflineGeneration(input({ transport: transport({ transportResult: "PARTIAL", nextCursor: "cursor", paginationExhausted: false }) }));
  assert.equal(result.state, "ABORTED");
  assert.equal(result.finalFence.outcome, "FENCE_BLOCKED");
  assert.ok(result.abortReasons.includes("SNAPSHOT_NOT_COMPLETE"));
});

test("counter inconsistency blocks an otherwise COMPLETE transport", () => {
  const result = evaluateOfflineGeneration(input({ transport: transport({ pagesFetched: 1 }) }));
  assert.equal(result.state, "ABORTED");
  assert.ok(result.abortReasons.includes("COUNTER_INCONSISTENT"));
  assert.equal(result.transportValidation.eligible, false);
});

test("semantic transport counters and flags fail closed", () => {
  for (const overrides of [{ malformedCount: 1 }, { unsupportedCount: 1 }, { conflictCount: 1 }, { cursorCycleDetected: true }, { repeatedPageDetected: true }, { warnings: ["warning"] }, { errors: ["error"] }]) {
    const result = evaluateOfflineGeneration(input({ transport: transport(overrides) }));
    assert.equal(result.state, "ABORTED");
    assert.ok(result.abortReasons.includes("SNAPSHOT_SEMANTICALLY_UNSAFE"));
  }
});

test("start and end barrier watermark regression is blocked", () => {
  const result = evaluateOfflineGeneration(input({ endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("99") } }));
  assert.equal(result.state, "ABORTED");
  assert.ok(result.abortReasons.includes("WATERMARK_REGRESSION"));
});

test("catch-up watermark regression is blocked", () => {
  const result = evaluateOfflineGeneration(input({ catchUpRounds: [round(1, "110"), round(2, "109")] , endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("110") } }));
  assert.equal(result.state, "ABORTED");
  assert.ok(result.abortReasons.includes("WATERMARK_REGRESSION"));
});

test("one qualifying observation is not stable", () => {
  const result = evaluateOfflineGeneration(input({ catchUpRounds: [round(1, "100")] }));
  assert.equal(result.state, "ABORTED");
  assert.equal(result.catchUp.outcome, "NOT_STABLE");
  assert.ok(result.abortReasons.includes("CATCH_UP_NOT_STABLE"));
});

test("two successive identical qualifying observations are stable", () => {
  const result = evaluateOfflineGeneration(input({ catchUpRounds: [round(1, "110"), round(2, "110")] , endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("110") } }));
  assert.equal(result.catchUp.stable, true);
  assert.deepEqual(result.catchUp.stableWatermark, watermark("110"));
  assert.equal(result.finalFence.outcome, "FENCE_ELIGIBLE");
});

test("late event watermarks 110,111,111 postpone stability until the repeated 111", () => {
  const early = evaluateOfflineGeneration(input({ catchUpRounds: [round(1, "110"), round(2, "111")] , endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("110") } }));
  const complete = evaluateOfflineGeneration(input({ catchUpRounds: [round(1, "110"), round(2, "111"), round(3, "111")] , endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("110") } }));
  assert.equal(early.catchUp.stable, false);
  assert.equal(early.finalFence.eligible, false);
  assert.equal(complete.catchUp.stable, true);
  assert.equal(complete.catchUp.stableWatermark?.eventId, "111");
});

test("event admitted after snapshot completion is represented by a later admission watermark", () => {
  const result = evaluateOfflineGeneration(input({
    catchUpRounds: [round(1, "101"), round(2, "101")],
    endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark("100") }
  }));
  assert.equal(result.catchUp.stableWatermark?.eventId, "101");
  assert.equal(result.finalFence.outcome, "FENCE_ELIGIBLE");
  assert.equal(result.startBarrier.eventHighWaterBefore.eventId, "100");
});

test("pending, processing, failed and reconciliation-required counts block catch-up", () => {
  const fields = ["pendingCount", "processingCount", "failedCount", "reconciliationRequiredCount"] as const;
  for (const field of fields) {
    const result = evaluateOfflineGeneration(input({ catchUpRounds: [round(1, "100", { [field]: 1 }), round(2, "100")] }));
    assert.equal(result.state, "ABORTED");
    assert.equal(result.catchUp.outcome, "UNSAFE");
  }
});

test("unknown runtime lifecycle summary blocks catch-up", () => {
  const result = evaluateOfflineGeneration(input({ catchUpRounds: [round(1, "100", { unknownStatusCount: 1 }), round(2, "100")] }));
  assert.equal(result.state, "ABORTED");
  assert.ok(result.abortReasons.includes("UNKNOWN_EVENT_STATE_AT_BARRIER"));
});

test("catch-up budget is finite and exhaustion aborts", () => {
  const result = evaluateOfflineGeneration(input({ maxCatchUpRounds: 2, catchUpRounds: [round(1, "100"), round(2, "101"), round(3, "102")] }));
  assert.equal(result.state, "ABORTED");
  assert.equal(result.catchUp.outcome, "BUDGET_EXHAUSTED");
  assert.ok(result.abortReasons.includes("CATCH_UP_BUDGET_EXHAUSTED"));
});

test("non-OPEN initial state cannot jump or move backwards", () => {
  for (const initialState of ["TRANSPORT_COMPLETE", "CATCHING_UP", "VERIFIED", "ABORTED", "future"] as unknown[]) {
    const result = evaluateOfflineGeneration(input({ initialState: initialState as never }));
    assert.equal(result.state, "ABORTED");
    assert.ok(result.abortReasons.includes("INVALID_INITIAL_STATE") || result.abortReasons.includes("UNKNOWN_GENERATION_STATE"));
  }
});

test("TRANSPORT_COMPLETE without catch-up is not eligible", () => {
  const result = evaluateOfflineGeneration(input({ catchUpRounds: [] }));
  assert.equal(result.state, "ABORTED");
  assert.equal(result.finalFence.eligible, false);
});

test("ABORTED conditions never become eligible even with candidate input", () => {
  const result = evaluateOfflineGeneration(input({ transport: transport({ transportResult: "FAILED", nextCursor: "x", paginationExhausted: false }), candidateBundle: candidateBundle(["ABSENT_CANDIDATE"]) }));
  assert.equal(result.state, "ABORTED");
  assert.equal(result.finalFence.eligible, false);
  assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, false);
  assert.equal(result.candidateAdvancement[0].authorityGranted, false);
});

test("PRESENT and BLOCKED candidates do not enter targeted verification", () => {
  const result = evaluateOfflineGeneration(input({ candidateBundle: candidateBundle(["PRESENT", "BLOCKED"]) }));
  assert.equal(result.finalFence.eligible, true);
  assert.equal(result.candidateAdvancement.every((item) => item.targetedVerifierEligible === false), true);
  assert.equal(result.candidateAdvancement.every((item) => item.authorityGranted === false), true);
});

test("ABSENT_CANDIDATE advances only to future verifier eligibility", () => {
  const result = evaluateOfflineGeneration(input({ candidateBundle: candidateBundle(["ABSENT_CANDIDATE"]) }));
  assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, true);
  assert.equal(result.candidateAdvancement[0].authorityGranted, false);
  assert.equal(result.deactivationAuthorityGranted, false);
});

test("runtime transport and generation enum values fail closed", () => {
  for (const transportResult of ["future", "", 42, null, {}, []] as unknown[]) {
    const result = evaluateOfflineGeneration(input({ transport: transport({ transportResult: transportResult as never }) }));
    assert.equal(result.state, "ABORTED");
    assert.equal(result.finalFence.eligible, false);
  }
});

test("malformed barriers, timestamps, provenance and budget fail closed", () => {
  const variants: Partial<OfflineGenerationInput>[] = [
    { sweepId: "" },
    { snapshotStartedAt: "not-a-date" },
    { snapshotCompletedAt: "2026-08-23T12:00:00.000Z" },
    { sourceProvenance: {} },
    { startBarrier: { sweepId: "wrong", snapshotStartedAt: START, eventHighWaterBefore: watermark("100") } },
    { endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: { eventId: "not-an-id", receivedAt: END } } },
    { maxCatchUpRounds: 1 }
  ];
  for (const variant of variants) {
    const result = evaluateOfflineGeneration(input(variant));
    assert.equal(result.state, "ABORTED");
    assert.equal(result.finalFence.eligible, false);
  }
});

test("candidate duplicate and malformed runtime identities fail closed", () => {
  const base = candidateBundle(["ABSENT_CANDIDATE", "ABSENT_CANDIDATE"]);
  const forged = frozenClone(base, (copy) => { copy.orders[1].orderHash = HASH; copy.orders[1].classification = "PRESENT"; });
  const result = evaluateOfflineGeneration(input({ candidateBundle: forged }));
  assert.equal(result.candidateAdvancement.every((item) => item.targetedVerifierEligible === false), true);
  assert.equal(result.candidateAdvancement.every((item) => item.reasons.includes("DUPLICATE_CANDIDATE_IDENTITY")), true);
  assert.equal(result.candidateAdvancement.every((item) => item.authorityGranted === false), true);
});

test("generation result is deeply immutable and authority fields cannot be changed", () => {
  const result = evaluateOfflineGeneration(input({ candidateBundle: candidateBundle(["ABSENT_CANDIDATE"]) }));
  const runtime = result as any;
  const attempts = [
    () => { runtime.deactivationAuthorityGranted = true; },
    () => { runtime.finalFence.outcome = "FENCE_ELIGIBLE"; },
    () => { runtime.startBarrier.eventHighWaterBefore.eventId = "999"; },
    () => { runtime.catchUp.rounds.push(round(3, "100")); },
    () => { runtime.abortReasons.push("SNAPSHOT_NOT_COMPLETE"); },
    () => { runtime.candidateAdvancement[0].authorityGranted = true; },
    () => { runtime.candidateAdvancement[0].targetedVerifierEligible = false; }
  ];
  for (const attempt of attempts) { try { attempt(); } catch { /* frozen strict-mode assignment */ } }
  assert.equal(result.deactivationAuthorityGranted, false);
  assert.equal(result.finalFence.outcome, "FENCE_ELIGIBLE");
  assert.equal(result.startBarrier.eventHighWaterBefore.eventId, "100");
  assert.equal(result.candidateAdvancement[0].authorityGranted, false);
  assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, true);
  for (const value of [result, result.startBarrier, result.endBarrier, result.catchUp, result.catchUp.rounds, result.catchUp.rounds[0], result.abortReasons, result.candidateAdvancement, result.candidateAdvancement[0], result.finalFence]) assert.equal(Object.isFrozen(value), true);
});

test("input mutation after evaluation cannot alter generation output", () => {
  const provenance = { adapter: "original" };
  const rounds = [round(1, "100"), round(2, "100")];
  const source = input({ sourceProvenance: provenance, catchUpRounds: rounds, candidateBundle: candidateBundle(["ABSENT_CANDIDATE"]) });
  const result = evaluateOfflineGeneration(source);
  provenance.adapter = "changed";
  rounds[0].observedHighWater.eventId = "999";
  rounds.push(round(3, "999"));
  source.startBarrier.eventHighWaterBefore.eventId = "999";
  assert.equal(result.sourceProvenance.adapter, "original");
  assert.equal(result.catchUp.rounds[0].observedHighWater.eventId, "100");
  assert.equal(result.catchUp.rounds.length, 2);
  assert.equal(result.candidateAdvancement[0].sourceClassification, "ABSENT_CANDIDATE");
  assert.equal(result.startBarrier.eventHighWaterBefore.eventId, "100");
});

test("identical generation inputs produce deterministic canonical output", () => {
  const first = evaluateOfflineGeneration(input({ candidateBundle: candidateBundle(["ABSENT_CANDIDATE"]) }));
  const second = evaluateOfflineGeneration(input({ candidateBundle: candidateBundle(["ABSENT_CANDIDATE"]) }));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("forged malformed ABSENT_CANDIDATE cannot enter verifier advancement", () => {
  const forged = frozenClone(candidateBundle(["ABSENT_CANDIDATE"]), (copy) => { copy.orders[0].orderHash = "not-an-order-hash"; });
  const result = evaluateOfflineGeneration(input({ candidateBundle: forged }));
  assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, false);
  assert.ok(result.candidateAdvancement[0].reasons.includes("INVALID_CANDIDATE_IDENTITY"));
});

test("unknown and malformed candidate classifications fail closed", () => {
  for (const classification of ["FAKE", "ABSENT", "absent_candidate", "", 123, null, {}, []] as unknown[]) {
    const forged = frozenClone(candidateBundle(["ABSENT_CANDIDATE"]), (copy) => { copy.orders[0].classification = classification; });
    const result = evaluateOfflineGeneration(input({ candidateBundle: forged }));
    assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, false);
    assert.ok(result.candidateAdvancement[0].reasons.includes("UNKNOWN_CANDIDATE_CLASSIFICATION"));
  }
});

test("injected authority fields invalidate candidate handoff", () => {
  const forgedTop = frozenClone(candidateBundle(["ABSENT_CANDIDATE"]), (copy) => { copy.authorityGranted = true; });
  const forgedOrder = frozenClone(candidateBundle(["ABSENT_CANDIDATE"]), (copy) => { copy.orders[0].authorityGranted = true; });
  for (const candidate of [forgedTop, forgedOrder]) {
    const result = evaluateOfflineGeneration(input({ candidateBundle: candidate }));
    assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, false);
    assert.ok(result.candidateAdvancement[0].reasons.includes("INVALID_CANDIDATE_AUTHORITY"));
  }
});

test("missing or unfrozen candidate structure fails closed", () => {
  const missing = frozenClone(candidateBundle(["ABSENT_CANDIDATE"]), (copy) => { delete copy.orders[0].reasons; });
  const mutable = JSON.parse(JSON.stringify(candidateBundle(["ABSENT_CANDIDATE"])));
  for (const candidate of [missing, mutable]) {
    const result = evaluateOfflineGeneration(input({ candidateBundle: candidate }));
    assert.equal(result.candidateAdvancement[0]?.targetedVerifierEligible ?? false, false);
  }
});

test("every member of a duplicate identity group is blocked", () => {
  const base = candidateBundle(["ABSENT_CANDIDATE", "ABSENT_CANDIDATE"]);
  const duplicate = frozenClone(base, (copy) => { copy.orders[1].orderHash = HASH; copy.orders[1].classification = "PRESENT"; });
  const result = evaluateOfflineGeneration(input({ candidateBundle: duplicate }));
  assert.equal(result.candidateAdvancement.length, 2);
  assert.equal(result.candidateAdvancement.every((item) => item.targetedVerifierEligible === false), true);
  assert.equal(result.candidateAdvancement.every((item) => item.reasons.includes("DUPLICATE_CANDIDATE_IDENTITY")), true);
});

test("duplicate permutations are deterministic and have no first-wins behavior", () => {
  const base = candidateBundle(["ABSENT_CANDIDATE", "ABSENT_CANDIDATE"]);
  const first = frozenClone(base, (copy) => { copy.orders[1].orderHash = HASH; copy.orders[1].classification = "PRESENT"; });
  const second = frozenClone(base, (copy) => { copy.orders[0].classification = "PRESENT"; copy.orders[1].orderHash = HASH; });
  const a = evaluateOfflineGeneration(input({ candidateBundle: first }));
  const b = evaluateOfflineGeneration(input({ candidateBundle: second }));
  assert.deepEqual(a.candidateAdvancement, b.candidateAdvancement);
  assert.equal(a.candidateAdvancement.every((item) => item.targetedVerifierEligible === false), true);
});

test("an unrelated unique absent order remains independent of a blocked duplicate group", () => {
  const base = candidateBundle(["ABSENT_CANDIDATE", "ABSENT_CANDIDATE", "ABSENT_CANDIDATE"]);
  const mixed = frozenClone(base, (copy) => { copy.orders[1].orderHash = HASH; copy.orders[1].classification = "PRESENT"; });
  const result = evaluateOfflineGeneration(input({ candidateBundle: mixed }));
  const unrelated = result.candidateAdvancement.find((item) => item.orderHash === HASH_3);
  assert.equal(unrelated?.targetedVerifierEligible, true);
  assert.equal(result.candidateAdvancement.filter((item) => item.orderHash === HASH).every((item) => item.targetedVerifierEligible === false), true);
});

test("candidate bundle sweep mismatch blocks all advancement", () => {
  const result = evaluateOfflineGeneration(input({ candidateBundle: candidateBundle(["ABSENT_CANDIDATE"], "other-sweep") }));
  assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, false);
  assert.ok(result.candidateAdvancement[0].reasons.includes("CANDIDATE_SWEEP_MISMATCH"));
});

test("canonical hash validation accepts uppercase hex and rejects malformed forms", () => {
  const validUpper = frozenClone(candidateBundle(["ABSENT_CANDIDATE"]), (copy) => { copy.orders[0].orderHash = "0x" + "A".repeat(64); });
  assert.equal(evaluateOfflineGeneration(input({ candidateBundle: validUpper })).candidateAdvancement[0].targetedVerifierEligible, true);
  for (const orderHash of ["", " ", "a".repeat(64), "0x" + "a".repeat(63), "0x" + "a".repeat(65), "0x" + "g".repeat(64), 123, null, {}, []] as unknown[]) {
    const forged = frozenClone(candidateBundle(["ABSENT_CANDIDATE"]), (copy) => { copy.orders[0].orderHash = orderHash; });
    const result = evaluateOfflineGeneration(input({ candidateBundle: forged }));
    assert.equal(result.candidateAdvancement[0].targetedVerifierEligible, false);
    assert.ok(result.candidateAdvancement[0].reasons.includes("INVALID_CANDIDATE_IDENTITY"));
  }
});

test("very large admission watermark IDs remain exact", () => {
  const huge = "90071992547409931234567890";
  const result = evaluateOfflineGeneration(input({
    startBarrier: { sweepId: "sweep-001", snapshotStartedAt: START, eventHighWaterBefore: watermark(huge) },
    endBarrier: { snapshotCompletedAt: END, eventHighWaterAfter: watermark(huge) },
    catchUpRounds: [round(1, huge), round(2, huge)]
  }));
  assert.equal(result.finalFence.eligible, true);
  assert.equal(result.catchUp.stableWatermark?.eventId, huge);
});

test("malformed receivedAt fails closed", () => {
  const result = evaluateOfflineGeneration(input({ startBarrier: { sweepId: "sweep-001", snapshotStartedAt: START, eventHighWaterBefore: watermark("100", "not-a-date") } }));
  assert.equal(result.state, "ABORTED");
  assert.equal(result.finalFence.eligible, false);
});

test("stability exactly on the final allowed round succeeds", () => {
  const result = evaluateOfflineGeneration(input({ maxCatchUpRounds: 2, catchUpRounds: [round(1, "100"), round(2, "100")] }));
  assert.equal(result.catchUp.outcome, "STABLE");
  assert.equal(result.finalFence.eligible, true);
});

test("instability through the final allowed round exhausts the budget", () => {
  const result = evaluateOfflineGeneration(input({ maxCatchUpRounds: 2, catchUpRounds: [round(1, "100"), round(2, "101")] }));
  assert.equal(result.catchUp.outcome, "BUDGET_EXHAUSTED");
  assert.equal(result.state, "ABORTED");
  assert.ok(result.abortReasons.includes("CATCH_UP_BUDGET_EXHAUSTED"));
});
