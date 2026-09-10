import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  classifyOfflineCandidates,
  importActiveListingsEvidenceFile,
  importActiveListingsEvidenceObject,
  type OfflineJournalEvent,
  type OfflineLocalOrder,
  type OfflineSweepManifest,
  type SeenOrder
} from "../src/reconciliation/offlineCandidateModel.js";

const START = "2026-08-23T13:00:00.000Z";
const END = "2026-08-23T13:12:00.000Z";
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function manifest(overrides: Partial<OfflineSweepManifest> = {}): OfflineSweepManifest {
  return {
    sweepId: "sweep-001",
    generationState: "TRANSPORT_COMPLETE",
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
    sourceProvenance: { adapter: "a".repeat(64) },
    ...overrides
  };
}

function order(orderHash = HASH, overrides: Partial<OfflineLocalOrder> = {}): OfflineLocalOrder {
  return {
    orderHash,
    identity: { orderHash, chain: "gunzilla", contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", tokenId: "1", collectionSlug: "off-the-grid", protocolAddress: "0x0000000000000000000000000000000000000001" },
    status: "active",
    isActive: true,
    needsReconciliation: false,
    lastOrderEventTimestamp: "2026-08-23T12:00:00.000Z",
    lastOrderEventVersion: "1",
    ...overrides
  };
}

function seen(orderHash = HASH): SeenOrder {
  return { sweepId: "sweep-001", orderHash, pageNumber: 1, rawPageHash: "b".repeat(64), normalizedMaterialHash: "c".repeat(64) };
}

function event(overrides: Partial<OfflineJournalEvent> = {}): OfflineJournalEvent {
  return {
    eventId: "1",
    orderHash: HASH,
    eventType: "item_listed",
    eventTimestamp: "2026-08-23T12:00:00.000Z",
    eventVersion: "1",
    receivedAt: "2026-08-23T12:30:00.000Z",
    processingStatus: "applied",
    ...overrides
  };
}

function classify(localOrders: OfflineLocalOrder[], seenOrders: SeenOrder[] = [], journalEvents: OfflineJournalEvent[] = [], manifestOverrides: Partial<OfflineSweepManifest> = {}) {
  return classifyOfflineCandidates({ manifest: manifest(manifestOverrides), seenOrders, localOrders, journalEvents });
}

test("complete manifest is eligible and partial/failed/unsafe manifests are rejected", () => {
  assert.equal(classify([order()], [seen()]).manifestValidation.eligible, true);
  for (const result of ["PARTIAL", "FAILED", "UNSAFE"] as const) {
    const output = classify([order()], [], [], { transportResult: result });
    assert.equal(output.manifestValidation.eligible, false);
    assert.equal(output.orders[0].classification, "BLOCKED");
    assert.ok(output.orders[0].reasons.includes("SNAPSHOT_NOT_COMPLETE"));
  }
});

test("complete manifest with cursor, truncation, malformed, unsupported or conflict is rejected", () => {
  const variants: Partial<OfflineSweepManifest>[] = [
    { nextCursor: "cursor" },
    { truncatedByPageLimit: true },
    { truncatedByListingLimit: true },
    { malformedCount: 1 },
    { unsupportedCount: 1 },
    { conflictCount: 1 },
    { cursorCycleDetected: true },
    { repeatedPageDetected: true },
    { generationState: "CATCHING_UP" }
  ];
  for (const variant of variants) assert.equal(classify([order()], [], [], variant).manifestValidation.eligible, false);
});

test("stable pre-sweep active order absent from complete sweep is only ABSENT_CANDIDATE", () => {
  const output = classify([order()]);
  assert.equal(output.orders[0].classification, "ABSENT_CANDIDATE");
  assert.equal(output.orders[0].authorityGranted, false);
  assert.equal(output.authorityGranted, false);
  assert.match(output.authorityStatement, /DOES NOT AUTHORIZE/);
});

test("exact order hash present is PRESENT", () => {
  const output = classify([order()], [seen()]);
  assert.equal(output.orders[0].classification, "PRESENT");
  assert.equal(output.orders[0].seenInSweep, true);
});

test("new listing after baseline is BLOCKED and never an old absent candidate", () => {
  const output = classify([order()], [], [event({ eventType: "item_listed", receivedAt: "2026-08-23T13:01:00.000Z" })]);
  assert.equal(output.orders[0].classification, "BLOCKED");
  assert.ok(output.orders[0].reasons.includes("NEWER_EVENT_AFTER_BASELINE"));
});

test("newer sold event blocks a previously observed order", () => {
  const output = classify([order()], [seen()], [event({ eventId: "2", eventType: "item_sold", eventTimestamp: "2026-08-23T12:30:00.000Z", eventVersion: "2", receivedAt: "2026-08-23T12:31:00.000Z" })]);
  assert.equal(output.orders[0].classification, "BLOCKED");
  assert.ok(output.orders[0].reasons.includes("TERMINAL_EVENT_PRESENT"));
});

test("newer cancelled event blocks and cannot resurrect an order", () => {
  const output = classify([order()], [seen()], [event({ eventId: "3", eventType: "item_cancelled", eventTimestamp: "2026-08-23T12:30:00.000Z", eventVersion: "2", receivedAt: "2026-08-23T12:31:00.000Z" })]);
  assert.equal(output.orders[0].classification, "BLOCKED");
  assert.ok(output.orders[0].reasons.includes("TERMINAL_EVENT_PRESENT"));
});

test("order created and closed during sweep cannot manufacture deactivation", () => {
  const output = classify([order(HASH, { status: "cancelled", isActive: false, createdAt: "2026-08-23T13:01:00.000Z", updatedAt: "2026-08-23T13:02:00.000Z" })]);
  assert.equal(output.orders[0].classification, "BLOCKED");
  assert.ok(output.orders[0].reasons.includes("ORDER_NOT_ACTIVE"));
});

test("late event inside sweep interval blocks until future catch-up", () => {
  const output = classify([order()], [], [event({ eventId: "late", receivedAt: "2026-08-23T13:05:00.000Z" })]);
  assert.equal(output.orders[0].classification, "BLOCKED");
  assert.ok(output.orders[0].reasons.includes("NEWER_EVENT_AFTER_BASELINE"));
});

test("reconciliation, pending, processing and failed journal states block", () => {
  for (const processingStatus of ["reconciliation_required", "pending", "processing", "failed"] as const) {
    const output = classify([order()], [], [event({ processingStatus, reconciliationRequired: processingStatus === "reconciliation_required" })]);
    assert.equal(output.orders[0].classification, "BLOCKED");
  }
  const needs = classify([order(HASH, { needsReconciliation: true })]);
  assert.ok(needs.orders[0].reasons.includes("NEEDS_RECONCILIATION"));
});

test("incomparable event ordering and order revalidate block", () => {
  const ambiguous = classify([order()], [], [event({ eventTimestamp: null, eventVersion: null, ambiguous: true })]);
  assert.equal(ambiguous.orders[0].classification, "BLOCKED");
  assert.ok(ambiguous.orders[0].reasons.includes("EVENT_ORDERING_AMBIGUOUS"));
  const revalidate = classify([order()], [], [event({ eventType: "order_revalidate", receivedAt: "2026-08-23T12:00:01.000Z" })]);
  assert.equal(revalidate.orders[0].classification, "BLOCKED");
  assert.ok(revalidate.orders[0].reasons.includes("REVALIDATE_UNVERIFIED"));
});

test("inactive orders are blocked", () => {
  const output = classify([order(HASH, { status: "sold", isActive: false })]);
  assert.equal(output.orders[0].classification, "BLOCKED");
  assert.ok(output.orders[0].reasons.includes("ORDER_NOT_ACTIVE"));
});

test("two order hashes sharing a token remain independent", () => {
  const output = classify([order(HASH), order(HASH_2)], [seen(HASH)]);
  assert.deepEqual(output.orders.map((item) => [item.orderHash, item.classification]), [[HASH, "PRESENT"], [HASH_2, "ABSENT_CANDIDATE"]]);
});

test("identity ambiguity blocks duplicate local or seen order hashes", () => {
  const duplicateLocal = classify([order(HASH), order(HASH.toUpperCase())]);
  assert.equal(duplicateLocal.orders.every((item) => item.classification === "BLOCKED"), true);
  const duplicateSeen = classify([order()], [seen(), seen()]);
  assert.equal(duplicateSeen.orders[0].classification, "BLOCKED");
  assert.ok(duplicateSeen.orders[0].reasons.includes("IDENTITY_AMBIGUOUS"));
});

test("invalid local active identity fails closed", () => {
  const output = classify([order("")]);
  assert.equal(output.orders[0].classification, "BLOCKED");
  assert.ok(output.orders[0].reasons.includes("IDENTITY_AMBIGUOUS"));
});

test("output is deterministic and orders/reasons/events are sorted", () => {
  const input = { manifest: manifest(), seenOrders: [seen(HASH_2)], localOrders: [order(HASH_2), order(HASH)], journalEvents: [event({ eventId: "z", orderHash: HASH_2 }), event({ eventId: "a", orderHash: HASH_2 })] };
  const first = classifyOfflineCandidates(input);
  const second = classifyOfflineCandidates(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.orders.map((item) => item.orderHash), [HASH, HASH_2]);
  assert.deepEqual(first.orders[1].relevantJournalEventIds, ["a", "z"]);
});

function compactEvidence() {
  const normalized = { orderHash: HASH, nftId: "gunzilla/contract/1", tokenId: "1", rawListing: { order_hash: HASH } };
  return {
    sourceProvenance: { adapter: "d".repeat(64) },
    snapshot: {
      result: "COMPLETE", startedAt: START, completedAt: END, paginationExhausted: true, nextCursor: null,
      truncatedByPageLimit: false, truncatedByListingLimit: false, cursorCycleDetected: false, repeatedPageDetected: false,
      counters: { malformed: 0, unsupported: 0, conflicts: 0, normalized: 1 },
      rawPages: [{ listings: [{ order_hash: HASH }], next: null }], listings: [normalized], responseHashes: ["e".repeat(64)]
    }
  };
}

test("complete evidence importer is read-only and preserves provenance/material identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "offline-candidate-"));
  const source = path.join(directory, "consumed.json");
  try {
    const value = compactEvidence();
    await writeFile(source, JSON.stringify(value), "utf8");
    const imported = await importActiveListingsEvidenceFile(source, { sweepId: "imported-sweep" });
    assert.equal(imported.manifest.sweepId, "imported-sweep");
    assert.equal(imported.seenOrders.length, 1);
    assert.equal(imported.seenOrders[0].orderHash, HASH);
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), value);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed or non-complete evidence importer fails closed", async () => {
  assert.throws(() => importActiveListingsEvidenceObject({ snapshot: { result: "PARTIAL" } }, { sourceEvidencePath: "fixture", sweepId: "s" }));
  assert.throws(() => importActiveListingsEvidenceObject({ snapshot: { result: "COMPLETE", paginationExhausted: true, nextCursor: null } }, { sourceEvidencePath: "fixture", sweepId: "s" }));
});

test("every result is non-authoritative by type and value", () => {
  const output = classify([order(), order(HASH_2)], [seen()]);
  assert.equal(output.authorityGranted, false);
  assert.equal(output.orders.every((item) => item.authorityGranted === false), true);
  assert.equal("deactivated" in output, false);
});

test("unknown or malformed runtime event types fail closed", () => {
  for (const eventType of ["totally_new_future_event", "", 42, null] as unknown[]) {
    const runtimeEvent = event() as any;
    runtimeEvent.eventType = eventType;
    const output = classify([order()], [], [runtimeEvent]);
    assert.equal(output.orders[0].classification, "BLOCKED");
    assert.ok(output.orders[0].reasons.includes("UNKNOWN_EVENT_TYPE"));
    assert.equal(output.orders[0].authorityGranted, false);
  }
});

test("unknown or malformed runtime processing statuses fail closed", () => {
  for (const processingStatus of ["mystery_state", "", 42, null] as unknown[]) {
    const runtimeEvent = event() as any;
    runtimeEvent.processingStatus = processingStatus;
    const output = classify([order()], [], [runtimeEvent]);
    assert.equal(output.orders[0].classification, "BLOCKED");
    assert.ok(output.orders[0].reasons.includes("UNKNOWN_PROCESSING_STATUS"));
    assert.equal(output.orders[0].authorityGranted, false);
  }
});

test("returned authority-relevant results are deeply immutable at runtime", () => {
  const output = classify([order()], [seen()]);
  const runtimeOutput = output as any;
  const runtimeOrder = runtimeOutput.orders[0];
  for (const attempt of [
    () => { runtimeOutput.authorityGranted = true; },
    () => { runtimeOrder.authorityGranted = true; },
    () => { runtimeOrder.classification = "BLOCKED"; },
    () => { runtimeOrder.reasons.push("IDENTITY_AMBIGUOUS"); },
    () => { runtimeOrder.relevantJournalEventIds.push("injected"); },
    () => { runtimeOutput.orders.push(runtimeOrder); },
    () => { runtimeOutput.sourceProvenance.adapter = "injected"; },
    () => { runtimeOutput.manifestValidation.reasons.push("SNAPSHOT_NOT_COMPLETE"); }
  ]) {
    try { attempt(); } catch { /* strict-mode assignment to frozen output is expected */ }
  }
  assert.equal(output.authorityGranted, false);
  assert.equal(output.orders[0].authorityGranted, false);
  assert.equal(output.orders[0].classification, "PRESENT");
  assert.deepEqual(output.orders[0].reasons, []);
  assert.deepEqual(output.orders[0].relevantJournalEventIds, []);
  assert.equal(output.sourceProvenance.adapter, "a".repeat(64));
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.orders), true);
  assert.equal(Object.isFrozen(output.orders[0]), true);
  assert.equal(Object.isFrozen(output.orders[0].reasons), true);
  assert.equal(Object.isFrozen(output.orders[0].relevantJournalEventIds), true);
  assert.equal(Object.isFrozen(output.sourceProvenance), true);
  assert.equal(Object.isFrozen(output.manifestValidation), true);
});

test("returned explanations do not alias caller-owned input objects", () => {
  const provenance = { adapter: "original" };
  const journalEvent = event();
  const journalEvents = [journalEvent];
  const localOrder = order();
  const seenOrders = [seen()];
  const output = classifyOfflineCandidates({
    manifest: manifest({ sourceProvenance: provenance }),
    seenOrders,
    localOrders: [localOrder],
    journalEvents
  });
  provenance.adapter = "mutated";
  journalEvent.eventType = "item_sold";
  journalEvent.receivedAt = "2026-08-23T14:00:00.000Z";
  localOrder.status = "sold";
  localOrder.isActive = false;
  seenOrders[0].orderHash = HASH_2;
  seenOrders.push(seen(HASH_2));
  assert.equal(output.sourceProvenance.adapter, "original");
  assert.equal(output.orders[0].classification, "PRESENT");
  assert.equal(output.orders[0].relevantEventSummary[0].eventType, "item_listed");
  assert.equal(output.orders[0].relevantEventSummary[0].receivedAt, "2026-08-23T12:30:00.000Z");
  assert.equal(output.orders[0].orderHash, HASH);
});

test("valid absent and present classifications remain non-authoritative", () => {
  const absent = classify([order()]);
  const present = classify([order()], [seen()]);
  assert.equal(absent.orders[0].classification, "ABSENT_CANDIDATE");
  assert.equal(absent.orders[0].authorityGranted, false);
  assert.equal(present.orders[0].classification, "PRESENT");
  assert.equal(present.orders[0].authorityGranted, false);
  assert.equal(present.authorityGranted, false);
});
