import assert from "node:assert/strict";
import test from "node:test";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import { createGenerationWindowScope, PostgresGenerationJournalWindowReader, type GenerationWindowScope } from "../src/reconciliation/generationJournalWindowReader.js";
import { evaluateOfflineGeneration } from "../src/reconciliation/offlineGenerationBarrierModel.js";
import { classifyOfflineCandidates, type OfflineLocalOrder, type OfflineSweepManifest } from "../src/reconciliation/offlineCandidateModel.js";

const CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271";
const PROTOCOL = "0x" + "1".repeat(40);
const HASH = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const identity = (tokenId = "7", orderHash = HASH(900)) => ({ orderHash, chain: "gunzilla" as const, contractAddress: CONTRACT, tokenId, collectionSlug: "off-the-grid" as const, protocolAddress: PROTOCOL });
const scope = (tokenId = "7"): GenerationWindowScope => createGenerationWindowScope([identity(tokenId)]);
const row = (id: number, event_type: string, processing_status: string, overrides: Record<string, unknown> = {}) => ({ event_id: String(id), received_at: "2026-09-14T00:00:00.000Z", event_type, processing_status, order_hash: HASH(id), chain: "gunzilla", contract_address: CONTRACT, token_id: "7", ...overrides });

class FakeClient implements TransactionClient {
  constructor(private readonly db: FakePool, private readonly index: number) {}
  async query<T = unknown>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    const lower = sql.toLowerCase();
    this.db.calls.push({ index: this.index, sql: lower });
    if (/^(begin|set transaction|commit|rollback)/.test(lower)) return { rows: [], rowCount: 0 };
    if (lower.includes("transaction_timestamp")) return { rows: [{ now: this.db.timestamp } as T], rowCount: 1 };
    if (lower.includes("order by event_id desc")) {
      const high = this.db.highs[this.index - 1] ?? 0;
      const found = this.db.rows.find((item) => Number(item.event_id) === high);
      return high === 0 ? { rows: [], rowCount: 0 } : { rows: [{ event_id: String(high), received_at: found?.received_at ?? this.db.timestamp } as T], rowCount: 1 };
    }
    if (lower.includes("where event_id >")) {
      const low = Number(values?.[0]); const high = Number(values?.[1]);
      return { rows: this.db.rows.filter((item) => Number(item.event_id) > low && Number(item.event_id) <= high) as T[], rowCount: this.db.rows.length };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
  release(): void { this.db.released.push(this.index); }
}
class FakePool implements DbPool {
  readonly calls: Array<{ index: number; sql: string }> = [];
  readonly released: number[] = [];
  readonly timestamp = "2026-09-14T00:00:00.000Z";
  private next = 0;
  constructor(public rows: any[] = [], public highs: number[] = [0, 0]) {}
  async connect(): Promise<TransactionClient> { return new FakeClient(this, ++this.next); }
  async query<T = unknown>(): Promise<QueryResult<T>> { return { rows: [], rowCount: 0 }; }
  async end(): Promise<void> {}
}
function candidate(): any {
  const local: OfflineLocalOrder = { orderHash: HASH(900), identity: identity(), status: "active", isActive: true, needsReconciliation: false, lastOrderEventTimestamp: null, lastOrderEventVersion: null, createdAt: null, updatedAt: null };
  const manifest: OfflineSweepManifest = { sweepId: "sweep", generationState: "TRANSPORT_COMPLETE", transportResult: "COMPLETE", snapshotStartedAt: "2026-09-14T00:00:00.000Z", snapshotCompletedAt: "2026-09-14T00:01:00.000Z", paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, sourceProvenance: { fixture: "a".repeat(64) } };
  return classifyOfflineCandidates({ manifest, localOrders: [local], seenOrders: [{ sweepId: "sweep", orderHash: HASH(900), pageNumber: 1, rawPageHash: "b".repeat(64), normalizedMaterialHash: "c".repeat(64) }], journalEvents: [] });
}

test("scope is canonical, immutable, fingerprinted, and rejects arbitrary key inputs", () => {
  const a = scope(); const b = createGenerationWindowScope([identity("7", HASH(900))]);
  assert.equal(a.scopeFingerprint, b.scopeFingerprint);
  assert.equal("nftKeys" in (a as object), false);
  assert.equal("orderHashes" in (a as object), false);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.identities), true);
  assert.notEqual(a.scopeFingerprint, createGenerationWindowScope([identity("8")]).scopeFingerprint);
  for (const input of [[], [identity("7", HASH(900)), identity("7", HASH(900))], [{ ...identity(), protocolAddress: PROTOCOL.toUpperCase() }], [{ ...identity(), contractAddress: "0x" + "a".repeat(40) }], [{ ...identity(), protocolAddress: "0x" + "2".repeat(40) }, identity()]]) assert.throws(() => createGenerationWindowScope(input as any));
});

test("zero journal has deterministic zero watermark", async () => {
  const pool = new FakePool([], [0, 0]);
  const start = await new PostgresGenerationJournalWindowReader(pool).captureStart();
  assert.deepEqual(start.eventHighWaterBefore, { eventId: "0", receivedAt: pool.timestamp });
});

test("historical rows and specialized backlog are excluded by exact window", async () => {
  const rows = Array.from({ length: 1233 }, (_, i) => row(i + 1, "item_transferred", "reconciliation_required", { token_id: "99" }));
  rows.push(...Array.from({ length: 13 }, (_, i) => row(1234 + i, "item_transferred", "pending", { token_id: "99", raw_payload: { payload: { rest_backfill_source: { source: "opensea_rest_events_backfill" } } } })));
  rows.push(row(1247, "item_transferred", "reconciliation_required"), row(1248, "item_transferred", "pending", { token_id: "99" }));
  const pool = new FakePool(rows, [1233, 1248]); const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); const observed = await reader.observe(start, scope());
  assert.equal(observed.round.reconciliationRequiredCount, 1); assert.equal(observed.round.pendingCount, 0); assert.ok(observed.eventIds.includes("1247")); assert.ok(!observed.eventIds.includes("1233"));
});

test("matching transfer blocks and unrelated canonical transfer does not", async () => {
  const pool = new FakePool([row(1, "item_transferred", "reconciliation_required"), row(2, "item_transferred", "reconciliation_required", { token_id: "8" }), row(3, "item_transferred", "reconciliation_required", { chain: "ethereum" }), row(4, "item_transferred", "reconciliation_required", { contract_address: "0x" + "a".repeat(40) })], [0, 4]);
  const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); const observed = await reader.observe(start, scope());
  assert.equal(observed.round.reconciliationRequiredCount, 1); assert.deepEqual(observed.eventIds, ["1"]);
});

test("all order lifecycle events are collection-wide and new listing races are relevant", async () => {
  const rows = ["item_listed", "item_sold", "item_cancelled", "order_invalidate", "order_revalidate"].map((type, i) => row(i + 1, type, "pending", { order_hash: HASH(700 + i) }));
  const pool = new FakePool(rows, [0, 5]); const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); const observed = await reader.observe(start, scope());
  assert.equal(observed.round.pendingCount, 5); assert.deepEqual(observed.eventIds, ["1", "2", "3", "4", "5"]);
});

test("processing statuses map and unknown status is fail-closed in the round", async () => {
  const pool = new FakePool([row(1, "item_listed", "pending"), row(2, "item_listed", "processing"), row(3, "item_listed", "failed"), row(4, "item_listed", "reconciliation_required"), row(5, "item_listed", "applied"), row(6, "item_listed", "ignored_duplicate"), row(7, "item_listed", "ignored_older"), row(8, "item_listed", "mystery")], [0, 8]);
  const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); const observed = await reader.observe(start, scope());
  assert.deepEqual(observed.round, { roundNumber: 1, observedHighWater: { eventId: "8", receivedAt: pool.timestamp }, pendingCount: 1, processingCount: 1, failedCount: 1, reconciliationRequiredCount: 1, unknownStatusCount: 1 });
});

test("malformed possibly-supported identities fail, canonical outside scope does not", async () => {
  for (const bad of [row(1, "item_transferred", "pending", { token_id: null }), row(1, "item_transferred", "pending", { token_id: "-1" }), row(1, "item_listed", "pending", { order_hash: null }), row(1, "item_listed", "pending", { contract_address: "bad" })]) {
    const pool = new FakePool([bad], [0, 1]); const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); await assert.rejects(() => reader.observe(start, scope()), /GENERATION_WINDOW_MALFORMED_IDENTITY/);
  }
});

test("watermark regression is rejected and rollback is attempted", async () => {
  const pool = new FakePool([row(1, "item_listed", "pending")], [5, 1]); const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); await assert.rejects(() => reader.observe(start, scope()), /GENERATION_WINDOW_WATERMARK_REGRESSION/); assert.ok(pool.calls.some((call) => call.sql.startsWith("rollback")));
});

test("high-water and counts use the same repeatable-read client", async () => {
  const pool = new FakePool([row(1, "item_listed", "pending")], [0, 1]); const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); await reader.observe(start, scope()); const windowCalls = pool.calls.filter((call) => call.sql.includes("order by event_id") || call.sql.includes("where event_id >")); assert.equal(windowCalls[1].index, windowCalls[2].index); assert.ok(pool.calls.some((call) => call.sql.includes("repeatable read"))); assert.ok(pool.calls.some((call) => call.sql.startsWith("commit")));
});

test("matching unresolved transfer makes accepted generation evaluation unsafe", async () => {
  const pool = new FakePool([row(1, "item_transferred", "reconciliation_required")], [0, 1]); const reader = new PostgresGenerationJournalWindowReader(pool); const start = await reader.captureStart(); const observed = await reader.observe(start, scope()); const result = evaluateOfflineGeneration({ sweepId: "sweep", snapshotStartedAt: "2026-09-14T00:00:00.000Z", snapshotCompletedAt: "2026-09-14T00:01:00.000Z", sourceProvenance: { fixture: "a".repeat(64) }, startBarrier: { sweepId: "sweep", snapshotStartedAt: "2026-09-14T00:00:00.000Z", eventHighWaterBefore: start.eventHighWaterBefore }, endBarrier: { snapshotCompletedAt: "2026-09-14T00:01:00.000Z", eventHighWaterAfter: observed.observedHighWater }, transport: { transportResult: "COMPLETE", snapshotStartedAt: "2026-09-14T00:00:00.000Z", snapshotCompletedAt: "2026-09-14T00:01:00.000Z", paginationExhausted: true, nextCursor: null, truncatedByPageLimit: false, truncatedByListingLimit: false, malformedCount: 0, unsupportedCount: 0, conflictCount: 0, cursorCycleDetected: false, repeatedPageDetected: false, warnings: [], errors: [], sourceProvenance: { fixture: "a".repeat(64) }, pageAttempts: 1, pagesFetched: 1, httpAttempts: 1, retryAttempts: 0, rawPagesCount: 1, responseHashesCount: 1, observedCount: 1, normalizedCount: 1, pageAttemptDetailsCount: 1, successfulPageAttempts: 1 }, catchUpRounds: [observed.round, { ...observed.round, roundNumber: 2 }], maxCatchUpRounds: 2, candidateBundle: candidate() }); assert.notEqual(result.catchUp.outcome, "STABLE");
});
