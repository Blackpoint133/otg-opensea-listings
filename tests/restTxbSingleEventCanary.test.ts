import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REST_TXB_SINGLE_EVENT_AMBIGUOUS_APPLY_RESULT,
  REST_TXB_SINGLE_EVENT_EXPECTED,
  REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT,
  REST_TXB_SINGLE_EVENT_ID,
  REST_TXB_SINGLE_EVENT_RELEASE_SCOPE,
  REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS,
  canonicalizePgTimestamptzForClassifier,
  combinedReleaseEvidenceSha256,
  combinedRestTxbProvenanceSha256,
  computeRestTxbSingleEventProvenance,
  loadRestTxbSingleEventConfig,
  runRestTxbSingleEventCanary,
  verifyRestTxbReleaseEvidence,
  verifyRestTxbReleaseEvidenceFiles,
  type RestTxbReleaseEvidenceFileExpectation,
  type RestTxbReleaseEvidence,
  type RestTxbSingleEventConfig
} from "../src/canary/restTxbSingleEventCanary.js";
import { runRestTxbSingleEventCanaryCli } from "../src/canary/runRestTxbSingleEventCanary.js";
import type { DbPool, PendingInboxApplyResult, QueryResult, TransactionClient } from "../src/db/types.js";

function tempDir(): string {
  return path.join(os.tmpdir(), `otg-rest-txb-single-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

const gates = REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS.flatMap((flag) => [flag]);
const baseArgs = [...gates, "--event-id", REST_TXB_SINGLE_EVENT_ID];

function config(outputDir = tempDir(), args = baseArgs): RestTxbSingleEventConfig {
  return loadRestTxbSingleEventConfig([...args, "--output-dir", outputDir]);
}

function rawEvent(overrides: Record<string, unknown> = {}): any {
  return {
    event_type: "item_transferred",
    version: null,
    payload: {
      event_timestamp: REST_TXB_SINGLE_EVENT_EXPECTED.eventTimestamp,
      transaction: { hash: REST_TXB_SINGLE_EVENT_EXPECTED.transactionHash, timestamp: REST_TXB_SINGLE_EVENT_EXPECTED.eventTimestamp },
      item: { nft_id: REST_TXB_SINGLE_EVENT_EXPECTED.nftId, metadata: {} },
      from_account: { address: REST_TXB_SINGLE_EVENT_EXPECTED.canonicalFrom },
      to_account: { address: REST_TXB_SINGLE_EVENT_EXPECTED.canonicalTo },
      rest_backfill_source: { source: "opensea_rest_events_backfill", transfer_type: "mint" },
      ...overrides
    }
  };
}

function fakeReleaseEvidence(candidateCoverageComplete: boolean, event82Classification: any): RestTxbReleaseEvidence {
  return {
    window: REST_TXB_SINGLE_EVENT_RELEASE_SCOPE,
    queryEventTypes: ["transfer"],
    files: [
      { path: "txa_canary_summary.json", sha256: "a".repeat(64) },
      { path: "txa_canary_rows.jsonl", sha256: "b".repeat(64) }
    ],
    combinedSha256: combinedReleaseEvidenceSha256([
      { path: "txa_canary_rows.jsonl", sha256: "b".repeat(64) },
      { path: "txa_canary_summary.json", sha256: "a".repeat(64) }
    ]),
    transportComplete: true,
    semanticCoverageComplete: true,
    txAAdmissionComplete: true,
    candidateCoverageComplete,
    releaseEligible: candidateCoverageComplete && event82Classification === "SAFE",
    event82Classification
  };
}

function provenance() {
  return { packageVersion: "0.1.0", nodeVersion: "v-test", sourceFiles: [], sourceCombinedSha256: "a".repeat(64), runtimeFiles: [], runtimeCombinedSha256: "b".repeat(64) };
}

function syntheticReleaseEvidence(overrides: Record<string, unknown> = {}): {
  dir: string;
  requiredFiles: RestTxbReleaseEvidenceFileExpectation[];
} {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const sourceProvenance = {
    packageVersion: "0.0.0-test",
    nodeVersion: "v-test",
    sourceFiles: [{ path: "synthetic/source.ts", sha256: "1".repeat(64) }],
    sourceCombinedSha256: "2".repeat(64),
    runtimeFiles: [{ path: "synthetic/runtime.js", sha256: "3".repeat(64) }],
    runtimeCombinedSha256: "4".repeat(64)
  };
  const insertedEventIds = Array.from({ length: 16 }, (_, index) => `synthetic-inserted-${index + 1}`);
  const duplicateEventIds = Array.from({ length: 26 }, (_, index) => `synthetic-duplicate-${index + 1}`);
  const summary = {
    result: "REST_TXA_ONLY_CANARY_COMPLETE",
    window: REST_TXB_SINGLE_EVENT_RELEASE_SCOPE,
    queryEventTypes: ["transfer"],
    transportComplete: true,
    semanticCoverageComplete: true,
    txAAdmissionComplete: true,
    eventsObserved: 42,
    eventsAdapted: 42,
    eventsMalformed: 0,
    eventsUnsupported: 0,
    txAInserted: 16,
    txADuplicates: 26,
    txAErrors: 0,
    insertedEventIds,
    duplicateEventIds,
    sourceProvenance,
    txBInvoked: false,
    nftStateTouched: false,
    activeOrdersTouched: false,
    streamConnected: false,
    evidenceWriteComplete: true,
    ...overrides
  };
  const rows = [
    ...insertedEventIds.map((eventId) => ({ eventId, outcome: "inserted_pending", dedupeKey: `synthetic:${eventId}`, eventType: "item_transferred", processingStatus: "pending" })),
    ...duplicateEventIds.map((eventId) => ({ eventId, outcome: "duplicate_existing", dedupeKey: `synthetic:${eventId}`, eventType: "item_transferred", processingStatus: "pending" }))
  ];
  const files: Record<string, string> = {
    "txa_canary_summary.json": JSON.stringify(summary),
    "txa_canary_rows.jsonl": rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "txa_canary_preflight.json": JSON.stringify({ snapshot: { database: "synthetic_test" }, sourceProvenance }),
    "txa_canary_postflight.json": JSON.stringify({ database: "synthetic_test", stateUnchanged: true })
  };
  const requiredFiles = Object.entries(files).map(([name, contents]) => {
    fs.writeFileSync(path.join(dir, name), contents, "utf8");
    return { name, sha256: createHash("sha256").update(contents, "utf8").digest("hex") };
  });
  return { dir, requiredFiles };
}

function pendingEvent(overrides: Record<string, unknown> = {}): any {
  return {
    event_id: "82",
    event_type: "item_transferred",
    event_timestamp: REST_TXB_SINGLE_EVENT_EXPECTED.eventTimestamp,
    event_version: null,
    chain: REST_TXB_SINGLE_EVENT_EXPECTED.chain,
    contract_address: REST_TXB_SINGLE_EVENT_EXPECTED.contractAddress,
    token_id: REST_TXB_SINGLE_EVENT_EXPECTED.tokenId,
    transaction_hash: REST_TXB_SINGLE_EVENT_EXPECTED.transactionHash,
    received_at: "2026-08-15T00:00:00.000Z",
    dedupe_key: REST_TXB_SINGLE_EVENT_EXPECTED.dedupeKey,
    raw_payload: rawEvent(),
    processing_status: "pending",
    attempt_count: 0,
    next_retry_at: null,
    apply_result: null,
    applied_at: null,
    processing_started_at: null,
    last_error_code: null,
    last_error_message: null,
    ...overrides
  };
}

class FakePool implements DbPool {
  public queries: { text: string; values?: readonly unknown[] }[] = [];
  public database = "server_otg";
  public schemaOk = true;
  public event: any | null = pendingEvent();
  public nft: any | null = null;
  public activeOrders: any[] = [];
  public attempts: any[] = [];
  public extraCandidates: any[] = [];
  public counts = { journal: 51, pending: 1, processing: 0, failed: 0, reconciliationRequired: 50, unfinalized: 1, attemptLedger: 0, nftState: 50, orders: 0 };
  async connect(): Promise<TransactionClient> { throw new Error("single-event canary tests use injected applyEvent"); }
  async end(): Promise<void> {}
  async query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (/current_database/.test(text)) return { rows: [{ database: this.database }] as Row[], rowCount: 1 };
    if (/to_regclass/.test(text)) return { rows: [{ ok: this.schemaOk }] as Row[], rowCount: 1 };
    if (/SELECT[\s\S]*COUNT\(\*\) FROM public\.opensea_listings_events_v2\)[\s\S]*FROM public\.opensea_listings_events_v2\s*$/.test(text)) {
      return { rows: [{
        journal: this.counts.journal,
        pending: this.counts.pending,
        processing: this.counts.processing,
        failed: this.counts.failed,
        reconciliation_required: this.counts.reconciliationRequired,
        unfinalized: this.counts.unfinalized,
        attempt_ledger: this.counts.attemptLedger,
        nft_state: this.counts.nftState,
        orders: this.counts.orders
      }] as Row[], rowCount: 1 };
    }
    if (/WHERE event_id::text = \$1/.test(text) && /raw_payload/.test(text)) {
      return { rows: (this.event ? [this.event] : []) as Row[], rowCount: this.event ? 1 : 0 };
    }
    if (/FROM public\.opensea_listings_events_v2_attempts/.test(text)) return { rows: this.attempts as Row[], rowCount: this.attempts.length };
    if (/FROM public\.opensea_listings_nft_state_v2/.test(text)) return { rows: (this.nft ? [this.nft] : []) as Row[], rowCount: this.nft ? 1 : 0 };
    if (/FROM public\.opensea_listings_v2/.test(text)) return { rows: this.activeOrders as Row[], rowCount: this.activeOrders.length };
    if (/WHERE dedupe_key = \$1/.test(text)) {
      const rows = this.event?.dedupe_key === values?.[0] ? [{ event_id: this.event.event_id, processing_status: this.event.processing_status, dedupe_key: this.event.dedupe_key }] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }
    if (/WHERE event_type = 'item_transferred'[\s\S]*event_timestamp >= \$1::timestamptz/.test(text)) {
      const candidates = [this.event, ...this.extraCandidates].filter(Boolean).map((row) => ({
        event_id: row.event_id,
        event_type: row.event_type,
        event_timestamp: row.event_timestamp,
        event_version: row.event_version,
        chain: row.chain,
        contract_address: row.contract_address,
        token_id: row.token_id,
        transaction_hash: row.transaction_hash,
        dedupe_key: row.dedupe_key,
        processing_status: row.processing_status,
        raw_payload: row.raw_payload
      }));
      return { rows: candidates as Row[], rowCount: candidates.length };
    }
    throw new Error(`unexpected query: ${text}`);
  }
}

function applySuccess(pool: FakePool): PendingInboxApplyResult {
  pool.event = {
    ...pool.event,
    processing_status: "reconciliation_required",
    attempt_count: 1,
    apply_result: REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT,
    applied_at: "2026-08-15T00:00:00.000Z",
    processing_started_at: null,
    next_retry_at: null,
    last_error_code: null,
    last_error_message: null
  };
  pool.nft = {
    chain: REST_TXB_SINGLE_EVENT_EXPECTED.chain,
    contract_address: REST_TXB_SINGLE_EVENT_EXPECTED.contractAddress,
    token_id: REST_TXB_SINGLE_EVENT_EXPECTED.tokenId,
    nft_id: REST_TXB_SINGLE_EVENT_EXPECTED.nftId,
    collection_slug: "off-the-grid",
    current_owner_address: REST_TXB_SINGLE_EVENT_EXPECTED.canonicalTo,
    last_transfer_from_address: REST_TXB_SINGLE_EVENT_EXPECTED.canonicalFrom,
    last_transfer_to_address: REST_TXB_SINGLE_EVENT_EXPECTED.canonicalTo,
    last_transfer_transaction_hash: REST_TXB_SINGLE_EVENT_EXPECTED.transactionHash,
    last_transfer_at: REST_TXB_SINGLE_EVENT_EXPECTED.eventTimestamp,
    last_nft_event_timestamp: REST_TXB_SINGLE_EVENT_EXPECTED.eventTimestamp,
    last_nft_event_version: null
  };
  pool.counts.pending -= 1;
  pool.counts.unfinalized -= 1;
  pool.counts.reconciliationRequired += 1;
  pool.counts.nftState += 1;
  return {
    outcome: "reconciliation_required",
    eventId: "82",
    eventType: "item_transferred",
    dedupeKey: REST_TXB_SINGLE_EVENT_EXPECTED.dedupeKey,
    processingStatus: "reconciliation_required",
    attemptCount: 1,
    applyResult: REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT
  };
}

test("REST Tx B single-event config requires all gates hard-pins event 82 and protects output dir", () => {
  for (const missing of REST_TXB_SINGLE_EVENT_REQUIRED_CONFIRMATIONS) {
    assert.throws(() => loadRestTxbSingleEventConfig([...baseArgs.filter((arg) => arg !== missing), "--output-dir", tempDir()]), new RegExp(missing));
  }
  assert.throws(() => loadRestTxbSingleEventConfig([...gates, "--output-dir", tempDir()]), /event-id/);
  assert.throws(() => loadRestTxbSingleEventConfig([...gates, "--event-id", "83", "--output-dir", tempDir()]), /82/);
  assert.throws(() => loadRestTxbSingleEventConfig([...baseArgs, "--range", "1", "--output-dir", tempDir()]), /Unknown/);
  const nonEmpty = tempDir();
  fs.mkdirSync(nonEmpty, { recursive: true });
  fs.writeFileSync(path.join(nonEmpty, "existing.txt"), "x");
  assert.throws(() => loadRestTxbSingleEventConfig([...baseArgs, "--output-dir", nonEmpty]), /empty/);
});

test("REST Tx B single-event canary aborts before DML for database schema and event preflight failures", async () => {
  const cases: [string, (pool: FakePool) => void][] = [
    ["wrong db", (pool) => { pool.database = "other"; }],
    ["missing schema", (pool) => { pool.schemaOk = false; }],
    ["missing event", (pool) => { pool.event = null; }],
    ["wrong source", (pool) => { pool.event.raw_payload = rawEvent({ rest_backfill_source: { source: "other", transfer_type: "mint" } }); }],
    ["wrong stored mint provenance", (pool) => { pool.event.raw_payload = rawEvent({ rest_backfill_source: { source: "opensea_rest_events_backfill", transfer_type: "transfer" } }); }],
    ["non pending", (pool) => { pool.event.processing_status = "processing"; }],
    ["attempt count", (pool) => { pool.event.attempt_count = 1; }],
    ["retry", (pool) => { pool.event.next_retry_at = "2026-08-15T00:00:00.000Z"; }],
    ["applied", (pool) => { pool.event.applied_at = "2026-08-15T00:00:00.000Z"; }],
    ["chain", (pool) => { pool.event.chain = "ethereum"; }],
    ["contract", (pool) => { pool.event.contract_address = "0x1111111111111111111111111111111111111111"; }],
    ["token", (pool) => { pool.event.token_id = "1"; }],
    ["tx", (pool) => { pool.event.transaction_hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; }],
    ["dedupe", (pool) => { pool.event.dedupe_key = "transfer:v1:other"; }],
    ["timestamp", (pool) => { pool.event.event_timestamp = "2026-08-13T10:55:44.000Z"; }],
    ["canonical", (pool) => { pool.event.raw_payload = rawEvent({ from_account: { address: "0x1111111111111111111111111111111111111111" } }); }],
    ["nft exists", (pool) => { pool.nft = { chain: "gunzilla", contract_address: REST_TXB_SINGLE_EVENT_EXPECTED.contractAddress, token_id: "48804197", nft_id: REST_TXB_SINGLE_EVENT_EXPECTED.nftId, collection_slug: "off-the-grid" }; }],
    ["active order", (pool) => { pool.activeOrders = [{ order_hash: "0xorder", status: "active", is_active: true }]; }]
  ];
  for (const [, mutate] of cases) {
    const pool = new FakePool();
    mutate(pool);
    let calls = 0;
    const summary = await runRestTxbSingleEventCanary(config(), {
      pool,
      computeProvenance: provenance,
      verifyReleaseEvidence: fakeReleaseEvidence,
      applyEvent: async () => { calls += 1; throw new Error("must not apply"); },
      writeEvidence: async () => {}
    });
    assert.equal(calls, 0);
    assert.notEqual(summary.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
  }
});

test("REST Tx B single-event canary requires unique dedupe no same-second conflict and SAFE non-boundary classification", async () => {
  const conflict = pendingEvent({
    event_id: "99",
    transaction_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dedupe_key: "transfer:v1:conflict",
    raw_payload: rawEvent({ transaction: { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", timestamp: REST_TXB_SINGLE_EVENT_EXPECTED.eventTimestamp } })
  });
  const pool = new FakePool();
  pool.extraCandidates = [conflict];
  let calls = 0;
  const summary = await runRestTxbSingleEventCanary(config(), {
    pool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async () => { calls += 1; throw new Error("must not apply"); },
    writeEvidence: async () => {}
  });
  assert.equal(calls, 0);
  assert.equal(summary.sameSecondConflictFree, false);
  assert.equal(summary.classifierSafe, false);
  assert.equal(summary.result, "REST_TXB_SINGLE_EVENT_ABORTED_PREFLIGHT");

  const boundaryPool = new FakePool();
  boundaryPool.event.event_timestamp = "2026-08-13T10:55:44.000Z";
  const boundary = await runRestTxbSingleEventCanary(config(), {
    pool: boundaryPool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async () => { throw new Error("must not apply"); },
    writeEvidence: async () => {}
  });
  assert.equal(boundary.boundaryReleaseProven, false);
});

test("REST Tx B preflight canonicalizes PostgreSQL timestamptz text before classifier", async () => {
  assert.equal(canonicalizePgTimestamptzForClassifier("2026-08-13 03:55:43-07"), "2026-08-13T10:55:43.000Z");
  assert.equal(canonicalizePgTimestamptzForClassifier("2026-08-13 03:55:43.450-07"), "2026-08-13T10:55:43.450Z");
  assert.equal(canonicalizePgTimestamptzForClassifier("not a timestamp"), null);

  const pool = new FakePool();
  pool.event.event_timestamp = "2026-08-13 03:55:43-07";
  let calls = 0;
  const summary = await runRestTxbSingleEventCanary(config(), {
    pool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async (_pool, eventId) => {
      calls += 1;
      assert.equal(eventId, "82");
      return applySuccess(pool);
    },
    writeEvidence: async () => {}
  });
  assert.equal(calls, 1);
  assert.equal(summary.classifierSafe, true);
  assert.equal(summary.releaseEvidence?.candidateCoverageComplete, true);
  assert.equal(summary.releaseEvidence?.event82Classification, "SAFE");
});

test("REST Tx B preflight accepts actual event82 stored mint provenance and rejects unsafe variants", async () => {
  const pool = new FakePool();
  pool.event.raw_payload = rawEvent({ transfer_type: null });
  let calls = 0;
  const ok = await runRestTxbSingleEventCanary(config(), {
    pool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async () => {
      calls += 1;
      return applySuccess(pool);
    },
    writeEvidence: async () => {}
  });
  assert.equal(calls, 1);
  assert.equal(ok.identityPreflightValid, true);

  for (const raw of [
    rawEvent({ rest_backfill_source: { source: "opensea_rest_events_backfill", transfer_type: "transfer" } }),
    rawEvent({ rest_backfill_source: { source: "other", transfer_type: "mint" } }),
    rawEvent({ from_account: { address: "0x1111111111111111111111111111111111111111" } }),
    rawEvent({ to_account: { address: "0x1111111111111111111111111111111111111111" } })
  ]) {
    const bad = new FakePool();
    bad.event.raw_payload = raw;
    let badCalls = 0;
    const result = await runRestTxbSingleEventCanary(config(), {
      pool: bad,
      computeProvenance: provenance,
      verifyReleaseEvidence: fakeReleaseEvidence,
      applyEvent: async () => { badCalls += 1; throw new Error("must not apply"); },
      writeEvidence: async () => {}
    });
    assert.equal(badCalls, 0);
    assert.notEqual(result.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
  }
});

test("REST Tx B release evidence verifier accepts exact full-window artifacts and is deterministic", (t) => {
  const fixture = syntheticReleaseEvidence();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const release = verifyRestTxbReleaseEvidenceFiles(true, "SAFE", fixture.dir, fixture.requiredFiles);
  const repeated = verifyRestTxbReleaseEvidenceFiles(true, "SAFE", fixture.dir, [...fixture.requiredFiles].reverse());
  assert.throws(() => verifyRestTxbReleaseEvidence(true, "SAFE", fixture.dir), /hash mismatch/);
  assert.equal(release.transportComplete, true);
  assert.equal(release.semanticCoverageComplete, true);
  assert.equal(release.txAAdmissionComplete, true);
  assert.equal(release.releaseEligible, true);
  assert.equal(release.window.after, 1786618485);
  assert.equal(release.window.before, 1786618545);
  assert.equal(release.queryEventTypes[0], "transfer");
  assert.equal(release.files.length, 4);
  for (const file of release.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(release.combinedSha256, combinedReleaseEvidenceSha256([...release.files].reverse()));
  assert.equal(repeated.combinedSha256, release.combinedSha256);
});

test("REST Tx B release evidence tamper missing files and false completeness abort before Tx B", async (t) => {
  const missing = syntheticReleaseEvidence();
  t.after(() => fs.rmSync(missing.dir, { recursive: true, force: true }));
  fs.unlinkSync(path.join(missing.dir, "txa_canary_rows.jsonl"));
  assert.throws(() => verifyRestTxbReleaseEvidenceFiles(true, "SAFE", missing.dir, missing.requiredFiles), /ENOENT|missing/i);

  const tampered = syntheticReleaseEvidence();
  t.after(() => fs.rmSync(tampered.dir, { recursive: true, force: true }));
  fs.appendFileSync(path.join(tampered.dir, "txa_canary_summary.json"), "\n");
  assert.throws(() => verifyRestTxbReleaseEvidenceFiles(true, "SAFE", tampered.dir, tampered.requiredFiles), /hash mismatch/);

  const falseComplete = syntheticReleaseEvidence({ transportComplete: false });
  t.after(() => fs.rmSync(falseComplete.dir, { recursive: true, force: true }));
  assert.throws(
    () => verifyRestTxbReleaseEvidenceFiles(true, "SAFE", falseComplete.dir, falseComplete.requiredFiles),
    /transport incomplete/
  );

  const actualVerifier = () => verifyRestTxbReleaseEvidenceFiles(true, "SAFE", falseComplete.dir, falseComplete.requiredFiles);
  const actualPool = new FakePool();
  let actualCalls = 0;
  const actualSummary = await runRestTxbSingleEventCanary(config(), {
    pool: actualPool,
    computeProvenance: provenance,
    verifyReleaseEvidence: actualVerifier,
    applyEvent: async () => { actualCalls += 1; throw new Error("must not apply"); },
    writeEvidence: async () => {}
  });
  assert.equal(actualCalls, 0);
  assert.equal(actualPool.event.processing_status, "pending");
  assert.notEqual(actualSummary.result, "REST_TXB_SINGLE_EVENT_COMPLETE");

  for (const verifier of [
    () => { throw new Error("release evidence window mismatch"); },
    () => { throw new Error("release evidence query mismatch"); },
    () => { throw new Error("release evidence result mismatch"); },
    () => { throw new Error("release transport incomplete"); },
    () => { throw new Error("release semantic incomplete"); },
    () => { throw new Error("release Tx A admission incomplete"); },
    () => { throw new Error("release event count mismatch"); },
    () => { throw new Error("release Tx A count mismatch"); },
    () => { throw new Error("release action flag mismatch"); },
    () => { throw new Error("release evidence provenance mismatch"); }
  ]) {
    const pool = new FakePool();
    let calls = 0;
    const summary = await runRestTxbSingleEventCanary(config(), {
      pool,
      computeProvenance: provenance,
      verifyReleaseEvidence: verifier as any,
      applyEvent: async () => { calls += 1; throw new Error("must not apply"); },
      writeEvidence: async () => {}
    });
    assert.equal(calls, 0);
    assert.notEqual(summary.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
  }
});

test("REST Tx B release evidence refuses candidate incomplete and non-SAFE classifications", async () => {
  for (const classification of ["UNCERTAIN", "AMBIGUOUS", "DEFERRED_BOUNDARY", "NOT_ADMITTED", "DUPLICATE_EXISTING"]) {
    const pool = new FakePool();
    let calls = 0;
    const summary = await runRestTxbSingleEventCanary(config(), {
      pool,
      computeProvenance: provenance,
      verifyReleaseEvidence: (candidateCoverageComplete) => fakeReleaseEvidence(candidateCoverageComplete, classification),
      applyEvent: async () => { calls += 1; throw new Error("must not apply"); },
      writeEvidence: async () => {}
    });
    assert.equal(calls, 0);
    assert.notEqual(summary.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
  }

  const incomplete = new FakePool();
  incomplete.event.event_timestamp = "2026-08-13 03:55:43-07-bad";
  const summary = await runRestTxbSingleEventCanary(config(), {
    pool: incomplete,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async () => { throw new Error("must not apply"); },
    writeEvidence: async () => {}
  });
  assert.equal(summary.releaseEvidence?.candidateCoverageComplete, false);
  assert.notEqual(summary.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
});

test("REST Tx B single-event canary invokes exact event-id Tx B once and validates SAFE postflight evidence", async () => {
  const outputDir = tempDir();
  const pool = new FakePool();
  let calls = 0;
  const summary = await runRestTxbSingleEventCanary(config(outputDir), {
    pool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async (_pool, eventId) => {
      calls += 1;
      assert.equal(eventId, "82");
      return applySuccess(pool);
    }
  });
  assert.equal(calls, 1);
  assert.equal(summary.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
  assert.equal(summary.txBInvoked, true);
  assert.equal(summary.txBCallCount, 1);
  assert.equal(summary.txBEventId, "82");
  assert.equal(summary.applicationResult?.applyResult, REST_TXB_SINGLE_EVENT_EXPECTED_APPLY_RESULT);
  const persisted = JSON.parse(fs.readFileSync(path.join(outputDir, "txb_canary_summary.json"), "utf8"));
  assert.deepEqual(persisted, JSON.parse(JSON.stringify(summary)));
  for (const name of ["txb_canary_summary.json", "txb_canary_preflight.json", "txb_canary_postflight.json", "txb_canary_event82.json"]) {
    assert.ok(fs.existsSync(path.join(outputDir, name)));
  }
});

test("REST Tx B single-event canary classifies late defensive ambiguity as safe no-state non-complete outcome", async () => {
  const pool = new FakePool();
  const summary = await runRestTxbSingleEventCanary(config(), {
    pool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async () => {
      pool.event = { ...pool.event, processing_status: "reconciliation_required", attempt_count: 1, apply_result: REST_TXB_SINGLE_EVENT_AMBIGUOUS_APPLY_RESULT, applied_at: "2026-08-15T00:00:00.000Z" };
      return { outcome: "reconciliation_required", eventId: "82", eventType: "item_transferred", dedupeKey: REST_TXB_SINGLE_EVENT_EXPECTED.dedupeKey, processingStatus: "reconciliation_required", attemptCount: 1, applyResult: REST_TXB_SINGLE_EVENT_AMBIGUOUS_APPLY_RESULT };
    },
    writeEvidence: async () => {}
  });
  assert.equal(summary.result, "REST_TXB_SINGLE_EVENT_SAFE_NO_STATE_AMBIGUOUS");
  assert.equal(pool.nft, null);
});

test("REST Tx B single-event canary transaction or evidence failure cannot complete and does not retry", async () => {
  const pool = new FakePool();
  const failed = await runRestTxbSingleEventCanary(config(), {
    pool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async () => { throw new Error("rollback password=secret"); },
    writeEvidence: async () => {}
  });
  assert.equal(failed.txBCallCount, 1);
  assert.notEqual(failed.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
  assert.equal(pool.event.processing_status, "pending");
  assert.equal(pool.event.attempt_count, 0);
  assert.match(failed.errors.join(" "), /password=<redacted>/);

  const evidencePool = new FakePool();
  const evidence = await runRestTxbSingleEventCanary(config(), {
    pool: evidencePool,
    computeProvenance: provenance,
    verifyReleaseEvidence: fakeReleaseEvidence,
    applyEvent: async () => applySuccess(evidencePool),
    writeEvidence: async () => { throw new Error("disk full"); }
  });
  assert.equal(evidence.evidenceWriteComplete, false);
  assert.notEqual(evidence.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
});

test("REST Tx B single-event provenance is deterministic and fails before Tx B", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otg-txb-provenance-"));
  for (const file of [
    "src/canary/restTxbSingleEventCanary.ts",
    "src/canary/runRestTxbSingleEventCanary.ts",
    "src/db/pendingInboxApplicationService.ts",
    "src/db/eventApplicationService.ts",
    "src/backfill/restTransferWindowBarrier.ts",
    "src/db/inboxRetryRepository.ts",
    "src/db/nftStateRepository.ts",
    "src/db/listingRepository.ts",
    "src/state/nftReducer.ts",
    "src/state/orderReducer.ts",
    "src/state/normalizers.ts",
    "src/state/eventIdentity.ts",
    "dist/canary/restTxbSingleEventCanary.js",
    "dist/canary/runRestTxbSingleEventCanary.js"
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `content:${file}`);
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const first = computeRestTxbSingleEventProvenance(root, "v-test");
  const second = computeRestTxbSingleEventProvenance(root, "v-test");
  assert.equal(first.packageVersion, "1.2.3");
  assert.equal(first.nodeVersion, "v-test");
  assert.equal(first.sourceFiles.length, 13);
  assert.equal(first.runtimeFiles.length, 2);
  assert.equal(first.sourceCombinedSha256, second.sourceCombinedSha256);
  assert.equal(first.sourceCombinedSha256, combinedRestTxbProvenanceSha256([...first.sourceFiles].reverse()));
  for (const file of [...first.sourceFiles, ...first.runtimeFiles]) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(file.path, /^[A-Za-z]:\\/);
  }
  fs.writeFileSync(path.join(root, "src/canary/restTxbSingleEventCanary.ts"), "changed");
  assert.notEqual(first.sourceCombinedSha256, computeRestTxbSingleEventProvenance(root, "v-test").sourceCombinedSha256);
  assert.throws(() => computeRestTxbSingleEventProvenance(path.join(root, "missing"), "v-test"), /ENOENT/);

  let calls = 0;
  const summary = await runRestTxbSingleEventCanary(config(), {
    pool: new FakePool(),
    computeProvenance: () => { throw new Error("missing provenance"); },
    applyEvent: async () => { calls += 1; throw new Error("must not apply"); },
    writeEvidence: async () => {}
  });
  assert.equal(calls, 0);
  assert.notEqual(summary.result, "REST_TXB_SINGLE_EVENT_COMPLETE");
});

test("REST Tx B single-event CLI exit codes and source isolation", async () => {
  const complete = await runRestTxbSingleEventCanaryCli({
    argv: [...baseArgs, "--output-dir", tempDir()],
    stdout: { write: () => true },
    stderr: { write: () => true },
    runCanary: async (cfg) => ({
      result: "REST_TXB_SINGLE_EVENT_COMPLETE",
      eventId: cfg.eventId,
      gatesValid: true,
      databaseTargetValid: true,
      schemaPreflightValid: true,
      provenanceComplete: true,
      identityPreflightValid: true,
      lifecyclePreflightValid: true,
      dedupeUnique: true,
      sameSecondConflictFree: true,
      classifierSafe: true,
      boundaryReleaseProven: true,
      nftStatePreflightValid: true,
      orderPreflightValid: true,
      txBInvoked: true,
      txBCallCount: 1,
      txBEventId: "82",
      applicationResult: null,
      postflightValid: true,
      eventFinalStateValid: true,
      nftStateDeltaValid: true,
      orderDeltaValid: true,
      attemptDeltaValid: true,
      evidenceWriteComplete: true,
      sourceProvenance: null,
      errors: []
    })
  });
  assert.equal(complete.exitCode, 0);
  const partial = await runRestTxbSingleEventCanaryCli({
    argv: [...baseArgs, "--output-dir", tempDir()],
    stdout: { write: () => true },
    stderr: { write: () => true },
    runCanary: async (cfg) => ({ ...complete.summary!, eventId: cfg.eventId, result: "REST_TXB_SINGLE_EVENT_PARTIAL" })
  });
  assert.equal(partial.exitCode, 1);

  const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "restTxbSingleEventCanary.ts"), "utf8")
    + fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "runRestTxbSingleEventCanary.ts"), "utf8");
  assert.doesNotMatch(source, /RestEventsClient|fetchCollectionEventsPage|persistRawEventToInbox|selectNextDuePendingInboxEvent|durableInboxWorker|OpenSeaStreamClient|stream-js|runRestTransferWindowAdmissionBarrier/);
  assert.match(source, /applyPendingInboxEvent/);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts["precanary:rest-txb-single-event"], "npm run build");
  assert.equal(pkg.scripts["canary:rest-txb-single-event"], "node dist/canary/runRestTxbSingleEventCanary.js");
  assert.doesNotMatch(`${pkg.scripts.start} ${pkg.scripts.probe} ${pkg.scripts.canary} ${pkg.scripts["canary:durable"]} ${pkg.scripts["canary:rest-txa-only"]}`, /runRestTxbSingleEventCanary/);
});
