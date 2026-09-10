import assert from "node:assert/strict";
import test from "node:test";
import { REST_TRANSFER_AMBIGUOUS_APPLY_RESULT } from "../src/db/eventApplicationService.js";
import { extractInboxJournalEnvelope } from "../src/db/durableInboxRepository.js";
import {
  classifyRestTransferWindowEvents,
  loadRestTransferWindowJournalCandidates,
  protectedBoundarySecondsForWindow,
  runRestTransferWindowAdmissionBarrier,
  type TransferJournalCandidate
} from "../src/backfill/restTransferWindowBarrier.js";
import { adaptRestEventToDurableIngress } from "../src/backfill/restEventAdapter.js";
import type { DurableInboxPersistResult, PendingInboxApplyResult } from "../src/db/types.js";
import type { QueryResult, Queryable } from "../src/db/types.js";
import type { RestEventsPage } from "../src/backfill/types.js";

const receivedAt = "2026-08-13T11:00:00.000Z";
const owner = "0xf825620abf4f5e1d501dfc6f8f836846b5d7a3fc";

function restTransfer(overrides: Record<string, unknown> = {}): any {
  return {
    event_type: "transfer",
    event_timestamp: 1786618497,
    transaction: "0x3af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3",
    chain: "gunzilla",
    transfer_type: "transfer",
    from_address: "0xb93a9f4a1b41cb81b023b4efa7b6790c42f0437b",
    to_address: owner,
    nft: {
      identifier: "26224807",
      collection: "off-the-grid",
      contract: "0x9ed98e159be43a8d42b64053831fcae5e4d7d271",
      token_standard: "erc721"
    },
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
    literalResponseSha256: "test",
    literalResponseByteLength: 1,
    rateLimit: { limit: null, remaining: null, reset: null, retryAfter: null },
    retries: 0,
    rateLimitedResponses: 0
  };
}

function streamRawFrom(rest: any): any {
  return {
    event_type: "item_transferred",
    version: "1786618497000",
    payload: {
      event_timestamp: "2026-08-13T10:54:57.000Z",
      item: { nft_id: `gunzilla/0x9ed98e159be43a8d42b64053831fcae5e4d7d271/${rest.nft.identifier}`, metadata: {} },
      from_account: { address: "0x0000000000000000000000000000000000000000" },
      to_account: { address: rest.to_address },
      transaction: { hash: rest.transaction, timestamp: "1786618497" }
    }
  };
}

function streamRawFromWithTimestamp(rest: any, eventTimestamp: string): any {
  const raw = streamRawFrom(rest);
  raw.payload.event_timestamp = eventTimestamp;
  return raw;
}

function candidateFromRaw(eventId: string, raw: unknown, processingStatus = "pending"): TransferJournalCandidate {
  let envelope = extractInboxJournalEnvelope(raw, receivedAt);
  if (!envelope) {
    const adapted = adaptRestEventToDurableIngress(raw);
    assert.equal(adapted.outcome, "adapted");
    envelope = extractInboxJournalEnvelope(adapted.rawEvent, receivedAt);
  }
  assert.ok(envelope);
  return {
    eventId,
    eventType: envelope.eventType,
    eventTimestamp: envelope.eventTimestamp,
    eventVersion: envelope.eventVersion,
    chain: envelope.chain,
    contractAddress: envelope.contractAddress,
    tokenId: envelope.tokenId,
    transactionHash: envelope.transactionHash,
    dedupeKey: envelope.dedupeKey,
    processingStatus,
    rawPayload: envelope.rawPayload
  };
}

function persistSequence(journal: TransferJournalCandidate[]): (rawEvent: unknown, at: string) => Promise<DurableInboxPersistResult> {
  return async (rawEvent, at) => {
    const eventId = String(1000 + journal.length);
    const candidate = candidateFromRaw(eventId, rawEvent);
    journal.push(candidate);
    return {
      outcome: "inserted_pending",
      eventId,
      dedupeKey: candidate.dedupeKey,
      eventType: candidate.eventType,
      orderHash: null,
      nftId: `${candidate.chain}/${candidate.contractAddress}/${candidate.tokenId}`,
      processingStatus: "pending",
      attemptCount: 0
    };
  };
}

function applied(eventId: string, applyResult = "inserted_nft_transfer;suppressed_orders=0"): PendingInboxApplyResult {
  return { outcome: "reconciliation_required", eventId, eventType: "item_transferred", dedupeKey: "d", processingStatus: "reconciliation_required", attemptCount: 1, applyResult };
}

class JournalQuery implements Queryable {
  calls: Array<{ text: string; values: readonly unknown[] }> = [];
  constructor(private readonly rows: TransferJournalCandidate[]) {}
  async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    return {
      rows: this.rows.map((row) => ({
        event_id: row.eventId,
        event_type: row.eventType,
        event_timestamp: row.eventTimestamp,
        event_version: row.eventVersion,
        chain: row.chain,
        contract_address: row.contractAddress,
        token_id: row.tokenId,
        transaction_hash: row.transactionHash,
        dedupe_key: row.dedupeKey,
        processing_status: row.processingStatus,
        raw_payload: row.rawPayload
      })) as Row[],
      rowCount: this.rows.length
    };
  }
}

test("window foundation fetches complete transfer window, admits all Tx A before Tx B, and gates same-window ambiguity", async () => {
  const a = restTransfer();
  const b = restTransfer({ transaction: "0x4af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3", to_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const journal: TransferJournalCandidate[] = [];
  const txB: string[] = [];
  let loadCalledAfterAllTxA = false;
  const summary = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => page([a, b]) },
      persistEvent: persistSequence(journal),
      journal: new JournalQuery(journal),
      applyEventById: async (eventId) => {
        txB.push(eventId);
        return applied(eventId);
      },
      finalizeAmbiguousEventById: async (eventId) => {
        loadCalledAfterAllTxA = journal.length === 2;
        txB.push(eventId);
        return applied(eventId, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT);
      },
      now: () => receivedAt
    }
  );
  assert.equal(loadCalledAfterAllTxA, true);
  assert.equal(summary.txAInserted, 2);
  assert.equal(summary.ambiguousCount, 2);
  assert.deepEqual(txB.sort(), journal.map((row) => row.eventId).sort());
  assert.equal(summary.txBReconciliationNoState, 2);
});

test("old per-event order can miss late Tx A, while barrier classifies both after durable admission", () => {
  const aRaw = restTransfer();
  const bRaw = restTransfer({ transaction: "0x5af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" });
  const a = candidateFromRaw("1", aRaw);
  const b = candidateFromRaw("2", bRaw);
  assert.deepEqual(classifyRestTransferWindowEvents([a], ["1"]).map((row) => row.classification), ["SAFE"]);
  assert.deepEqual(classifyRestTransferWindowEvents([a, b], ["1", "2"]).map((row) => row.classification), ["AMBIGUOUS", "AMBIGUOUS"]);
});

test("boundary second defers until next complete overlap and does not release on partial next window", async () => {
  const a = restTransfer();
  const journal: TransferJournalCandidate[] = [];
  const txB: string[] = [];
  const first = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618498 } },
    {
      client: { fetchCollectionEventsPage: async () => page([a]) },
      persistEvent: persistSequence(journal),
      journal: new JournalQuery(journal),
      applyEventById: async (eventId) => { txB.push(eventId); return applied(eventId); },
      finalizeAmbiguousEventById: async (eventId) => { txB.push(eventId); return applied(eventId, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT); },
      now: () => receivedAt
    }
  );
  assert.equal(first.deferredBoundaryCount, 1);
  assert.equal(first.result, "REST_TRANSFER_WINDOW_PARTIAL");
  assert.equal(txB.length, 0);

  const partial = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618497, before: 1786618505 }, policy: { maxPages: 1 } },
    {
      client: { fetchCollectionEventsPage: async () => page([a], "next") },
      persistEvent: persistSequence(journal),
      journal: new JournalQuery([]),
      applyEventById: async (eventId) => { txB.push(eventId); return applied(eventId); },
      finalizeAmbiguousEventById: async (eventId) => { txB.push(eventId); return applied(eventId, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT); },
      now: () => receivedAt
    }
  );
  assert.equal(partial.transportComplete, false);
  assert.equal(txB.length, 0);

  const release = classifyRestTransferWindowEvents(journal, [journal[0].eventId]);
  assert.deepEqual(release.map((row) => row.classification), ["SAFE"]);
});

test("window completeness gates block Tx B on request failure malformed transfer and Tx A failure", async () => {
  const valid = restTransfer();
  let persistCalls = 0;
  const requestFailure = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => { throw new Error("HTTP 500 api_key=secret"); } },
      persistEvent: async () => { persistCalls += 1; throw new Error("must not persist"); },
      journal: new JournalQuery([]),
      applyEventById: async () => { throw new Error("must not apply"); },
      finalizeAmbiguousEventById: async () => { throw new Error("must not finalize"); },
      now: () => receivedAt
    }
  );
  assert.equal(requestFailure.transportComplete, false);
  assert.equal(requestFailure.txBProcessed, 0);
  assert.equal(persistCalls, 0);
  assert.doesNotMatch(requestFailure.errors.join("\n"), /secret/);

  const journal: TransferJournalCandidate[] = [];
  const malformed = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => page([valid, { ...valid, transaction: null }]) },
      persistEvent: persistSequence(journal),
      journal: new JournalQuery(journal),
      applyEventById: async () => { throw new Error("malformed window must not apply"); },
      finalizeAmbiguousEventById: async () => { throw new Error("malformed window must not finalize"); },
      now: () => receivedAt
    }
  );
  assert.equal(malformed.transportComplete, true);
  assert.equal(malformed.semanticCoverageComplete, false);
  assert.equal(malformed.txAInserted, 1);
  assert.equal(malformed.txBProcessed, 0);

  let txAPersisted = 0;
  const txAFailure = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => page([valid, restTransfer({ transaction: "0x7af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" })]) },
      persistEvent: async (rawEvent, at) => {
        txAPersisted += 1;
        if (txAPersisted === 2) throw new Error("insert failed password=secret");
        return persistSequence(journal)(rawEvent, at);
      },
      journal: new JournalQuery(journal),
      applyEventById: async () => { throw new Error("Tx A incomplete window must not apply"); },
      finalizeAmbiguousEventById: async () => { throw new Error("Tx A incomplete window must not finalize"); },
      now: () => receivedAt
    }
  );
  assert.equal(txAFailure.txAAdmissionComplete, false);
  assert.equal(txAFailure.txAErrors, 1);
  assert.equal(txAFailure.txBProcessed, 0);
  assert.doesNotMatch(txAFailure.errors.join("\n"), /secret/);
});

test("overlap duplicate same transaction is not ambiguity, but Stream different transaction is ambiguity", () => {
  const rest = candidateFromRaw("1", restTransfer());
  const sameStream = candidateFromRaw("2", streamRawFrom(restTransfer()), "reconciliation_required");
  assert.equal(sameStream.dedupeKey, rest.dedupeKey);
  assert.deepEqual(classifyRestTransferWindowEvents([rest, sameStream], ["1"]).map((row) => row.classification), ["SAFE"]);

  const differentStreamRaw = streamRawFrom(restTransfer({ transaction: "0x6af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" }));
  const differentStream = candidateFromRaw("3", differentStreamRaw, "reconciliation_required");
  assert.notEqual(differentStream.transactionHash, rest.transactionHash);
  assert.deepEqual(classifyRestTransferWindowEvents([rest, differentStream], ["1"]).map((row) => row.classification), ["AMBIGUOUS"]);
});

test("business-second grouping catches fractional Stream conflict and excludes adjacent second", () => {
  const rest = candidateFromRaw("1", restTransfer());
  const fractional = candidateFromRaw("2", streamRawFromWithTimestamp(restTransfer({ transaction: "0x8af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" }), "2026-08-13T10:54:57.450Z"), "reconciliation_required");
  assert.deepEqual(classifyRestTransferWindowEvents([rest, fractional], ["1"]).map((row) => row.classification), ["AMBIGUOUS"]);
  const nextSecond = candidateFromRaw("3", streamRawFromWithTimestamp(restTransfer({ transaction: "0x9af17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" }), "2026-08-13T10:54:58.000Z"), "reconciliation_required");
  assert.deepEqual(classifyRestTransferWindowEvents([rest, nextSecond], ["1"]).map((row) => row.classification), ["SAFE"]);
});

test("incomplete transfer candidate makes target uncertain instead of falsely safe", () => {
  const rest = candidateFromRaw("1", restTransfer());
  const incomplete = { ...rest, eventId: "2", transactionHash: null, dedupeKey: "transfer-fallback:v1:x", processingStatus: "reconciliation_required" };
  const classified = classifyRestTransferWindowEvents([rest, incomplete], ["1"], { candidateCoverageComplete: false });
  assert.deepEqual(classified.map((row) => row.classification), ["UNCERTAIN"]);
});

test("duplicate existing Tx A result is not scheduled for a second Tx B", async () => {
  const raw = restTransfer();
  const existing = candidateFromRaw("44", streamRawFrom(raw), "reconciliation_required");
  const txB: string[] = [];
  const summary = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => page([raw]) },
      persistEvent: async () => ({
        outcome: "duplicate_existing",
        eventId: existing.eventId,
        dedupeKey: existing.dedupeKey,
        eventType: "item_transferred",
        orderHash: null,
        nftId: existing.chain && existing.contractAddress && existing.tokenId ? `${existing.chain}/${existing.contractAddress}/${existing.tokenId}` : null,
        processingStatus: "reconciliation_required",
        attemptCount: 1
      }),
      journal: new JournalQuery([existing]),
      applyEventById: async (eventId) => { txB.push(eventId); return applied(eventId); },
      finalizeAmbiguousEventById: async (eventId) => { txB.push(eventId); return applied(eventId, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT); },
      now: () => receivedAt
    }
  );
  assert.equal(summary.duplicateExistingCount, 1);
  assert.equal(summary.txBProcessed, 0);
  assert.deepEqual(txB, []);
});

test("pending duplicate_existing REST row is reclassified and released while terminal duplicate is not reapplied", async () => {
  const raw = restTransfer();
  const pending = candidateFromRaw("45", raw, "pending");
  const txB: string[] = [];
  const summary = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => page([raw]) },
      persistEvent: async () => ({
        outcome: "duplicate_existing",
        eventId: pending.eventId,
        dedupeKey: pending.dedupeKey,
        eventType: "item_transferred",
        orderHash: null,
        nftId: `${pending.chain}/${pending.contractAddress}/${pending.tokenId}`,
        processingStatus: "pending",
        attemptCount: 0
      }),
      journal: new JournalQuery([pending]),
      applyEventById: async (eventId) => { txB.push(eventId); return applied(eventId); },
      finalizeAmbiguousEventById: async (eventId) => { txB.push(eventId); return applied(eventId, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT); },
      now: () => receivedAt
    }
  );
  assert.equal(summary.safeCount, 1);
  assert.deepEqual(txB, ["45"]);
});

test("all-duplicate crash restart and crash mid Tx B rerun reclassify pending rows only", async () => {
  const a = candidateFromRaw("51", restTransfer(), "reconciliation_required");
  const bRaw = restTransfer({ transaction: "0xaaf17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3", nft: { ...restTransfer().nft, identifier: "26224808" } });
  const b = candidateFromRaw("52", bRaw, "pending");
  const txB: string[] = [];
  const summary = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => page([restTransfer(), bRaw]) },
      persistEvent: async (rawEvent) => {
        const event = (rawEvent as any).payload.item.nft_id.endsWith("/26224808") ? b : a;
        return { outcome: "duplicate_existing", eventId: event.eventId, dedupeKey: event.dedupeKey, eventType: "item_transferred", orderHash: null, nftId: `${event.chain}/${event.contractAddress}/${event.tokenId}`, processingStatus: event.processingStatus as any, attemptCount: 1 };
      },
      journal: new JournalQuery([a, b]),
      applyEventById: async (eventId) => { txB.push(eventId); return applied(eventId); },
      finalizeAmbiguousEventById: async (eventId) => { txB.push(eventId); return applied(eventId, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT); },
      now: () => receivedAt
    }
  );
  assert.equal(summary.duplicateExistingCount, 2);
  assert.equal(summary.safeCount, 1);
  assert.deepEqual(txB, ["52"]);
});

test("ambiguous preclassification is authoritative and uses no-state finalization path", async () => {
  const a = restTransfer();
  const b = restTransfer({ transaction: "0xbbf17f9c9e29eb435a747573bfba623f63a31b9fda835588b216838862eefeb3" });
  const journal: TransferJournalCandidate[] = [];
  const noState: string[] = [];
  const summary = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => page([a, b]) },
      persistEvent: persistSequence(journal),
      journal: new JournalQuery(journal),
      applyEventById: async () => { throw new Error("ambiguous event must not enter normal Tx B"); },
      finalizeAmbiguousEventById: async (eventId) => { noState.push(eventId); return applied(eventId, REST_TRANSFER_AMBIGUOUS_APPLY_RESULT); },
      now: () => receivedAt
    }
  );
  assert.equal(summary.ambiguousCount, 2);
  assert.equal(summary.txBReconciliationNoState, 2);
  assert.deepEqual(noState.sort(), journal.map((row) => row.eventId).sort());
});

test("candidate repository query is bounded parameterized and includes transfer evidence statuses", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const rows = await loadRestTransferWindowJournalCandidates({
    async query<Row = unknown>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      calls.push({ text, values });
      return { rows: [] as Row[], rowCount: 0 };
    }
  }, { after: 1786618490, before: 1786618500 });
  assert.deepEqual(rows, []);
  assert.match(calls[0].text, /event_type = 'item_transferred'/);
  assert.match(calls[0].text, /event_timestamp >= \$1::timestamptz/);
  assert.match(calls[0].text, /event_timestamp < \$2::timestamptz/);
  assert.doesNotMatch(calls[0].text, /UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP/i);
  assert.deepEqual(calls[0].values, ["2026-08-13T10:54:49.000Z", "2026-08-13T10:55:01.000Z"]);
});

test("conservative protected boundary seconds are derived from UTC before edge", () => {
  assert.deepEqual(protectedBoundarySecondsForWindow({ after: 1786618490, before: 1786618500 }), ["2026-08-13T10:54:59.000Z", "2026-08-13T10:55:00.000Z"]);
});

test("same-process concurrent REST transfer windows fail closed instead of interleaving", async () => {
  let releaseFetch: (() => void) | null = null;
  const first = runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618490, before: 1786618500 } },
    {
      client: { fetchCollectionEventsPage: async () => new Promise<RestEventsPage>((resolve) => { releaseFetch = () => resolve(page([])); }) },
      persistEvent: async () => { throw new Error("must not persist empty first window"); },
      journal: new JournalQuery([]),
      applyEventById: async () => { throw new Error("must not apply"); },
      finalizeAmbiguousEventById: async () => { throw new Error("must not finalize"); },
      now: () => receivedAt
    }
  );
  const second = await runRestTransferWindowAdmissionBarrier(
    { window: { after: 1786618500, before: 1786618510 } },
    {
      client: { fetchCollectionEventsPage: async () => page([]) },
      persistEvent: async () => { throw new Error("concurrent call must not persist"); },
      journal: new JournalQuery([]),
      applyEventById: async () => { throw new Error("concurrent call must not apply"); },
      finalizeAmbiguousEventById: async () => { throw new Error("concurrent call must not finalize"); },
      now: () => receivedAt
    }
  );
  assert.equal(second.result, "REST_TRANSFER_WINDOW_FAILED");
  assert.equal(second.txAAdmissionComplete, false);
  assert.match(second.errors.join("\n"), /already in flight/);
  releaseFetch?.();
  await first;
});
