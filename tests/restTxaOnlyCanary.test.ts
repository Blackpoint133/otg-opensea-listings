import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS,
  REST_TXA_ONLY_REQUIRED_CONFIRMATIONS,
  combinedProvenanceSha256,
  computeRestTxaOnlyProvenance,
  collectRestTxaOnlySnapshot,
  loadRestTxaOnlyCanaryConfig,
  runRestTxaOnlyCanary,
  validateInsertedRestTxaRows,
  type RestTxaOnlyCanaryConfig
} from "../src/canary/restTxaOnlyCanary.js";
import { runRestTxaOnlyCanaryCli } from "../src/canary/runRestTxaOnlyCanary.js";
import type { DbPool, DurableInboxPersistResult, QueryResult, TransactionClient } from "../src/db/types.js";
import type { RestEventsPage } from "../src/backfill/types.js";
import { extractInboxJournalEnvelope } from "../src/db/durableInboxRepository.js";

const apiEnv = { OPENSEA_API_KEY: "test-secret-key" };
const gates = REST_TXA_ONLY_REQUIRED_CONFIRMATIONS.flatMap((flag) => [flag]);
const baseArgs = [...gates, "--after", "1786618485", "--before", "1786618545"];

function tempDir(): string {
  return path.join(os.tmpdir(), `otg-rest-txa-only-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function config(outputDir = tempDir(), extraArgs: string[] = []): RestTxaOnlyCanaryConfig {
  return loadRestTxaOnlyCanaryConfig([...baseArgs, "--output-dir", outputDir, ...extraArgs], apiEnv);
}

function restTransfer(overrides: Record<string, unknown> = {}): any {
  return {
    event_type: "transfer",
    event_timestamp: 1786618497,
    transaction: "0x4f6e5b59c9aa5027bee31c24c1e4e65725120b9245d19b43b592d561880212d7",
    chain: "gunzilla",
    transfer_type: "transfer",
    from_address: "0x1111111111111111111111111111111111111111",
    to_address: "0x2222222222222222222222222222222222222222",
    nft: { identifier: "20936559", contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271", token_standard: "erc721" },
    quantity: 1,
    ...overrides
  };
}

function page(events: unknown[], next: string | null = null): RestEventsPage {
  return {
    events,
    next,
    httpStatus: 200,
    literalResponseText: JSON.stringify({ asset_events: events, next }),
    literalResponseSha256: "sha",
    literalResponseByteLength: 1,
    rateLimit: { limit: null, remaining: null, reset: null, retryAfter: null },
    retries: 0,
    rateLimitedResponses: 0
  };
}

class FakePool implements DbPool {
  public queries: { text: string; values?: readonly unknown[] }[] = [];
  public rowsById = new Map<string, any>();
  public counts = { orders: 0, nftState: 50, journal: 50, pending: 0, processing: 0, failed: 0, reconciliationRequired: 50, restPending: 0, attemptLedger: 0 };
  constructor(public database = "server_otg", public schemaExists = true) {}
  async connect(): Promise<TransactionClient> { throw new Error("Tx A-only tests should not acquire raw clients directly"); }
  async end(): Promise<void> {}
  async query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    this.queries.push({ text, values });
    if (/current_database/.test(text)) return { rows: [{ database: this.database }] as Row[], rowCount: 1 };
    if (/to_regclass\('public\.opensea_listings_events_v2'\)/.test(text)) return { rows: [{ table_exists: this.schemaExists, exists: true }] as Row[], rowCount: 1 };
    if (/to_regclass\('public\.opensea_listings_events_v2_attempts'\)/.test(text)) return { rows: [{ exists: true }] as Row[], rowCount: 1 };
    if (/COUNT\(\*\) AS count FROM public\.opensea_listings_events_v2_attempts/.test(text)) return { rows: [{ count: this.counts.attemptLedger }] as Row[], rowCount: 1 };
    if (/SELECT\s+event_id::text[\s\S]*WHERE processing_status = 'pending'[\s\S]*opensea_rest_events_backfill/.test(text)) return { rows: [] as Row[], rowCount: 0 };
    if (/SELECT[\s\S]*FROM public\.opensea_listings_events_v2\s*$/.test(text)) {
      return {
        rows: [{
          orders: this.counts.orders,
          nft_state: this.counts.nftState,
          journal: this.counts.journal,
          pending: this.counts.pending,
          processing: this.counts.processing,
          failed: this.counts.failed,
          reconciliation_required: this.counts.reconciliationRequired,
          unfinalized: this.counts.pending + this.counts.processing + this.counts.failed,
          rest_pending: this.counts.restPending
        }] as Row[],
        rowCount: 1
      };
    }
    if (/WHERE event_id::text = ANY/.test(text)) {
      const ids = values?.[0] as string[];
      return { rows: ids.map((id) => this.rowsById.get(id)).filter(Boolean) as Row[], rowCount: ids.length };
    }
    throw new Error(`unexpected query: ${text}`);
  }
}

function persist(pool: FakePool, outcome: "inserted_pending" | "duplicate_existing" = "inserted_pending") {
  let next = 9000;
  return async (_pool: DbPool, rawEvent: unknown): Promise<DurableInboxPersistResult> => {
    const envelope = extractInboxJournalEnvelope(rawEvent, "2026-08-15T00:00:00.000Z")!;
    const eventId = String(++next);
    if (outcome === "inserted_pending") {
      pool.counts.journal += 1;
      pool.counts.pending += 1;
      pool.counts.restPending += 1;
      pool.rowsById.set(eventId, {
        event_id: eventId,
        event_type: envelope.eventType,
        chain: envelope.chain,
        contract_address: envelope.contractAddress,
        token_id: envelope.tokenId,
        transaction_hash: envelope.transactionHash,
        event_version: envelope.eventVersion,
        dedupe_key: envelope.dedupeKey,
        processing_status: "pending",
        attempt_count: 0,
        apply_result: null,
        applied_at: null,
        rest_source: "opensea_rest_events_backfill"
      });
    }
    return { outcome, eventId, dedupeKey: envelope.dedupeKey, eventType: envelope.eventType, orderHash: null, nftId: envelope.nftId, processingStatus: "pending", attemptCount: 0 };
  };
}

test("REST Tx A-only config requires every confirmation and fails closed on bad args before fetch", () => {
  for (const missing of REST_TXA_ONLY_REQUIRED_CONFIRMATIONS) {
    const args = baseArgs.filter((arg) => arg !== missing);
    assert.throws(() => loadRestTxaOnlyCanaryConfig([...args, "--output-dir", tempDir()], apiEnv), new RegExp(missing));
  }
  assert.throws(() => loadRestTxaOnlyCanaryConfig([...baseArgs, "--unknown", "--output-dir", tempDir()], apiEnv), /Unknown/);
  assert.throws(() => loadRestTxaOnlyCanaryConfig([...gates, "--before", "2", "--output-dir", tempDir()], apiEnv), /after/);
  assert.throws(() => loadRestTxaOnlyCanaryConfig([...gates, "--after", "2", "--output-dir", tempDir()], apiEnv), /before/);
  assert.throws(() => loadRestTxaOnlyCanaryConfig([...gates, "--after", "2", "--before", "2", "--output-dir", tempDir()], apiEnv), /after must be lower/);
  assert.throws(() => loadRestTxaOnlyCanaryConfig([...gates, "--after", "1", "--before", String(REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS + 2), "--output-dir", tempDir()], apiEnv), /window/);
  assert.throws(() => loadRestTxaOnlyCanaryConfig([...baseArgs, "--output-dir", tempDir()], {}), /OPENSEA_API_KEY/);
  const nonEmpty = tempDir();
  fs.mkdirSync(nonEmpty, { recursive: true });
  fs.writeFileSync(path.join(nonEmpty, "existing.txt"), "x");
  assert.throws(() => loadRestTxaOnlyCanaryConfig([...baseArgs, "--output-dir", nonEmpty], apiEnv), /empty/);
});

test("REST Tx A-only canary performs single transfer-only fetch, Tx A only, and writes sanitized evidence", async () => {
  const outputDir = tempDir();
  const cfg = config(outputDir);
  const pool = new FakePool();
  let fetches = 0;
  const summary = await runRestTxaOnlyCanary(cfg, {
    pool,
    client: { fetchCollectionEventsPage: async (input) => {
      fetches += 1;
      assert.deepEqual(input.eventTypes, ["transfer"]);
      return page([restTransfer()]);
    } },
    persistEvent: persist(pool),
    now: () => "2026-08-15T00:00:00.000Z"
  });
  assert.equal(fetches, 1);
  assert.equal(summary.result, "REST_TXA_ONLY_CANARY_COMPLETE");
  assert.equal(summary.txAInserted, 1);
  assert.equal(summary.insertedEventIds.length, 1);
  assert.equal(summary.duplicateEventIds.length, 0);
  assert.equal(summary.txBInvoked, false);
  assert.equal(summary.nftStateTouched, false);
  assert.equal(summary.activeOrdersTouched, false);
  assert.equal(summary.streamConnected, false);
  for (const name of ["txa_canary_summary.json", "txa_canary_rows.jsonl", "txa_canary_preflight.json", "txa_canary_postflight.json"]) {
    const text = fs.readFileSync(path.join(outputDir, name), "utf8");
    assert.doesNotMatch(text, /test-secret-key|X-API-KEY|authorization/i);
  }
  const persisted = JSON.parse(fs.readFileSync(path.join(outputDir, "txa_canary_summary.json"), "utf8"));
  assert.deepEqual(persisted, JSON.parse(JSON.stringify(summary)));
  assert.equal(persisted.evidenceWriteComplete, true);
  assert.equal(persisted.result, "REST_TXA_ONLY_CANARY_COMPLETE");
  const preflight = JSON.parse(fs.readFileSync(path.join(outputDir, "txa_canary_preflight.json"), "utf8"));
  assert.equal(preflight.sourceProvenance.combinedSha256 ?? preflight.sourceProvenance.sourceCombinedSha256, summary.sourceProvenance?.sourceCombinedSha256);
});

test("REST Tx A-only canary fails closed for wrong database and worker hold verification failure", async () => {
  const wrongDb = await runRestTxaOnlyCanary(config(), {
    pool: new FakePool("wrong_db"),
    client: { fetchCollectionEventsPage: async () => { throw new Error("must not fetch"); } },
    persistEvent: async () => { throw new Error("must not persist"); },
    writeEvidence: async () => {}
  });
  assert.equal(wrongDb.result, "REST_TXA_ONLY_CANARY_FAILED");
  assert.equal(wrongDb.pagesFetched, 0);
  assert.equal(wrongDb.txAInserted, 0);

  class HoldFailPool extends FakePool {
    override async query<Row = unknown>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
      if (/WHERE processing_status = 'pending'[\s\S]*opensea_rest_events_backfill/.test(text)) throw new Error("selector unavailable");
      return super.query(text, values);
    }
  }
  const hold = await runRestTxaOnlyCanary(config(), {
    pool: new HoldFailPool(),
    client: { fetchCollectionEventsPage: async () => { throw new Error("must not fetch"); } },
    persistEvent: async () => { throw new Error("must not persist"); },
    writeEvidence: async () => {}
  });
  assert.equal(hold.result, "REST_TXA_ONLY_CANARY_FAILED");
  assert.equal(hold.genericWorkerRestHoldVerified, false);
});

test("REST Tx A-only canary distinguishes multi-page complete from incomplete transport", async () => {
  const pool = new FakePool();
  const pages = [page([restTransfer()], "next"), page([restTransfer({ transaction: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })])];
  const multi = await runRestTxaOnlyCanary(config(), {
    pool,
    client: { fetchCollectionEventsPage: async () => pages.shift()! },
    persistEvent: persist(pool),
    writeEvidence: async () => {}
  });
  assert.equal(multi.transportComplete, true);
  assert.equal(multi.pagesFetched, 2);

  const bounded = await runRestTxaOnlyCanary(config(), {
    pool,
    client: { fetchCollectionEventsPage: async () => page([restTransfer()], "next") },
    persistEvent: persist(pool),
    writeEvidence: async () => {},
    now: () => "2026-08-15T00:00:00.000Z"
  });
  assert.notEqual(bounded.result, "REST_TXA_ONLY_CANARY_COMPLETE");

  const requestFailure = await runRestTxaOnlyCanary(config(), {
    pool: new FakePool(),
    client: { fetchCollectionEventsPage: async () => { throw new Error("HTTP 500 api_key=test-secret-key"); } },
    persistEvent: async () => { throw new Error("must not persist"); },
    writeEvidence: async () => {}
  });
  assert.equal(requestFailure.result, "REST_TXA_ONLY_CANARY_FAILED");
  assert.match(requestFailure.errors.join(" "), /api_key=<redacted>/);
});

test("REST Tx A-only canary is not complete on malformed event Tx A failure state delta row lifecycle or evidence failure", async () => {
  const malformedOutput = tempDir();
  const malformedPool = new FakePool();
  const malformed = await runRestTxaOnlyCanary(config(), {
    pool: malformedPool,
    client: { fetchCollectionEventsPage: async () => page([restTransfer(), { ...restTransfer(), transaction: null }]) },
    persistEvent: persist(malformedPool),
    writeEvidence: undefined
  });
  assert.equal(malformed.semanticCoverageComplete, false);
  assert.notEqual(malformed.result, "REST_TXA_ONLY_CANARY_COMPLETE");

  const persistedMalformed = await runRestTxaOnlyCanary(config(malformedOutput), {
    pool: new FakePool(),
    client: { fetchCollectionEventsPage: async () => page([restTransfer(), { ...restTransfer(), transaction: null }]) },
    persistEvent: persist(new FakePool()),
    writeEvidence: undefined
  });
  const persistedPartial = JSON.parse(fs.readFileSync(path.join(malformedOutput, "txa_canary_summary.json"), "utf8"));
  assert.deepEqual(persistedPartial, JSON.parse(JSON.stringify(persistedMalformed)));
  assert.equal(persistedPartial.result, "REST_TXA_ONLY_CANARY_PARTIAL");
  assert.equal(persistedPartial.evidenceWriteComplete, true);

  let calls = 0;
  const txAFailPool = new FakePool();
  const txAFail = await runRestTxaOnlyCanary(config(), {
    pool: txAFailPool,
    client: { fetchCollectionEventsPage: async () => page([restTransfer(), restTransfer({ transaction: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })]) },
    persistEvent: async (poolArg, raw) => {
      calls += 1;
      if (calls === 2) throw new Error("persist failed password=secret");
      return persist(txAFailPool)(poolArg, raw);
    },
    writeEvidence: async () => {}
  });
  assert.equal(txAFail.txAAdmissionComplete, false);
  assert.equal(txAFail.txAInserted, 1);
  assert.notEqual(txAFail.result, "REST_TXA_ONLY_CANARY_COMPLETE");

  const stateDeltaPool = new FakePool();
  const stateDelta = await runRestTxaOnlyCanary(config(), {
    pool: stateDeltaPool,
    client: { fetchCollectionEventsPage: async () => page([restTransfer()]) },
    persistEvent: async (poolArg, raw, at) => {
      const result = await persist(stateDeltaPool)(poolArg, raw, at);
      stateDeltaPool.counts.nftState += 1;
      return result;
    },
    writeEvidence: async () => {}
  });
  assert.equal(stateDelta.postflightStateNonMutationValid, false);
  assert.notEqual(stateDelta.result, "REST_TXA_ONLY_CANARY_COMPLETE");

  const badRowPool = new FakePool();
  const badRow = await runRestTxaOnlyCanary(config(), {
    pool: badRowPool,
    client: { fetchCollectionEventsPage: async () => page([restTransfer()]) },
    persistEvent: async (poolArg, raw, at) => {
      const result = await persist(badRowPool)(poolArg, raw, at);
      badRowPool.rowsById.get(result.eventId).processing_status = "applied";
      return result;
    },
    writeEvidence: async () => {}
  });
  assert.equal(badRow.newRowsValid, false);
  assert.notEqual(badRow.result, "REST_TXA_ONLY_CANARY_COMPLETE");

  const evidenceFail = await runRestTxaOnlyCanary(config(), {
    pool: new FakePool(),
    client: { fetchCollectionEventsPage: async () => page([]) },
    persistEvent: async () => { throw new Error("not called"); },
    writeEvidence: async () => { throw new Error("disk full"); }
  });
  assert.equal(evidenceFail.evidenceWriteComplete, false);
  assert.notEqual(evidenceFail.result, "REST_TXA_ONLY_CANARY_COMPLETE");
});

test("REST Tx A-only final summary write failure cannot complete and retains durable ids", async () => {
  const pool = new FakePool();
  const summary = await runRestTxaOnlyCanary(config(), {
    pool,
    client: { fetchCollectionEventsPage: async () => page([restTransfer()]) },
    persistEvent: persist(pool),
    writeEvidence: async (_outputDir, files) => {
      assert.ok("txa_canary_summary.json" in files);
      throw new Error("summary rename failed");
    }
  });
  assert.equal(summary.evidenceWriteComplete, false);
  assert.notEqual(summary.result, "REST_TXA_ONLY_CANARY_COMPLETE");
  assert.equal(summary.txAInserted, 1);
  assert.equal(summary.insertedEventIds.length, 1);
  assert.equal(summary.txBInvoked, false);
});

test("REST Tx A-only provenance is deterministic path-relative and fail-closed when a required file is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otg-provenance-"));
  for (const file of [
    "src/canary/restTxaOnlyCanary.ts",
    "src/canary/runRestTxaOnlyCanary.ts",
    "src/backfill/restEventAdapter.ts",
    "src/db/durableInboxRepository.ts",
    "src/db/inboxRetryRepository.ts"
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `content:${file}`);
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const first = computeRestTxaOnlyProvenance(root, "v-test");
  const second = computeRestTxaOnlyProvenance(root, "v-test");
  assert.equal(first.packageVersion, "1.2.3");
  assert.equal(first.nodeVersion, "v-test");
  assert.equal(first.sourceFiles.length, 6);
  for (const file of first.sourceFiles) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(file.path, /^[A-Za-z]:\\/);
  }
  assert.equal(first.sourceCombinedSha256, second.sourceCombinedSha256);
  assert.equal(first.sourceCombinedSha256, combinedProvenanceSha256([...first.sourceFiles].reverse()));
  fs.writeFileSync(path.join(root, "src/canary/restTxaOnlyCanary.ts"), "changed");
  const changed = computeRestTxaOnlyProvenance(root, "v-test");
  assert.notEqual(first.sourceCombinedSha256, changed.sourceCombinedSha256);
  assert.throws(() => computeRestTxaOnlyProvenance(path.join(root, "missing"), "v-test"), /ENOENT/);
});

test("REST Tx A-only provenance failure blocks before REST fetch and Tx A", async () => {
  const summary = await runRestTxaOnlyCanary(config(), {
    pool: new FakePool(),
    client: { fetchCollectionEventsPage: async () => { throw new Error("must not fetch"); } },
    persistEvent: async () => { throw new Error("must not persist"); },
    computeProvenance: () => { throw new Error("provenance missing"); },
    writeEvidence: async () => {}
  });
  assert.equal(summary.pagesFetched, 0);
  assert.equal(summary.txAInserted, 0);
  assert.notEqual(summary.result, "REST_TXA_ONLY_CANARY_COMPLETE");
});

test("REST Tx A-only canary records duplicate_existing ids and validates rows by SELECT only", async () => {
  const pool = new FakePool();
  pool.rowsById.set("42", {
    event_id: "42",
    event_type: "item_transferred",
    chain: "gunzilla",
    contract_address: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271",
    token_id: "20936559",
    transaction_hash: "0x4f6e5b59c9aa5027bee31c24c1e4e65725120b9245d19b43b592d561880212d7",
    event_version: null,
    dedupe_key: "transfer:v1:test",
    processing_status: "pending",
    attempt_count: 0,
    apply_result: null,
    applied_at: null,
    rest_source: "opensea_rest_events_backfill"
  });
  const summary = await runRestTxaOnlyCanary(config(), {
    pool,
    client: { fetchCollectionEventsPage: async () => page([restTransfer()]) },
    persistEvent: async () => ({ outcome: "duplicate_existing", eventId: "42", dedupeKey: "transfer:v1:test", eventType: "item_transferred", orderHash: null, nftId: "gunzilla/x/1", processingStatus: "pending", attemptCount: 0 }),
    writeEvidence: async () => {}
  });
  assert.equal(summary.txADuplicates, 1);
  assert.deepEqual(summary.duplicateEventIds, ["42"]);
  assert.deepEqual(summary.insertedEventIds, []);
  assert.equal(summary.result, "REST_TXA_ONLY_CANARY_COMPLETE");

  const validation = await validateInsertedRestTxaRows(pool, ["42"]);
  assert.equal(validation[0].valid, true);
});

test("REST Tx A-only CLI returns nonzero for partial and zero for complete without running package script", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const complete = await runRestTxaOnlyCanaryCli({
    argv: [...baseArgs, "--output-dir", tempDir()],
    env: apiEnv,
    stdout: { write: (chunk: string) => { out.push(chunk); return true; } },
    stderr: { write: (chunk: string) => { err.push(chunk); return true; } },
    runCanary: async (cfg) => ({ ...({
      result: "REST_TXA_ONLY_CANARY_COMPLETE",
      window: { after: cfg.after, before: cfg.before },
      maxWindowSeconds: REST_TXA_ONLY_CANARY_MAX_WINDOW_SECONDS,
      queryEventTypes: ["transfer"],
      gatesValid: true,
      databaseTargetValid: true,
      schemaPreflightValid: true,
      genericWorkerRestHoldVerified: true,
      transportComplete: true,
      semanticCoverageComplete: true,
      txAAdmissionComplete: true,
      postflightStateNonMutationValid: true,
      newRowsValid: true,
      evidenceWriteComplete: true,
      pagesFetched: 1,
      eventsObserved: 0,
      eventsAdapted: 0,
      eventsMalformed: 0,
      eventsUnsupported: 0,
      txAInserted: 0,
      txADuplicates: 0,
      txAErrors: 0,
      insertedEventIds: [],
      duplicateEventIds: [],
      txBInvoked: false,
      nftStateTouched: false,
      activeOrdersTouched: false,
      streamConnected: false,
      errors: []
    } as any) })
  });
  assert.equal(complete.exitCode, 0);
  const partial = await runRestTxaOnlyCanaryCli({
    argv: [...baseArgs, "--output-dir", tempDir()],
    env: apiEnv,
    stdout: { write: () => true },
    stderr: { write: () => true },
    runCanary: async (cfg) => ({ ...complete.summary!, result: "REST_TXA_ONLY_CANARY_PARTIAL", window: { after: cfg.after, before: cfg.before } })
  });
  assert.equal(partial.exitCode, 1);
  assert.equal(err.length, 0);
});

test("REST Tx A-only source has no Tx B state application imports live wiring or Stream dependency", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "restTxaOnlyCanary.ts"), "utf8")
    + fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "canary", "runRestTxaOnlyCanary.ts"), "utf8");
  assert.doesNotMatch(source, /applyPendingInboxEvent|applyNormalizedEventStateInTransaction|applyNormalizedEvent\(|runRestTransferWindowAdmissionBarrier|reduceNftState|findActiveOrdersForNftForUpdate|upsertNftState|durableInboxWorker|OpenSeaStreamClient|stream-js/);
  assert.match(source, /name\.endsWith\("\.jsonl"\)[\s\S]*fs\.fsyncSync\(handle\)[\s\S]*fs\.renameSync\(tmp, filePath\)/);
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts["canary:rest-txa-only"], "node dist/canary/runRestTxaOnlyCanary.js");
  assert.doesNotMatch(`${pkg.scripts.start} ${pkg.scripts.probe} ${pkg.scripts.canary} ${pkg.scripts["canary:durable"]}`, /runRestTxaOnlyCanary/);
});
