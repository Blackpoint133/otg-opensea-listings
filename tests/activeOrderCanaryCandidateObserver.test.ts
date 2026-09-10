import assert from "node:assert/strict";
import test from "node:test";
import { classifyDurableEventSafety, evaluateSnapshot, KNOWN_SYNTHETIC_CONTRACT, KNOWN_SYNTHETIC_DEDUPE_PREFIX, KNOWN_SYNTHETIC_ORDER_SOURCE, normalizeObserverTimestamp, validateJournalRawConsistency, runObserver, type CandidateRow, type DurableEventRow, type ObserverSnapshot, PRODUCTION_CHAIN, PRODUCTION_COLLECTION, PRODUCTION_CONTRACT } from "../scripts/observeActiveOrderCanaryCandidate.ts";

const nftId = `${PRODUCTION_CHAIN}/${PRODUCTION_CONTRACT}/48804197`;
const observedAt = "2026-08-21T17:00:00.000Z";

function row(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    event_id: "501", event_type: "item_transferred", processing_status: "pending", attempt_count: 0,
    dedupe_key: "gunzilla:transfer:501", event_timestamp: "2026-08-21T16:59:00.000Z", event_version: "2",
    transaction_hash: "0x" + "a".repeat(64), nft_id: nftId, chain: PRODUCTION_CHAIN, contract_address: PRODUCTION_CONTRACT,
    token_id: "48804197", raw_payload: { event_type: "item_transferred", version: 2, payload: { event_timestamp: "2026-08-21T16:59:00Z", from_account: { address: "0x" + "1".repeat(40) }, to_account: { address: "0x" + "2".repeat(40) }, transaction: { hash: "0x" + "a".repeat(64), timestamp: "2026-08-21T16:59:00Z" }, item: { nft_id: nftId } } },
    dedupe_count: 1, identity_conflict_count: 1,
    nft: { chain: PRODUCTION_CHAIN, contract_address: PRODUCTION_CONTRACT, token_id: "48804197", nft_id: nftId, collection_slug: PRODUCTION_COLLECTION, current_owner_address: "0x" + "1".repeat(40), last_transfer_from_address: "0x" + "3".repeat(40), last_transfer_to_address: "0x" + "1".repeat(40), last_transfer_transaction_hash: "0x" + "b".repeat(64), last_transfer_at: "2026-08-21T16:00:00Z", last_nft_event_timestamp: "2026-08-21T16:58:00Z", last_nft_event_version: "1", item_name: null, image_url: null, permalink: null, metadata_updated_at: null, created_at: observedAt, updated_at: observedAt },
    order: { order_hash: "0x" + "c".repeat(64), nft_id: nftId, collection_slug: PRODUCTION_COLLECTION, seller_address: "0x" + "4".repeat(40), status: "active", is_active: true, needs_reconciliation: false, reconciliation_reason: null, last_nft_event_timestamp: null, last_nft_event_version: null, last_transfer_transaction_hash: null },
    matching_active_order_count: 1,
    ...overrides
  };
}

function snapshot(events: CandidateRow[] = [row()], overrides: Partial<ObserverSnapshot> = {}): ObserverSnapshot {
  return { identity: { database: "server_otg", user: "observer", serverTime: observedAt }, counts: { total_orders: 1, active_orders: 1, nfts_with_active_orders: 1, nfts_with_multiple_active_orders: 0, pending_item_transferred_events: events.length, pending_item_transferred_one_active: 1, pending_item_transferred_multiple_active: 0 }, synthetic: { orders: 0, events: 0, nftStates: 0 }, events, ...overrides };
}

function durable(source: CandidateRow, overrides: Partial<DurableEventRow> = {}): DurableEventRow {
  return { event_id: source.event_id, event_type: source.event_type, event_timestamp: source.event_timestamp, event_version: source.event_version, transaction_hash: source.transaction_hash, dedupe_key: source.dedupe_key, payload_hash: "payload-" + source.event_id, chain: source.chain, contract_address: source.contract_address, token_id: source.token_id, nft_id: source.nft_id, raw_payload: source.raw_payload, ...overrides };
}

function restObservationRow(eventId: string, tokenId: string, timestamp = "2026-08-13T10:55:37.000Z", tx = "0x" + eventId.padStart(64, "0")): CandidateRow {
  const observationNftId = `${PRODUCTION_CHAIN}/${PRODUCTION_CONTRACT}/${tokenId}`;
  const base = row();
  const localJournalTimestamp = new Date(Date.parse(timestamp) - 7 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "-07");
  return row({
    event_id: eventId,
    dedupe_key: `transfer:v1:${eventId}`,
    event_timestamp: localJournalTimestamp,
    event_version: null,
    transaction_hash: tx,
    nft_id: observationNftId,
    token_id: tokenId,
    raw_payload: { ...(base.raw_payload as any), version: null, payload: { ...(base.raw_payload as any).payload, event_timestamp: timestamp, item: { ...(base.raw_payload as any).payload.item, nft_id: observationNftId }, transaction: { ...(base.raw_payload as any).payload.transaction, hash: tx, timestamp } } },
    nft: null,
    order: null,
    matching_active_order_count: 0
  });
}

test("zero orders produces NO_CANDIDATE", () => {
  const result = evaluateSnapshot(snapshot([], { counts: { total_orders: 0, active_orders: 0, pending_item_transferred_events: 13, pending_item_transferred_one_active: 0 } }));
  assert.equal(result.result, "NO_CANDIDATE");
});

test("pending transfers with zero active orders produce NO_CANDIDATE", () => {
  const result = evaluateSnapshot(snapshot([row({ order: null, matching_active_order_count: 0 })], { counts: { active_orders: 0, pending_item_transferred_events: 13, pending_item_transferred_one_active: 0 } }));
  assert.equal(result.result, "NO_CANDIDATE");
  assert.equal((result.candidates[0] as any).expectedSuppressionCount, 0);
});

test("exact one-order match produces CANDIDATE_FOUND with evidence", () => {
  const result = evaluateSnapshot(snapshot());
  assert.equal(result.result, "CANDIDATE_FOUND");
  assert.equal(result.candidateCount, 1);
  const candidate = result.candidates[0] as any;
  assert.equal(candidate.event_id, "501");
  assert.equal(candidate.matchingActiveOrderCount, 1);
  assert.equal(candidate.expectedSuppressionCount, 1);
  assert.equal(candidate.expectedApplication.classification, "APPLY");
  assert.equal(candidate.expectedApplication.applyResult, "updated_nft_transfer");
  assert.equal(candidate.order.is_active, true);
});

test("PostgreSQL timestamptz and ISO-Z timestamp normalize to the same instant", () => {
  assert.equal(normalizeObserverTimestamp("2026-08-13 03:55:37-07"), "2026-08-13T10:55:37.000Z");
  const base = row();
  const result = validateJournalRawConsistency(row({
    event_timestamp: "2026-08-13 03:55:37-07",
    raw_payload: { ...(base.raw_payload as any), payload: { ...(base.raw_payload as any).payload, event_timestamp: "2026-08-13T10:55:37.000Z", transaction: { ...(base.raw_payload as any).payload.transaction, timestamp: "2026-08-13T10:55:37.000Z" } } }
  }));
  assert.equal(result.valid, true);
});

test("different, timezone-less, and invalid journal timestamps fail closed", () => {
  const base = row();
  const different = validateJournalRawConsistency(row({ event_timestamp: "2026-08-13 03:55:38-07", raw_payload: { ...(base.raw_payload as any), payload: { ...(base.raw_payload as any).payload, event_timestamp: "2026-08-13T10:55:37.000Z" } } }));
  const timezoneLess = validateJournalRawConsistency(row({ event_timestamp: "2026-08-13 03:55:37" }));
  const invalid = validateJournalRawConsistency(row({ event_timestamp: "not-a-timestamp" }));
  assert.match(different.reasons.join(","), /journal_raw_timestamp_mismatch/);
  assert.match(timezoneLess.reasons.join(","), /journal_raw_timestamp_mismatch/);
  assert.match(invalid.reasons.join(","), /journal_raw_timestamp_mismatch/);
});

test("qualified candidate derives expected suppression count from exactly one order", () => {
  const result = evaluateSnapshot(snapshot());
  assert.equal((result.candidates[0] as any).expectedSuppressionCount, 1);
});

test("two active matching orders do not qualify", () => {
  const result = evaluateSnapshot(snapshot([row({ matching_active_order_count: 2 })]));
  assert.equal(result.result, "NO_CANDIDATE");
});

test("unrelated active order does not match", () => {
  const result = evaluateSnapshot(snapshot([row({ order: null, matching_active_order_count: 0 })]));
  assert.equal(result.result, "NO_CANDIDATE");
});

test("stale event is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ event_timestamp: "2026-08-21T16:00:00.000Z", raw_payload: { ...row().raw_payload as any, payload: { ...(row().raw_payload as any).payload, event_timestamp: "2026-08-21T16:00:00Z" } } })]));
  assert.equal(result.result, "NO_CANDIDATE");
  assert.match(JSON.stringify(result.candidates), /chronology_ignored_older/);
});

test("equal timestamp with uncomparable version is ambiguous", () => {
  const base = row();
  const result = evaluateSnapshot(snapshot([row({ nft: { ...base.nft!, last_nft_event_timestamp: "2026-08-21T16:59:00Z", last_nft_event_version: "not-a-version" } })]));
  assert.equal(result.result, "UNSAFE");
  assert.match(JSON.stringify(result.candidates), /chronology_ambiguous/);
});

test("malformed identity is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ nft_id: "not-an-nft-id", raw_payload: { ...(row().raw_payload as any), payload: { ...(row().raw_payload as any).payload, item: { nft_id: "not-an-nft-id" } } } })]));
  assert.equal(result.result, "UNSAFE");
});

test("consumed event is rejected", () => {
  assert.equal(evaluateSnapshot(snapshot([row({ processing_status: "reconciliation_required" })])).result, "NO_CANDIDATE");
});

test("nonzero attempt count is rejected", () => {
  assert.equal(evaluateSnapshot(snapshot([row({ attempt_count: 1 })])).result, "NO_CANDIDATE");
});

test("exact chain and contract are required", () => {
  assert.equal(evaluateSnapshot(snapshot([row({ chain: "ethereum" })])).result, "UNSAFE");
  assert.equal(evaluateSnapshot(snapshot([row({ contract_address: "0x" + "f".repeat(40) })])).result, "UNSAFE");
});

test("seller is not part of NFT matching", () => {
  const result = evaluateSnapshot(snapshot([row({ order: { ...row().order!, seller_address: "0x" + "9".repeat(40) } })]));
  assert.equal(result.result, "CANDIDATE_FOUND");
});

test("multiple safe candidates are listed deterministically", () => {
  const second = row({ event_id: "502", dedupe_key: "gunzilla:transfer:502", event_timestamp: "2026-08-21T17:00:00.000Z", raw_payload: { ...(row().raw_payload as any), payload: { ...(row().raw_payload as any).payload, event_timestamp: "2026-08-21T17:00:00Z", transaction: { ...(row().raw_payload as any).payload.transaction, timestamp: "2026-08-21T17:00:00Z" } } }, order: { ...row().order!, order_hash: "0x" + "d".repeat(64) } });
  const result = evaluateSnapshot(snapshot([row(), second]));
  assert.equal(result.result, "MULTIPLE_CANDIDATES");
  assert.deepEqual((result.candidates as any[]).map((candidate) => candidate.event_id), ["501", "502"]);
});

test("wrong database is UNSAFE and fail-closed", () => {
  const result = evaluateSnapshot(snapshot([], { identity: { database: "postgres", user: "observer", serverTime: observedAt } }));
  assert.equal(result.result, "UNSAFE");
  assert.deepEqual(result.errors, ["wrong_database"]);
});

test("observer SQL is SELECT-only and never contains row locks", async () => {
  const calls: string[] = [];
  const pool = { query: async <T>(text: string): Promise<{ rows: T[]; rowCount: number }> => {
    calls.push(text);
    if (/current_database/.test(text)) return { rows: [{ database: "server_otg", user: "observer", server_time: observedAt } as T], rowCount: 1 };
    if (/total_orders/.test(text)) return { rows: [{ total_orders: 0, active_orders: 0, nfts_with_active_orders: 0, nfts_with_multiple_active_orders: 0, pending_unfinalized_events: 0, reconciliation_required_events: 0, pending_item_transferred_events: 0, pending_item_transferred_one_active: 0, pending_item_transferred_multiple_active: 0 } as T], rowCount: 1 };
    if (/synthetic/.test(text)) return { rows: [{ orders: 0, events: 0, nft_states: 0 } as T], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }, end: async () => undefined } as any;
  const result = await runObserver(pool);
  assert.equal(result.result, "NO_CANDIDATE");
  assert.ok(calls.length >= 4);
  for (const sql of calls) { assert.match(sql, /^\s*SELECT\b/i); assert.doesNotMatch(sql, /FOR\s+(UPDATE|SHARE)|\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|DO)\b/i); }
});

test("observer source does not import apply or mutation repositories", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../scripts/observeActiveOrderCanaryCandidate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /applyPendingInboxEvent|upsertNftState|upsertOrderState|UPDATE\s+public|INSERT\s+INTO\s+public|DELETE\s+FROM\s+public/i);
});

test("clean production-like row passes the synthetic gate", () => {
  assert.equal(evaluateSnapshot(snapshot()).result, "CANDIDATE_FOUND");
});

test("synthetic order source is rejected per candidate", () => {
  const result = evaluateSnapshot(snapshot([row({ order: { ...row().order!, source: KNOWN_SYNTHETIC_ORDER_SOURCE } })]));
  assert.equal(result.result, "UNSAFE");
  assert.match(JSON.stringify(result.candidates), /synthetic_order_source/);
});

test("synthetic event marker is rejected per candidate", () => {
  const base = row();
  const raw = { ...(base.raw_payload as any), payload: { ...(base.raw_payload as any).payload, item: { ...(base.raw_payload as any).payload.item, permalink: "https://synthetic.invalid/48804197" } } };
  const result = evaluateSnapshot(snapshot([row({ raw_payload: raw })]));
  assert.equal(result.result, "UNSAFE");
  assert.match(JSON.stringify(result.candidates), /known_harness_permalink/);
});

test("known harness contract and dedupe markers are rejected", () => {
  assert.equal(evaluateSnapshot(snapshot([row({ contract_address: KNOWN_SYNTHETIC_CONTRACT })])).result, "UNSAFE");
  assert.equal(evaluateSnapshot(snapshot([row({ dedupe_key: KNOWN_SYNTHETIC_DEDUPE_PREFIX + "abc" })])).result, "UNSAFE");
});

test("aggregate synthetic count alone does not reject a clean candidate", () => {
  assert.equal(evaluateSnapshot(snapshot([row()], { synthetic: { orders: 7, events: 8, nftStates: 9 } })).result, "CANDIDATE_FOUND");
});

test("benign metadata text does not trigger synthetic exclusion", () => {
  const base = row();
  const raw = { ...(base.raw_payload as any), payload: { ...(base.raw_payload as any).payload, item: { ...(base.raw_payload as any).payload.item, metadata: { name: "synthetic test artifact" } } } };
  assert.equal(evaluateSnapshot(snapshot([row({ raw_payload: raw })])).result, "CANDIDATE_FOUND");
});

test("same identity timestamp version with different transaction hash is conflict", () => {
  const first = row();
  const second = row({ event_id: "502", transaction_hash: "0x" + "b".repeat(64), dedupe_key: "gunzilla:transfer:502" });
  const result = evaluateSnapshot(snapshot([first], { durableEvents: [durable(first), durable(second)] }));
  assert.equal(result.result, "UNSAFE");
  assert.match(JSON.stringify(result.candidates), /durable_event_conflict/);
});

test("non-null candidate version with NULL peer is ambiguous", () => {
  const first = durable(row(), { event_version: "1" });
  const peer = durable(row({ event_id: "502", transaction_hash: "0x" + "b".repeat(64), dedupe_key: "gunzilla:transfer:502" }), { event_version: null });
  assert.equal(classifyDurableEventSafety(first, [first, peer]).classification, "AMBIGUOUS");
});

test("NULL candidate version with non-null peer is ambiguous", () => {
  const first = durable(row(), { event_version: null });
  const peer = durable(row({ event_id: "502", transaction_hash: "0x" + "b".repeat(64), dedupe_key: "gunzilla:transfer:502" }), { event_version: "1" });
  assert.equal(classifyDurableEventSafety(first, [first, peer]).classification, "AMBIGUOUS");
});

test("both NULL versions remain fail-closed when equivalence is unproven", () => {
  const first = durable(row(), { event_version: null });
  const peer = durable(row({ event_id: "502" }), { event_version: null, dedupe_key: "other-key", payload_hash: "other-payload" });
  assert.equal(classifyDurableEventSafety(first, [first, peer]).classification, "AMBIGUOUS");
});

test("NULL-version peer is discovered without version in the peer key", () => {
  const first = durable(row(), { event_version: "1" });
  const peer = durable(row({ event_id: "502" }), { event_version: null });
  assert.notEqual(classifyDurableEventSafety(first, [first, peer]).classification, "SAFE_UNIQUE");
});

test("durable conflict detection is independent of active-order join shape", () => {
  const first = durable(row());
  const second = { ...first, event_id: "502", transaction_hash: "0x" + "b".repeat(64), dedupe_key: "gunzilla:transfer:502" };
  const results = [0, 1, 2].map((matchingActiveOrderCount) => evaluateSnapshot(snapshot([row({ matching_active_order_count: matchingActiveOrderCount })], { durableEvents: [first, second] })));
  assert.deepEqual(results.map((result) => result.result), ["UNSAFE", "UNSAFE", "UNSAFE"]);
  assert.ok(results.every((result) => JSON.stringify(result.candidates).includes("durable_event_conflict")));
});

test("exact equivalent duplicate is distinguished and rejected", () => {
  const first = durable(row());
  const duplicate = { ...first, event_id: "502" };
  assert.equal(classifyDurableEventSafety(first, [first, duplicate]).classification, "EQUIVALENT_DUPLICATE");
});

test("ambiguous same-identity durable representation fails closed", () => {
  const first = durable(row());
  const ambiguous = { ...first, event_id: "502", dedupe_key: "other-key", payload_hash: "other-payload" };
  assert.equal(classifyDurableEventSafety(first, [first, ambiguous]).classification, "AMBIGUOUS");
});

test("journal/raw transaction hash mismatch is rejected", () => {
  const base = row();
  const result = evaluateSnapshot(snapshot([row({ transaction_hash: "0x" + "b".repeat(64) })]));
  assert.notEqual(result.result, "CANDIDATE_FOUND");
  assert.match(JSON.stringify(result.candidates), /journal_raw_transaction_hash_mismatch/);
  assert.equal(validateJournalRawConsistency(row({ transaction_hash: "0x" + "b".repeat(64) })).valid, false);
  void base;
});

test("journal/raw timestamp mismatch is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ event_timestamp: "2026-08-21T16:58:00.000Z" })]));
  assert.notEqual(result.result, "CANDIDATE_FOUND");
  assert.match(JSON.stringify(result.candidates), /journal_raw_timestamp_mismatch/);
});

test("journal/raw version mismatch is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ event_version: "3" })]));
  assert.notEqual(result.result, "CANDIDATE_FOUND");
  assert.match(JSON.stringify(result.candidates), /journal_raw_version_mismatch/);
});

test("journal/raw chain mismatch is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ chain: "ethereum" })]));
  assert.notEqual(result.result, "CANDIDATE_FOUND");
  assert.match(JSON.stringify(result.candidates), /journal_raw_chain_mismatch/);
});

test("journal/raw contract mismatch is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ contract_address: "0x" + "f".repeat(40) })]));
  assert.notEqual(result.result, "CANDIDATE_FOUND");
  assert.match(JSON.stringify(result.candidates), /journal_raw_contract_mismatch/);
});

test("journal/raw token mismatch is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ token_id: "48804198" })]));
  assert.notEqual(result.result, "CANDIDATE_FOUND");
  assert.match(JSON.stringify(result.candidates), /journal_raw_token_mismatch/);
});

test("journal/raw event type mismatch is rejected", () => {
  const result = evaluateSnapshot(snapshot([row({ event_type: "item_listed" })]));
  assert.notEqual(result.result, "CANDIDATE_FOUND");
  assert.match(JSON.stringify(result.candidates), /journal_raw_event_type_mismatch/);
});

test("fully consistent journal/raw row proceeds to chronology APPLY", () => {
  const result = evaluateSnapshot(snapshot());
  const candidate = result.candidates[0] as any;
  assert.equal(result.result, "CANDIDATE_FOUND");
  assert.equal(candidate.gates.journalRawConsistency, true);
  assert.equal(candidate.gates.chronology, "APPLY");
});

test("chronology is not promoted after consistency failure", () => {
  const result = evaluateSnapshot(snapshot([row({ event_timestamp: "2026-08-21T16:00:00.000Z" })]));
  const rejected = result.candidates[0] as any;
  assert.equal(result.result, "UNSAFE");
  assert.equal(rejected.gates.chronology, "UNSAFE_TO_DETERMINE");
});

test("conflict, synthetic, and raw mismatch can never appear as candidates", () => {
  const base = row();
  const conflict = row({ event_id: "502", transaction_hash: "0x" + "b".repeat(64), dedupe_key: "gunzilla:transfer:502" });
  const syntheticResult = evaluateSnapshot(snapshot([row({ order: { ...base.order!, source: KNOWN_SYNTHETIC_ORDER_SOURCE } })]));
  const conflictResult = evaluateSnapshot(snapshot([base], { durableEvents: [durable(base), durable(conflict)] }));
  const mismatchResult = evaluateSnapshot(snapshot([row({ event_version: "3" })]));
  assert.equal(syntheticResult.candidateCount, 0);
  assert.equal(conflictResult.candidateCount, 0);
  assert.equal(mismatchResult.candidateCount, 0);
});

test("clean candidate plus inconsistent row makes the snapshot UNSAFE", () => {
  const inconsistent = row({ event_id: "502", dedupe_key: "gunzilla:transfer:502", event_timestamp: "2026-08-21T17:00:00.000Z" });
  const result = evaluateSnapshot(snapshot([row(), inconsistent]));
  assert.equal(result.result, "UNSAFE");
  assert.match(JSON.stringify(result.candidates), /journal_raw_timestamp_mismatch/);
});

test("clean candidate plus durable conflict makes the snapshot UNSAFE", () => {
  const clean = row();
  const conflict = row({ event_id: "502", transaction_hash: "0x" + "b".repeat(64), dedupe_key: "gunzilla:transfer:502" });
  const result = evaluateSnapshot(snapshot([clean], { durableEvents: [durable(clean), durable(conflict)] }));
  assert.equal(result.result, "UNSAFE");
});

test("clean candidate plus ambiguous durable peer makes the snapshot UNSAFE", () => {
  const clean = row();
  const ambiguous = row({ event_id: "502", dedupe_key: "other-key" });
  const result = evaluateSnapshot(snapshot([clean], { durableEvents: [durable(clean), durable(ambiguous, { payload_hash: "other-payload" })] }));
  assert.equal(result.result, "UNSAFE");
});

test("clean candidate plus synthetic candidate-like row makes the snapshot UNSAFE", () => {
  const synthetic = row({ event_id: "502", dedupe_key: "gunzilla:transfer:502", event_timestamp: "2026-08-21T17:00:00.000Z", order: { ...row().order!, source: KNOWN_SYNTHETIC_ORDER_SOURCE } });
  const result = evaluateSnapshot(snapshot([row(), synthetic]));
  assert.equal(result.result, "UNSAFE");
  assert.match(JSON.stringify(result.candidates), /synthetic_order_source/);
});

test("clean candidate plus ordinary stale row remains selectable", () => {
  const stale = row({ event_id: "502", dedupe_key: "gunzilla:transfer:502", event_timestamp: "2026-08-21T16:00:00.000Z", raw_payload: { ...(row().raw_payload as any), payload: { ...(row().raw_payload as any).payload, event_timestamp: "2026-08-21T16:00:00Z", transaction: { ...(row().raw_payload as any).payload.transaction, timestamp: "2026-08-21T16:00:00Z" } } } });
  const result = evaluateSnapshot(snapshot([row(), stale]));
  assert.equal(result.result, "CANDIDATE_FOUND");
});

test("clean candidate plus unrelated no-order row remains selectable", () => {
  const unrelated = row({ event_id: "502", dedupe_key: "gunzilla:transfer:502", event_timestamp: "2026-08-21T17:00:00.000Z", raw_payload: { ...(row().raw_payload as any), payload: { ...(row().raw_payload as any).payload, event_timestamp: "2026-08-21T17:00:00Z", transaction: { ...(row().raw_payload as any).payload.transaction, timestamp: "2026-08-21T17:00:00Z" } } }, order: null, matching_active_order_count: 0 });
  assert.equal(evaluateSnapshot(snapshot([row(), unrelated])).result, "CANDIDATE_FOUND");
});

test("ordinary rejections with no safe candidate produce NO_CANDIDATE", () => {
  const stale = row({ event_timestamp: "2026-08-21T16:00:00.000Z", raw_payload: { ...(row().raw_payload as any), payload: { ...(row().raw_payload as any).payload, event_timestamp: "2026-08-21T16:00:00Z", transaction: { ...(row().raw_payload as any).payload.transaction, timestamp: "2026-08-21T16:00:00Z" } } } });
  const unrelated = row({ event_id: "502", order: null, matching_active_order_count: 0, event_timestamp: "2026-08-21T17:00:00.000Z", raw_payload: { ...(row().raw_payload as any), payload: { ...(row().raw_payload as any).payload, event_timestamp: "2026-08-21T17:00:00Z", transaction: { ...(row().raw_payload as any).payload.transaction, timestamp: "2026-08-21T17:00:00Z" } } } });
  assert.equal(evaluateSnapshot(snapshot([stale, unrelated])).result, "NO_CANDIDATE");
});

test("unsafe row with no safe candidate produces UNSAFE", () => {
  const inconsistent = row({ event_timestamp: "2026-08-21T17:00:00.000Z" });
  assert.equal(evaluateSnapshot(snapshot([inconsistent])).result, "UNSAFE");
});

test("production-shaped REST event 87 with NULL version and no NFT state is NO_CANDIDATE", () => {
  const event = restObservationRow("87", "48804193");
  const result = evaluateSnapshot(snapshot([event], { counts: { active_orders: 0, pending_item_transferred_events: 1, pending_item_transferred_one_active: 0 }, durableEvents: [durable(event)] }));
  assert.equal(result.result, "NO_CANDIDATE");
  const rejected = result.candidates[0] as any;
  assert.deepEqual(rejected.rejectedReasons, ["active_order_count_not_one"]);
  assert.equal(rejected.eventNft.nft_id, event.nft_id);
  assert.equal(rejected.nft, null);
  assert.equal(rejected.expectedSuppressionCount, 0);
});

test("same-second different-NFT REST transfers are not durable peers", () => {
  const first = restObservationRow("88", "48804192");
  const second = restObservationRow("89", "48804191", "2026-08-13T10:55:35.000Z", "0x" + "b".repeat(64));
  const firstSafety = classifyDurableEventSafety(durable(first), [durable(first), durable(second)]);
  const secondSafety = classifyDurableEventSafety(durable(second), [durable(first), durable(second)]);
  assert.equal(firstSafety.classification, "SAFE_UNIQUE");
  assert.equal(secondSafety.classification, "SAFE_UNIQUE");
  assert.equal(evaluateSnapshot(snapshot([first, second], { counts: { active_orders: 0, pending_item_transferred_events: 2, pending_item_transferred_one_active: 0 }, durableEvents: [durable(first), durable(second)] })).result, "NO_CANDIDATE");
});

test("same-NFT same-time NULL-version REST peer remains ambiguous", () => {
  const first = restObservationRow("115", "48804166", "2026-08-13T10:54:55.000Z");
  const peer = restObservationRow("116", "48804166", "2026-08-13T10:54:55.000Z", "0x" + "c".repeat(64));
  assert.equal(classifyDurableEventSafety(durable(first), [durable(first), durable(peer)]).classification, "AMBIGUOUS");
});

test("journal and raw NULL versions are semantically consistent", () => {
  const event = restObservationRow("117", "48804164");
  assert.equal(validateJournalRawConsistency(event).valid, true);
});

test("non-null conflicting versions remain a journal/raw mismatch", () => {
  const base = row();
  const mismatch = validateJournalRawConsistency(row({ event_version: "3", raw_payload: { ...(base.raw_payload as any), version: 2 } }));
  assert.match(mismatch.reasons.join(","), /journal_raw_version_mismatch/);
});

test("missing raw transfer fields remain genuinely UNSAFE", () => {
  const result = evaluateSnapshot(snapshot([row({ raw_payload: { event_type: "item_transferred", payload: {} } })]));
  assert.equal(result.result, "UNSAFE");
});
