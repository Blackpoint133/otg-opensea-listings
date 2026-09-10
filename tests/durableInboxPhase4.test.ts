import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  calculateNextRetryAt,
  classifyInboxApplicationError,
  DEFAULT_INBOX_RETRY_POLICY,
  getDurableInboxMetrics,
  recordInboxRetryAfterFailure,
  recordInboxRetryAfterFailureInTransaction,
  recoverStaleProcessingRows,
  recoverStaleProcessingRowsInTransaction,
  selectNextDuePendingInboxEvent
} from "../src/db/inboxRetryRepository.js";
import { prepareDurableInboxOnStartup, runDurableInboxWorkerOnce } from "../src/worker/durableInboxWorker.js";
import type { DbPool, JournalProcessingStatus, QueryResult, TransactionClient } from "../src/db/types.js";

const now = "2026-08-12T12:00:00.000Z";
const attemptA = "11111111-1111-4111-8111-111111111111";
const attemptB = "22222222-2222-4222-8222-222222222222";
const attemptC = "33333333-3333-4333-8333-333333333333";
const attemptD = "44444444-4444-4444-8444-444444444444";
const attemptE = "55555555-5555-4555-8555-555555555555";

class RetryClient implements TransactionClient {
  calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  nextRetryAt: string | null = null;
  lastErrorCode: string | null = null;
  applyResult: string | null = null;
  recordedAttempts = new Set<string>();
  constructor(public status: JournalProcessingStatus = "pending", public attemptCount = 0, public rowExists = true) {}

  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    if (/SELECT event_id::text, processing_status, attempt_count[\s\S]*FOR UPDATE/.test(text)) {
      return {
        rows: (this.rowExists ? [{ event_id: "501", processing_status: this.status, attempt_count: this.attemptCount }] : []) as Row[],
        rowCount: this.rowExists ? 1 : 0
      };
    }
    if (/SELECT EXISTS \([\s\S]*opensea_listings_events_v2_attempts/.test(text)) {
      return { rows: [{ exists: this.recordedAttempts.has(values[1] as string) }] as Row[], rowCount: 1 };
    }
    if (/INSERT INTO public\.opensea_listings_events_v2_attempts/.test(text)) {
      const attemptId = values[1] as string;
      if (this.recordedAttempts.has(attemptId)) return { rows: [] as Row[], rowCount: 0 };
      this.recordedAttempts.add(attemptId);
      return { rows: [{ attempt_id: attemptId }] as Row[], rowCount: 1 };
    }
    if (/WITH selected AS/.test(text)) return { rows: [] as Row[], rowCount: 2 };
    if (/SET processing_status = 'failed'/.test(text)) {
      this.status = "failed";
      this.attemptCount = values[1] as number;
      this.lastErrorCode = values[3] as string;
      this.applyResult = values[5] as string;
      return { rows: [{ event_id: "501", processing_status: "failed", attempt_count: this.attemptCount }] as Row[], rowCount: 1 };
    }
    if (/SET processing_status = 'pending'/.test(text)) {
      this.status = "pending";
      this.attemptCount = values[1] as number;
      this.nextRetryAt = values[3] as string;
      this.lastErrorCode = values[4] as string;
      this.applyResult = null;
      return { rows: [{ event_id: "501", processing_status: "pending", attempt_count: this.attemptCount }] as Row[], rowCount: 1 };
    }
    return { rows: [] as Row[], rowCount: 1 };
  }

  release(): void {
    this.released = true;
  }
}

class RetryPool implements DbPool {
  dueIds: string[] = [];
  metricsRow: Record<string, unknown> | null = null;
  queryCalls: Array<{ text: string; values: readonly unknown[] }> = [];
  constructor(public client: RetryClient = new RetryClient()) {}
  async connect(): Promise<TransactionClient> { return this.client; }
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.queryCalls.push({ text, values });
    if (/ORDER BY received_at ASC/.test(text)) return { rows: this.dueIds.map((event_id) => ({ event_id })) as Row[], rowCount: this.dueIds.length };
    if (/COUNT\(\*\) FILTER/.test(text)) {
      return {
        rows: [this.metricsRow ?? {
          pending_total: "3",
          pending_due: "1",
          pending_scheduled: "2",
          processing_total: "1",
          stale_processing: "1",
          failed_total: "4",
          reconciliation_required_total: "25",
          applied_total: "7",
          ignored_older_total: "2",
          oldest_pending_received_at: "2026-08-12T11:50:00.000Z",
          oldest_due_received_at: "2026-08-12T11:55:00.000Z",
          max_attempt_count: "5"
        }] as Row[],
        rowCount: 1
      };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
  async end(): Promise<void> {}
}

test("retry classifier treats known transient PostgreSQL and network errors as retryable with sanitized evidence", () => {
  assert.equal(classifyInboxApplicationError(Object.assign(new Error("deadlock password=secret"), { code: "40P01" })).kind, "retryable");
  assert.equal(classifyInboxApplicationError(Object.assign(new Error("reset token=secret"), { code: "ECONNRESET" })).kind, "retryable");
  const classified = classifyInboxApplicationError(Object.assign(new Error("bad api_key=secret"), { code: "BAD_DATA", nonRetryable: true }));
  assert.equal(classified.kind, "non_retryable");
  assert.doesNotMatch(classified.message, /secret/);
});

test("backoff calculates deterministic bounded retry timestamps and rejects invalid policy", () => {
  const policy = { maxAttempts: 5, baseDelayMs: 5_000, maxDelayMs: 300_000, jitterRatio: 0.2 };
  assert.equal(calculateNextRetryAt(now, 1, policy, () => 0), "2026-08-12T12:00:05.000Z");
  assert.equal(calculateNextRetryAt(now, 2, policy, () => 0), "2026-08-12T12:00:10.000Z");
  assert.equal(calculateNextRetryAt(now, 3, policy, () => 1), "2026-08-12T12:00:24.000Z");
  assert.equal(calculateNextRetryAt(now, 20, policy, () => 1), "2026-08-12T12:05:00.000Z");
  assert.throws(() => calculateNextRetryAt(now, 1, { ...policy, maxAttempts: 0 }, () => 0), /maxAttempts/);
});

test("retry recording uses a separate transaction and schedules retry after rolled-back Tx B", async () => {
  const client = new RetryClient("pending", 0);
  const result = await recordInboxRetryAfterFailure(new RetryPool(client), "501", attemptA, Object.assign(new Error("connection password=secret failed"), { code: "08006" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  assert.equal(result.outcome, "retry_scheduled");
  assert.equal(result.processingStatus, "pending");
  assert.equal(result.attemptCount, 1);
  assert.equal(result.nextRetryAt, "2026-08-12T12:00:05.000Z");
  assert.equal(client.lastErrorCode, "08006");
  assert.equal(client.applyResult, null);
  assert.deepEqual(client.calls.map((call) => call.text.split(/\s+/)[0]), ["BEGIN", "SELECT", "SELECT", "INSERT", "UPDATE", "COMMIT"]);
  assert.equal(client.released, true);
});

test("retry recording increments attempt_count once per failed infrastructure attempt", async () => {
  const client = new RetryClient("pending", 1);
  const result = await recordInboxRetryAfterFailureInTransaction(client, "501", attemptB, Object.assign(new Error("deadlock"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  assert.equal(result.outcome, "retry_scheduled");
  assert.equal(result.attemptCount, 2);
  assert.equal(client.calls.some((call) => call.text === "BEGIN" || call.text === "COMMIT" || call.text === "ROLLBACK"), false);
});

test("same failed attempt records once and duplicate is durable no-op", async () => {
  const client = new RetryClient("pending", 0);
  const first = await recordInboxRetryAfterFailureInTransaction(client, "501", attemptA, Object.assign(new Error("deadlock"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  const duplicate = await recordInboxRetryAfterFailureInTransaction(client, "501", attemptA, Object.assign(new Error("deadlock"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  assert.equal(first.outcome, "retry_scheduled");
  assert.equal(duplicate.outcome, "duplicate_attempt_record");
  assert.equal(client.attemptCount, 1);
  assert.equal(client.recordedAttempts.size, 1);
});

test("attempt A then B then stale duplicate A keeps attempt_count at two", async () => {
  const client = new RetryClient("pending", 0);
  assert.equal((await recordInboxRetryAfterFailureInTransaction(client, "501", attemptA, Object.assign(new Error("deadlock"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0)).attemptCount, 1);
  assert.equal((await recordInboxRetryAfterFailureInTransaction(client, "501", attemptB, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0)).attemptCount, 2);
  const staleA = await recordInboxRetryAfterFailureInTransaction(client, "501", attemptA, Object.assign(new Error("late duplicate"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  const duplicateB = await recordInboxRetryAfterFailureInTransaction(client, "501", attemptB, Object.assign(new Error("late duplicate"), { code: "ETIMEDOUT" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  assert.equal(staleA.outcome, "duplicate_attempt_record");
  assert.equal(duplicateB.outcome, "duplicate_attempt_record");
  assert.equal(client.attemptCount, 2);
});

test("max attempts finalize failed and non-retryable thrown errors fail immediately", async () => {
  const exhausted = new RetryClient("pending", 4);
  const exhaustedResult = await recordInboxRetryAfterFailureInTransaction(exhausted, "501", attemptE, Object.assign(new Error("deadlock"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  assert.equal(exhaustedResult.outcome, "retry_exhausted");
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.attemptCount, 5);
  assert.equal(exhausted.applyResult, "retry_exhausted");
  const duplicateFinal = await recordInboxRetryAfterFailureInTransaction(exhausted, "501", attemptE, Object.assign(new Error("late"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  assert.equal(duplicateFinal.outcome, "duplicate_attempt_record");
  assert.equal(exhausted.attemptCount, 5);

  const nonRetryable = new RetryClient("pending", 0);
  const nonRetryableResult = await recordInboxRetryAfterFailureInTransaction(nonRetryable, "501", attemptA, Object.assign(new Error("bad data"), { nonRetryable: true, code: "BAD_DATA" }), now);
  assert.equal(nonRetryableResult.outcome, "non_retryable_failed");
  assert.equal(nonRetryable.status, "failed");
  assert.equal(nonRetryable.applyResult, "non_retryable_failure");
  const nonRetryableDuplicate = await recordInboxRetryAfterFailureInTransaction(nonRetryable, "501", attemptA, Object.assign(new Error("bad data"), { nonRetryable: true, code: "BAD_DATA" }), now);
  assert.equal(nonRetryableDuplicate.outcome, "duplicate_attempt_record");
});

test("retry recording is idempotent and does not overwrite terminal or non-pending rows", async () => {
  const terminal = new RetryClient("reconciliation_required", 1);
  assert.equal((await recordInboxRetryAfterFailureInTransaction(terminal, "501", attemptA, new Error("late"), now)).outcome, "already_finalized");
  assert.equal(terminal.calls.some((call) => /UPDATE public\.opensea_listings_events_v2/.test(call.text)), false);
  const processing = new RetryClient("processing", 1);
  assert.equal((await recordInboxRetryAfterFailureInTransaction(processing, "501", attemptA, new Error("late"), now)).outcome, "not_eligible");
  assert.equal(processing.calls.some((call) => /UPDATE public\.opensea_listings_events_v2/.test(call.text)), false);
});

test("attempt ids are validated and distinct unique attempts count until maxAttempts", async () => {
  const client = new RetryClient("pending", 0);
  await assert.rejects(() => recordInboxRetryAfterFailureInTransaction(client, "501", "", new Error("bad"), now), /attemptId/);
  await assert.rejects(() => recordInboxRetryAfterFailureInTransaction(client, "501", "not-a-uuid", new Error("bad"), now), /attemptId/);
  for (const [index, attemptId] of [attemptA, attemptB, attemptC, attemptD].entries()) {
    const result = await recordInboxRetryAfterFailureInTransaction(client, "501", attemptId, Object.assign(new Error("deadlock"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
    assert.equal(result.outcome, "retry_scheduled");
    assert.equal(client.attemptCount, index + 1);
  }
  const final = await recordInboxRetryAfterFailureInTransaction(client, "501", attemptE, Object.assign(new Error("deadlock"), { code: "40P01" }), now, DEFAULT_INBOX_RETRY_POLICY, () => 0);
  assert.equal(final.outcome, "retry_exhausted");
  assert.equal(client.attemptCount, 5);
});

test("due pending selection excludes future scheduled rows and uses no entity locks", async () => {
  const pool = new RetryPool();
  pool.dueIds = ["501"];
  const ids = await selectNextDuePendingInboxEvent(pool, now);
  assert.deepEqual(ids, ["501"]);
  const call = pool.queryCalls[0];
  assert.match(call.text, /processing_status = 'pending'/);
  assert.match(call.text, /next_retry_at IS NULL OR next_retry_at <= \$1/);
  assert.match(call.text, /COALESCE\(raw_payload->'payload'->'rest_backfill_source'->>'source', ''\) <> 'opensea_rest_events_backfill'/);
  assert.doesNotMatch(call.text, /pg_advisory|opensea_listings_v2|opensea_listings_nft_state_v2/);
});

test("generic due pending selector holds REST backfill rows while normal stream pending rows remain selectable", async () => {
  const pool = new RetryPool();
  pool.dueIds = ["stream-later"];
  const ids = await selectNextDuePendingInboxEvent(pool, now);
  assert.deepEqual(ids, ["stream-later"]);
  const call = pool.queryCalls[0];
  assert.match(call.text, /opensea_rest_events_backfill/);
  assert.match(call.text, /ORDER BY received_at ASC, event_id ASC/);
});

test("one-shot worker idles, processes one due row, and never invokes atomic writer", async () => {
  const idlePool = new RetryPool();
  assert.equal((await runDurableInboxWorkerOnce(idlePool, now)).outcome, "idle");

  const pool = new RetryPool();
  pool.dueIds = ["501", "502"];
  let applied = 0;
  const result = await runDurableInboxWorkerOnce(pool, now, {
    applyEvent: async (_pool, eventId) => {
      applied += 1;
      return { outcome: "applied", eventId, eventType: "item_listed", dedupeKey: "d", processingStatus: "applied", attemptCount: 1, applyResult: "inserted_active_listing" };
    }
  });
  assert.equal(result.outcome, "processed");
  assert.equal(result.eventId, "501");
  assert.equal(applied, 1);
});

test("one-shot worker records retry metadata only after Tx B infrastructure failure", async () => {
  const pool = new RetryPool();
  pool.dueIds = ["501"];
  let retryRecorded = false;
  const result = await runDurableInboxWorkerOnce(pool, now, {
    createAttemptId: () => attemptA,
    applyEvent: async () => { throw Object.assign(new Error("deadlock"), { code: "40P01" }); },
    recordRetry: async (_pool, eventId, attemptId, _error, _now, _policy, _random) => {
      retryRecorded = true;
      assert.equal(attemptId, attemptA);
      return { outcome: "retry_scheduled", eventId, processingStatus: "pending", attemptCount: 1, nextRetryAt: "2026-08-12T12:00:05.000Z", errorCode: "40P01" };
    }
  });
  assert.equal(result.outcome, "retry_scheduled");
  assert.equal(retryRecorded, true);
});

test("later worker attempts receive different generated attempt ids", async () => {
  const pool = new RetryPool();
  pool.dueIds = ["501"];
  const seen: string[] = [];
  for (const attemptId of [attemptA, attemptB]) {
    const result = await runDurableInboxWorkerOnce(pool, now, {
      createAttemptId: () => attemptId,
      applyEvent: async () => { throw Object.assign(new Error("deadlock"), { code: "40P01" }); },
      recordRetry: async (_pool, _eventId, recordedAttemptId) => {
        seen.push(recordedAttemptId);
        return { outcome: "retry_scheduled", eventId: "501", processingStatus: "pending", attemptCount: seen.length, nextRetryAt: "2026-08-12T12:00:05.000Z", errorCode: "40P01" };
      }
    });
    assert.equal(result.outcome, "retry_scheduled");
  }
  assert.deepEqual(seen, [attemptA, attemptB]);
});

test("stale processing recovery resets only lifecycle metadata and preserves attempt_count semantics", async () => {
  const client = new RetryClient("processing", 3);
  const result = await recoverStaleProcessingRows(new RetryPool(client), now, 60_000, 10);
  assert.equal(result.recovered, 2);
  assert.deepEqual(client.calls.map((call) => call.text.split(/\s+/)[0]), ["BEGIN", "WITH", "COMMIT"]);
  const update = client.calls.find((call) => /WITH selected AS/.test(call.text))!;
  assert.match(update.text, /processing_status = 'pending'/);
  assert.match(update.text, /processing_started_at = NULL/);
  assert.doesNotMatch(update.text, /attempt_count = attempt_count \+/);
  assert.doesNotMatch(update.text, /pg_advisory|opensea_listings_v2|opensea_listings_nft_state_v2/);
});

test("stale processing internal helper has no transaction ownership and respects bounded limit", async () => {
  const client = new RetryClient("processing", 3);
  await recoverStaleProcessingRowsInTransaction(client, now, 60_000, 5);
  assert.equal(client.calls.some((call) => call.text === "BEGIN" || call.text === "COMMIT" || call.text === "ROLLBACK"), false);
  assert.equal(client.calls[0].values[1], 5);
});

test("startup recovery is explicit, recovers stale processing, reports metrics, and starts no loop", async () => {
  const pool = new RetryPool(new RetryClient("processing", 3));
  const result = await prepareDurableInboxOnStartup(pool, now, { staleAfterMs: 60_000, limit: 10 });
  assert.equal(result.staleProcessingRecovered, 2);
  assert.equal(result.metrics.pendingDue, 1);
  assert.equal(result.metrics.failedTotal, 4);
});

test("metrics snapshot exposes durable inbox backpressure fields with read-only SQL", async () => {
  const pool = new RetryPool();
  const metrics = await getDurableInboxMetrics(pool, now, 60_000);
  assert.equal(metrics.pendingTotal, 3);
  assert.equal(metrics.pendingDue, 1);
  assert.equal(metrics.pendingScheduled, 2);
  assert.equal(metrics.processingTotal, 1);
  assert.equal(metrics.staleProcessing, 1);
  assert.equal(metrics.failedTotal, 4);
  assert.equal(metrics.reconciliationRequiredTotal, 25);
  assert.equal(metrics.oldestDueAgeMs, 300_000);
  assert.equal(metrics.maxAttemptCount, 5);
  assert.doesNotMatch(pool.queryCalls[0].text, /INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP/i);
});

test("Phase 4 source has no live wiring, timers, background loop, or atomic writer invocation from worker", () => {
  const worker = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "worker", "durableInboxWorker.ts"), "utf8");
  const retry = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "db", "inboxRetryRepository.ts"), "utf8");
  const liveWriter = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "writer", "liveEventWriter.ts"), "utf8");
  const canary = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "liveCanary.ts"), "utf8");
  const streamProbe = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "streamProbe.ts"), "utf8");
  const index = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "index.ts"), "utf8");
  assert.match(worker, /applyPendingInboxEvent/);
  assert.doesNotMatch(worker, /applyNormalizedEvent|LiveEventWriter|OpenSeaStreamClient|setInterval|setTimeout|while\s*\(/);
  assert.doesNotMatch(retry, /pg_advisory_xact_lock|opensea_listings_v2|opensea_listings_nft_state_v2|setInterval|setTimeout/);
  assert.doesNotMatch(`${liveWriter}\n${canary}\n${streamProbe}\n${index}`, /runDurableInboxWorkerOnce|prepareDurableInboxOnStartup|inboxRetryRepository/);
});

test("attempt ledger migration is additive and preserves existing journal rows", () => {
  const sql = fs.readFileSync(path.resolve(import.meta.dirname, "..", "sql", "003_add_inbox_attempt_ledger.sql"), "utf8");
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /CREATE TABLE public\.opensea_listings_events_v2_attempts/);
  assert.match(sql, /attempt_id uuid NOT NULL/);
  assert.match(sql, /PRIMARY KEY \(event_id, attempt_id\)/);
  assert.match(sql, /REFERENCES public\.opensea_listings_events_v2\(event_id\)/);
  assert.doesNotMatch(sql, /DROP|DELETE\s+FROM|TRUNCATE|ALTER TABLE public\.opensea_listings_events_v2\b|UPDATE public\.opensea_listings_events_v2/i);
});
