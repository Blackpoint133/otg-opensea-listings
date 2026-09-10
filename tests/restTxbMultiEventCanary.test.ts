import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  MULTI_REST_TXB_AMBIGUOUS_APPLY_RESULT,
  MULTI_REST_TXB_CONFIRMATIONS,
  MULTI_REST_TXB_EXPECTED,
  MULTI_REST_TXB_EXPECTED_APPLY_RESULT,
  MULTI_REST_TXB_ORDERED_IDS,
  MULTI_REST_TXB_TARGET_IDS,
  canonicalizeMultiRestTxbNftTimestamp,
  mapMultiRestTxbNftRow,
  loadRestTxbMultiEventConfig,
  runRestTxbMultiEventCanary,
  validateMultiRestTxbEventSuccess,
  type MultiRestTxbSnapshot
} from "../src/canary/restTxbMultiEventCanary.js";
import type { DbPool, PendingInboxApplyResult, QueryResult, TransactionClient } from "../src/db/types.js";

function tempDir(): string { return path.join(os.tmpdir(), `otg-rest-txb-multi-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`); }
const flags = [...MULTI_REST_TXB_CONFIRMATIONS];
const args = [...flags, "--event-ids", "84,85"];

class FakePool implements DbPool {
  async connect(): Promise<TransactionClient> { throw new Error("real pool connection is forbidden in tests"); }
  async end(): Promise<void> {}
  async query<Row = unknown>(text: string): Promise<QueryResult<Row>> {
    if (text.includes("current_database")) return { rows: [{ database: "server_otg" }] as Row[], rowCount: 1 };
    if (text.includes("to_regclass")) return { rows: [{ ok: true }] as Row[], rowCount: 1 };
    throw new Error(`unexpected test query: ${text}`);
  }
}

function raw(id: "84" | "85"): any {
  const expected = MULTI_REST_TXB_EXPECTED[id];
  return { event_type: "item_transferred", version: null, payload: { event_timestamp: expected.eventTimestamp, transaction: { hash: expected.transactionHash, timestamp: expected.eventTimestamp }, item: { nft_id: `gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/${expected.tokenId}`, metadata: {} }, from_account: { address: "0x0000000000000000000000000000000000000000" }, to_account: { address: expected.canonicalTo }, rest_backfill_source: { source: "opensea_rest_events_backfill", transfer_type: "mint" } } };
}

function target(id: "84" | "85", applied: boolean, validationErrors: string[] = []): any {
  const expected = MULTI_REST_TXB_EXPECTED[id];
  return {
    event: { eventId: id, eventType: "item_transferred", eventTimestamp: expected.eventTimestamp, eventVersion: null, chain: "gunzilla", contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", tokenId: expected.tokenId, transactionHash: expected.transactionHash, dedupeKey: expected.dedupeKey, rawPayload: raw(id), processingStatus: applied ? "reconciliation_required" : "pending", attemptCount: applied ? 1 : 0, nextRetryAt: null, applyResult: applied ? MULTI_REST_TXB_EXPECTED_APPLY_RESULT : null, appliedAt: applied ? "2026-08-15T15:00:00.000Z" : null, processingStartedAt: null, lastErrorCode: null, lastErrorMessage: null, restSource: "opensea_rest_events_backfill", rawTransferType: "mint", canonicalFrom: "0x0000000000000000000000000000000000000000", canonicalTo: expected.canonicalTo },
    nftState: applied ? { chain: "gunzilla", contractAddress: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", tokenId: expected.tokenId, nftId: `gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/${expected.tokenId}`, collectionSlug: "off-the-grid", currentOwnerAddress: expected.canonicalTo, lastTransferFromAddress: "0x0000000000000000000000000000000000000000", lastTransferToAddress: expected.canonicalTo, lastTransferTransactionHash: expected.transactionHash, lastTransferAt: expected.eventTimestamp, lastNftEventTimestamp: expected.eventTimestamp, lastNftEventVersion: null } : null,
    activeOrders: [], attempts: [], dedupeRows: [{ eventId: id, processingStatus: applied ? "reconciliation_required" : "pending", dedupeKey: expected.dedupeKey }], sameSecondCandidates: [], classification: { eventId: id, dedupeKey: expected.dedupeKey, classification: applied ? "DUPLICATE_EXISTING" : "SAFE", reason: applied ? "existing_non_pending_lifecycle" : "no_same_second_distinct_transaction" }, validationErrors
  };
}

function fakeSnapshot(state: Set<string>, ids: readonly string[], errors: Record<string, string[]> = {}): MultiRestTxbSnapshot {
  const targets = Object.fromEntries(ids.map((id) => [id, target(id as "84" | "85", state.has(id), errors[id] ?? [])]));
  return { counts: { database: "server_otg", journal: 67, pending: 17 - state.size, processing: 0, failed: 0, reconciliationRequired: 50 + state.size, unfinalized: 17 - state.size, attemptLedger: 0, nftState: 50 + state.size, orders: 0 }, targets, candidateCoverageComplete: true, protectedBoundarySeconds: ["2026-08-13T10:55:44.000Z", "2026-08-13T10:55:45.000Z"], releaseEvidence: { window: { after: 1786618485, before: 1786618545 }, queryEventTypes: ["transfer"], files: [], combinedSha256: "a".repeat(64), transportComplete: true, semanticCoverageComplete: true, txAAdmissionComplete: true, candidateCoverageComplete: true, releaseEligible: true, event82Classification: "SAFE" }, validationErrors: [] };
}

function provenance(): any { return { packageVersion: "0.1.0", nodeVersion: "v-test", sourceFiles: [], sourceCombinedSha256: "a".repeat(64), runtimeFiles: [], runtimeCombinedSha256: "b".repeat(64) }; }

function config(): any { const dir = tempDir(); return { dir, config: loadRestTxbMultiEventConfig([...args, "--output-dir", dir]) }; }

async function runFake(options: { snapshot?: (state: Set<string>, ids: readonly string[]) => MultiRestTxbSnapshot; apply?: (id: string, state: Set<string>) => Promise<PendingInboxApplyResult>; guard?: any; appendEvent?: (dir: string, value: any) => Promise<void>; writeSummary?: (dir: string, value: unknown) => Promise<void>; retain?: boolean } = {}) {
  const { dir, config: canaryConfig } = config();
  const state = new Set<string>();
  const calls: string[] = [];
  const snapshots: ((ids: readonly string[]) => MultiRestTxbSnapshot)[] = [];
  const guard = options.guard ?? { held: true, releaseCalls: 0, async release() { this.releaseCalls += 1; this.held = false; } };
  const snapshot = options.snapshot ?? ((s: Set<string>, ids: readonly string[]) => fakeSnapshot(s, ids));
  try {
    const summary = await runRestTxbMultiEventCanary(canaryConfig, { pool: new FakePool(), computeProvenance: provenance, acquireRuntimeGuard: async () => guard, collectSnapshot: async (_pool, ids) => { snapshots.push((ids) => snapshot(state, ids)); return snapshot(state, ids); }, applyEvent: async (_pool, id) => { calls.push(id); if (options.apply) return options.apply(id, state); state.add(id); return { outcome: "reconciliation_required", eventId: id, eventType: "item_transferred", dedupeKey: MULTI_REST_TXB_EXPECTED[id as "84" | "85"].dedupeKey, processingStatus: "reconciliation_required", attemptCount: 1, applyResult: MULTI_REST_TXB_EXPECTED_APPLY_RESULT }; }, appendEvent: options.appendEvent, writeSummary: options.writeSummary });
    return { summary, calls, state, guard, dir, snapshots };
  } catch (error) { throw error; } finally { if (!options.retain) fs.rmSync(dir, { recursive: true, force: true }); }
}

test("multi-event CLI accepts only exact 84,85 target set", () => {
  const { dir, config: canaryConfig } = config();
  try { assert.deepEqual(canaryConfig.eventIds, MULTI_REST_TXB_TARGET_IDS); assert.deepEqual(MULTI_REST_TXB_ORDERED_IDS, ["85", "84"]); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const bad of ["82", "84", "85", "85,84", "84,85,86", "84-85", "84,84"]) {
  test(`multi-event rejects target syntax ${bad}`, () => { const dir = tempDir(); fs.mkdirSync(dir, { recursive: true }); try { assert.throws(() => loadRestTxbMultiEventConfig([...flags, "--event-ids", bad, "--output-dir", dir])); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
}

test("multi-event rejects unknown arguments and missing gates", () => {
  const dir = tempDir(); fs.mkdirSync(dir, { recursive: true });
  try { assert.throws(() => loadRestTxbMultiEventConfig([...args, "--unknown", "x", "--output-dir", dir])); assert.throws(() => loadRestTxbMultiEventConfig(["--event-ids", "84,85", "--output-dir", dir])); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("clean SAFE run calls exactly 85 then 84 and completes", async () => {
  const result = await runFake();
  assert.deepEqual(result.calls, ["85", "84"]);
  assert.deepEqual(result.summary.committedEventIds, ["85", "84"]);
  assert.equal(result.summary.txBCallCount, 2);
  assert.equal(result.summary.result, "MULTI_REST_TXB_COMPLETE");
  assert.deepEqual(result.summary.unattemptedEventIds, []);
});

test("clean run persists exactly five files and final summary equals returned summary", async () => {
  const result = await runFake({ retain: true });
  try {
    assert.deepEqual(fs.readdirSync(result.dir).sort(), ["multi_txb_events.jsonl", "multi_txb_plan.json", "multi_txb_postflight.json", "multi_txb_preflight.json", "multi_txb_summary.json"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.dir, "multi_txb_summary.json"), "utf8")), result.summary);
    assert.equal(fs.readFileSync(path.join(result.dir, "multi_txb_events.jsonl"), "utf8").trim().split(/\r?\n/).length, 2);
  } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
});

test("entire plan failure aborts before either Tx B call", async () => {
  const result = await runFake({ snapshot: (state, ids) => fakeSnapshot(state, ids, ids.includes("84") ? { "84": ["nft_state_exists"] } : {}) });
  assert.deepEqual(result.calls, []);
  assert.equal(result.summary.result, "MULTI_REST_TXB_ABORTED_PREFLIGHT");
});

test("runtime guard acquisition failure produces zero calls", async () => {
  const result = await runFake({ guard: Promise.reject(new Error("runtime_conflict")) as any });
  assert.deepEqual(result.calls, []);
  assert.equal(result.summary.result, "MULTI_REST_TXB_FAILED");
});

test("guard is released once after both events", async () => {
  const guard = { held: true, releaseCalls: 0, async release() { this.releaseCalls += 1; this.held = false; } };
  const result = await runFake({ guard });
  assert.equal(result.guard.releaseCalls, 1);
});

test("no snapshot or mutation-capable work occurs after guard release", async () => {
  const guard = { held: true, releaseCalls: 0, async release() { this.releaseCalls += 1; this.held = false; } };
  const result = await runFake({ guard, snapshot: (state, ids) => { assert.equal(guard.held, true); return fakeSnapshot(state, ids); } });
  assert.equal(result.summary.guardReleaseSucceeded, true);
  assert.equal(result.summary.result, "MULTI_REST_TXB_COMPLETE");
});

test("event 84 revalidation failure preserves event 85 prefix and does not call 84", async () => {
  const result = await runFake({ snapshot: (state, ids) => state.has("85") && ids.includes("84") ? fakeSnapshot(state, ids, { "84": ["active_orders_exist"] }) : fakeSnapshot(state, ids) });
  assert.deepEqual(result.calls, ["85"]);
  assert.deepEqual(result.summary.committedEventIds, ["85"]);
  assert.equal(result.summary.result, "MULTI_REST_TXB_PARTIAL");
});

test("first event ambiguity stops before event 84", async () => {
  const result = await runFake({ apply: async (id) => ({ outcome: "reconciliation_required", eventId: id, eventType: "item_transferred", dedupeKey: MULTI_REST_TXB_EXPECTED[id as "84" | "85"].dedupeKey, processingStatus: "reconciliation_required", attemptCount: 1, applyResult: MULTI_REST_TXB_AMBIGUOUS_APPLY_RESULT }) });
  assert.deepEqual(result.calls, ["85"]);
  assert.equal(result.summary.result, "MULTI_REST_TXB_SAFE_STOP_AMBIGUOUS");
  assert.deepEqual(result.summary.unattemptedEventIds, ["84"]);
});

test("second event ambiguity preserves safe committed prefix", async () => {
  const result = await runFake({ apply: async (id, state) => { if (id === "85") { state.add(id); return { outcome: "reconciliation_required", eventId: id, eventType: "item_transferred", dedupeKey: MULTI_REST_TXB_EXPECTED[id].dedupeKey, processingStatus: "reconciliation_required", attemptCount: 1, applyResult: MULTI_REST_TXB_EXPECTED_APPLY_RESULT }; } return { outcome: "reconciliation_required", eventId: id, eventType: "item_transferred", dedupeKey: MULTI_REST_TXB_EXPECTED[id].dedupeKey, processingStatus: "reconciliation_required", attemptCount: 1, applyResult: MULTI_REST_TXB_AMBIGUOUS_APPLY_RESULT }; } });
  assert.deepEqual(result.calls, ["85", "84"]);
  assert.deepEqual(result.summary.committedEventIds, ["85"]);
  assert.equal(result.summary.result, "MULTI_REST_TXB_SAFE_STOP_AMBIGUOUS");
});

test("first and second transaction errors stop without retry", async () => {
  const first = await runFake({ apply: async () => { throw new Error("tx failure"); } });
  assert.deepEqual(first.calls, ["85"]); assert.equal(first.summary.result, "MULTI_REST_TXB_FAILED");
  const second = await runFake({ apply: async (id, state) => { if (id === "85") { state.add(id); return { outcome: "reconciliation_required", eventId: id, eventType: "item_transferred", dedupeKey: MULTI_REST_TXB_EXPECTED[id].dedupeKey, processingStatus: "reconciliation_required", attemptCount: 1, applyResult: MULTI_REST_TXB_EXPECTED_APPLY_RESULT }; } throw new Error("tx failure"); } });
  assert.deepEqual(second.calls, ["85", "84"]); assert.deepEqual(second.summary.committedEventIds, ["85"]); assert.equal(second.summary.result, "MULTI_REST_TXB_PARTIAL");
});

test("first event JSONL failure records committed prefix before persistence", async () => {
  const result = await runFake({ appendEvent: async (_dir, value) => { if (value.eventId === "85") throw new Error("jsonl fsync failure"); } });
  assert.deepEqual(result.calls, ["85"]);
  assert.deepEqual(result.summary.attemptedEventIds, ["85"]);
  assert.deepEqual(result.summary.committedEventIds, ["85"]);
  assert.deepEqual(result.summary.unattemptedEventIds, ["84"]);
  assert.equal(result.summary.stopEventId, "85");
  assert.match(result.summary.stopReason ?? "", /event_evidence_write_failed/);
  assert.equal(result.summary.eventEvidenceWriteComplete, false);
  assert.equal(result.summary.result, "MULTI_REST_TXB_PARTIAL");
});

test("second event JSONL failure preserves both committed events and stops", async () => {
  const result = await runFake({ appendEvent: async (_dir, value) => { if (value.eventId === "84") throw new Error("jsonl append failure"); } });
  assert.deepEqual(result.calls, ["85", "84"]);
  assert.deepEqual(result.summary.attemptedEventIds, ["85", "84"]);
  assert.deepEqual(result.summary.committedEventIds, ["85", "84"]);
  assert.deepEqual(result.summary.unattemptedEventIds, []);
  assert.equal(result.summary.stopEventId, "84");
  assert.equal(result.summary.result, "MULTI_REST_TXB_PARTIAL");
});

test("transaction throw never creates a false committed prefix", async () => {
  const result = await runFake({ apply: async () => { throw new Error("rollback before commit"); } });
  assert.deepEqual(result.summary.attemptedEventIds, ["85"]);
  assert.deepEqual(result.summary.committedEventIds, []);
  assert.deepEqual(result.calls, ["85"]);
  assert.equal(result.summary.result, "MULTI_REST_TXB_FAILED");
});

test("guard release failure with no committed events is persisted and non-success", async () => {
  const guard = { held: true, releaseCalls: 0, async release() { this.releaseCalls += 1; throw new Error("unlock failure"); } };
  const result = await runFake({ guard, apply: async () => { throw new Error("rollback before commit"); }, retain: true });
  try {
    const persisted = JSON.parse(fs.readFileSync(path.join(result.dir, "multi_txb_summary.json"), "utf8"));
    assert.equal(result.summary.guardReleaseAttempted, true);
    assert.equal(result.summary.guardReleaseSucceeded, false);
    assert.match(result.summary.guardReleaseError ?? "", /unlock failure/);
    assert.equal(result.summary.result, "MULTI_REST_TXB_FAILED");
    assert.deepEqual(persisted, result.summary);
  } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
});

test("guard release failure after one commit yields persisted PARTIAL", async () => {
  const guard = { held: true, releaseCalls: 0, async release() { this.releaseCalls += 1; throw new Error("unlock failure after prefix"); } };
  const result = await runFake({ guard, snapshot: (state, ids) => state.has("85") && ids.includes("84") ? fakeSnapshot(state, ids, { "84": ["active_orders_exist"] }) : fakeSnapshot(state, ids), retain: true });
  try {
    const persisted = JSON.parse(fs.readFileSync(path.join(result.dir, "multi_txb_summary.json"), "utf8"));
    assert.deepEqual(result.summary.committedEventIds, ["85"]);
    assert.equal(result.summary.result, "MULTI_REST_TXB_PARTIAL");
    assert.equal(result.summary.guardReleaseSucceeded, false);
    assert.deepEqual(persisted, result.summary);
  } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
});

test("guard release failure after two commits cannot complete", async () => {
  const guard = { held: true, releaseCalls: 0, async release() { this.releaseCalls += 1; throw new Error("unlock failure after two commits"); } };
  const result = await runFake({ guard, retain: true });
  try {
    const persisted = JSON.parse(fs.readFileSync(path.join(result.dir, "multi_txb_summary.json"), "utf8"));
    assert.deepEqual(result.summary.committedEventIds, ["85", "84"]);
    assert.equal(result.summary.result, "MULTI_REST_TXB_PARTIAL");
    assert.equal(result.summary.guardReleaseAttempted, true);
    assert.equal(result.summary.guardReleaseSucceeded, false);
    assert.deepEqual(persisted, result.summary);
  } finally { fs.rmSync(result.dir, { recursive: true, force: true }); }
});

test("summary evidence failure is non-success and does not retry", async () => {
  const result = await runFake({ writeSummary: async () => { throw new Error("evidence failure"); } });
  assert.deepEqual(result.calls, ["85", "84"]); assert.deepEqual(result.summary.committedEventIds, ["85", "84"]); assert.equal(result.summary.result, "MULTI_REST_TXB_PARTIAL"); assert.equal(result.summary.evidenceWriteComplete, false); assert.equal(result.summary.summaryWriteComplete, false);
});

test("source and package isolate multi-event operator from worker, REST, Tx A, Stream and event 82", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../src/canary/restTxbMultiEventCanary.ts"), "utf8");
  assert.match(source, /applyPendingInboxEvent/); assert.match(source, /acquireV2RuntimeGuard/); assert.doesNotMatch(source, /selectNextDuePendingInboxEvent|persistRawEventToInbox|OpenSea|Stream|eventId.*82/);
  assert.doesNotMatch(source, /for \(const id of \[.*82/);
});

test("actual event85 PostgreSQL NFT timestamps canonicalize at the multi-event snapshot boundary", () => {
  const row = { chain: "gunzilla", contract_address: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", token_id: "48804195", nft_id: "gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/48804195", collection_slug: "off-the-grid", current_owner_address: MULTI_REST_TXB_EXPECTED["85"].canonicalTo, last_transfer_from_address: "0x0000000000000000000000000000000000000000", last_transfer_to_address: MULTI_REST_TXB_EXPECTED["85"].canonicalTo, last_transfer_transaction_hash: MULTI_REST_TXB_EXPECTED["85"].transactionHash, last_transfer_at: "2026-08-13 03:55:39-07", last_nft_event_timestamp: "2026-08-13 03:55:39-07", last_nft_event_version: null };
  const mapped = mapMultiRestTxbNftRow(row);
  assert.equal(mapped.lastTransferAt, "2026-08-13T10:55:39.000Z");
  assert.equal(mapped.lastNftEventTimestamp, "2026-08-13T10:55:39.000Z");
  const before = fakeSnapshot(new Set(), ["85"]);
  const after = fakeSnapshot(new Set(["85"]), ["85"]);
  after.targets["85"].nftState = mapped;
  const result = validateMultiRestTxbEventSuccess(before, after, { outcome: "reconciliation_required", eventId: "85", eventType: "item_transferred", dedupeKey: MULTI_REST_TXB_EXPECTED["85"].dedupeKey, processingStatus: "reconciliation_required", attemptCount: 1, applyResult: MULTI_REST_TXB_EXPECTED_APPLY_RESULT }, "85");
  assert.equal(result.includes("nft_final_state_mismatch"), false);
});

test("NFT timestamp canonicalizer is timezone-independent and preserves supported fractional precision", () => {
  assert.equal(canonicalizeMultiRestTxbNftTimestamp("2026-08-13 03:55:39.1-07"), "2026-08-13T10:55:39.100Z");
  assert.equal(canonicalizeMultiRestTxbNftTimestamp("2026-08-13 03:55:39.123-07"), "2026-08-13T10:55:39.123Z");
  assert.equal(canonicalizeMultiRestTxbNftTimestamp("2026-08-13 03:55:39.123456-07"), "2026-08-13T10:55:39.123456Z");
  assert.equal(canonicalizeMultiRestTxbNftTimestamp("2026-08-13 03:55:39+00"), "2026-08-13T03:55:39.000Z");
  assert.equal(canonicalizeMultiRestTxbNftTimestamp("2026-08-13 03:55:39+05"), "2026-08-12T22:55:39.000Z");
  assert.equal(canonicalizeMultiRestTxbNftTimestamp("2026-08-13 03:55:39+05:00"), "2026-08-12T22:55:39.000Z");
  assert.equal(canonicalizeMultiRestTxbNftTimestamp("2026-08-13 03:55:39-07:00"), "2026-08-13T10:55:39.000Z");
});

test("invalid or timezone-less NFT timestamps fail closed", () => {
  for (const value of ["", "nonsense", "2026-08-13 03:55:39", "2026-13-99 03:55:39-07", "2026-08-13 03:55:39-24", "2026-08-13 25:00:00-07"]) assert.equal(canonicalizeMultiRestTxbNftTimestamp(value), null);
});

test("strict NFT validation still rejects a genuinely different timestamp and other identity fields", () => {
  const before = fakeSnapshot(new Set(), ["85"]);
  const after = fakeSnapshot(new Set(["85"]), ["85"]);
  const expectedNft = after.targets["85"].nftState!;
  const applied = { outcome: "reconciliation_required" as const, eventId: "85", eventType: "item_transferred", dedupeKey: MULTI_REST_TXB_EXPECTED["85"].dedupeKey, processingStatus: "reconciliation_required" as const, attemptCount: 1, applyResult: MULTI_REST_TXB_EXPECTED_APPLY_RESULT };
  for (const [field, value] of [["lastNftEventTimestamp", "2026-08-13T10:55:40.000Z"], ["currentOwnerAddress", "0xwrong"], ["lastTransferFromAddress", "0xwrong"], ["lastTransferToAddress", "0xwrong"], ["lastTransferTransactionHash", "0xwrong"], ["lastNftEventVersion", "1"]] as const) {
    after.targets["85"].nftState = { ...expectedNft, [field]: value };
    assert.equal(validateMultiRestTxbEventSuccess(before, after, applied, "85").includes("nft_final_state_mismatch"), true, field);
  }
});
