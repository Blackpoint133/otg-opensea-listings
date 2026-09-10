import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabasePool, createDatabasePool, loadDatabaseConfig } from "../src/db/pool.js";
import type { DbPool, QueryResult } from "../src/db/types.js";
import { compareEventVersions, normalizeBusinessTimestamp, normalizeEventVersion, normalizeTransferEvent, parseNftIdentity } from "../src/state/normalizers.js";
import { reduceNftState } from "../src/state/nftReducer.js";
import type { NftState, NormalizedTransferEvent } from "../src/state/types.js";

export const PRODUCTION_DATABASE = "server_otg";
export const PRODUCTION_CHAIN = "gunzilla";
export const PRODUCTION_CONTRACT = "0x9ed98e159be43a8d42b64053831fcae5e4d7d271";
export const PRODUCTION_COLLECTION = "off-the-grid";
export const KNOWN_SYNTHETIC_CONTRACT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const KNOWN_SYNTHETIC_ORDER_SOURCE = "synthetic_pg";
export const KNOWN_SYNTHETIC_DEDUPE_PREFIX = "active-order-pg:v1:";
export const KNOWN_SYNTHETIC_PERMALINK_PREFIX = "https://synthetic.invalid/";

type Row = Record<string, any>;
export interface ObserverSnapshot {
  identity: { database: string; user: string; serverTime: string };
  counts: Record<string, number>;
  synthetic: { orders: number; events: number; nftStates: number };
  events: CandidateRow[];
  durableEvents?: DurableEventRow[];
}

export interface DurableEventRow {
  event_id: string;
  event_type: string;
  event_timestamp: string | null;
  event_version: string | null;
  transaction_hash: string | null;
  dedupe_key: string;
  payload_hash: string;
  chain: string | null;
  contract_address: string | null;
  token_id: string | null;
  nft_id: string | null;
  raw_payload: unknown;
}

export interface CandidateRow {
  event_id: string;
  event_type: string;
  processing_status: string;
  attempt_count: number;
  dedupe_key: string;
  event_timestamp: string | null;
  event_version: string | null;
  transaction_hash: string | null;
  nft_id: string | null;
  chain: string | null;
  contract_address: string | null;
  token_id: string | null;
  raw_payload: unknown;
  dedupe_count: number;
  identity_conflict_count: number;
  nft: Row | null;
  order: Row | null;
  matching_active_order_count: number;
}

export interface ObserverResult {
  result: "CANDIDATE_FOUND" | "MULTIPLE_CANDIDATES" | "NO_CANDIDATE" | "UNSAFE";
  observedAt: string;
  database: string | null;
  user: string | null;
  counts: Record<string, number>;
  candidateCount: number;
  candidates: unknown[];
  warnings: string[];
  errors: string[];
  sourceProvenance: { files: Record<string, string>; combinedSha256: string };
}

const SELECT_ONLY = [
  /^(?:\s*\/\*[\s\S]*?\*\/\s*)?SELECT\b/i,
  /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|LOCK\s+TABLE|SET\s+ROLE)\b/i,
  /\bFOR\s+(?:UPDATE|SHARE)\b/i
];

export function assertSelectOnly(sql: string): void {
  if (!/^\s*SELECT\b/i.test(sql) || SELECT_ONLY.slice(1).some((pattern) => pattern.test(sql))) throw new Error(`observer emitted forbidden SQL: ${sql}`);
}

async function select<T>(pool: DbPool, sql: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
  assertSelectOnly(sql);
  return pool.query<T>(sql, values);
}

function numberValue(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function textValue(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }

function lower(value: string | null): string | null { return value === null ? null : value.toLowerCase(); }

/** Normalize both production ISO timestamps and PostgreSQL timestamptz text at the observer boundary. */
export function normalizeObserverTimestamp(value: unknown): string | null {
  const production = normalizeBusinessTimestamp(value);
  if (production !== null) return production;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(trimmed);
  if (!match) return null;
  let offset = match[3];
  if (/^[+-]\d{2}$/.test(offset)) offset = `${offset}:00`;
  if (/^[+-]\d{4}$/.test(offset)) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const parsed = Date.parse(`${match[1]}T${match[2]}${offset}`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function rawPayloadObject(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function syntheticMarkerReasons(row: CandidateRow): string[] {
  const reasons: string[] = [];
  const raw = rawPayloadObject(row.raw_payload);
  const payload = rawPayloadObject(raw?.payload);
  const permalink = payload?.item?.permalink;
  const restSource = payload?.rest_backfill_source?.source;
  if (row.order?.source === KNOWN_SYNTHETIC_ORDER_SOURCE) reasons.push("synthetic_order_source");
  if (row.contract_address?.toLowerCase() === KNOWN_SYNTHETIC_CONTRACT) reasons.push("known_disposable_contract");
  if (row.dedupe_key.startsWith(KNOWN_SYNTHETIC_DEDUPE_PREFIX)) reasons.push("known_harness_dedupe_prefix");
  if (typeof permalink === "string" && permalink.startsWith(KNOWN_SYNTHETIC_PERMALINK_PREFIX)) reasons.push("known_harness_permalink");
  if (restSource === KNOWN_SYNTHETIC_ORDER_SOURCE) reasons.push("synthetic_event_source");
  return reasons;
}

export type DurableEventSafety = "SAFE_UNIQUE" | "EQUIVALENT_DUPLICATE" | "CONFLICT" | "AMBIGUOUS";

function durableBaseKey(row: DurableEventRow): string | null {
  const timestamp = normalizeObserverTimestamp(row.event_timestamp);
  if (!row.event_type || !row.chain || !row.contract_address || !row.token_id || !timestamp) return null;
  return [row.event_type, row.chain.toLowerCase(), row.contract_address.toLowerCase(), row.token_id, timestamp].join("|");
}

function normalizedHash(value: string | null): string | null { return value === null ? null : value.toLowerCase(); }

export function classifyDurableEventSafety(candidate: DurableEventRow, durableEvents: DurableEventRow[]): { classification: DurableEventSafety; reasons: string[] } {
  const key = durableBaseKey(candidate);
  if (!key) return { classification: "AMBIGUOUS", reasons: ["candidate_durable_identity_incomplete"] };
  const candidateVersion = normalizeEventVersion(candidate.event_version);
  const peers = durableEvents.filter((row) => {
    if (row.event_id === candidate.event_id) return false;
    return durableBaseKey(row) === key;
  });
  const sameNftWithUnparseableIdentity = durableEvents.some((row) => row.event_id !== candidate.event_id
    && row.event_type === candidate.event_type
    && lower(row.chain) === lower(candidate.chain)
    && lower(row.contract_address) === lower(candidate.contract_address)
    && row.token_id === candidate.token_id
    && durableBaseKey(row) === null);
  if (sameNftWithUnparseableIdentity) return { classification: "AMBIGUOUS", reasons: ["durable_peer_identity_unparseable"] };
  for (const peer of peers) {
    const peerVersion = normalizeEventVersion(peer.event_version);
    if (candidateVersion === null || peerVersion === null) return { classification: "AMBIGUOUS", reasons: ["same_identity_uncomparable_version"] };
    if (candidateVersion !== peerVersion) continue;
    const candidateHash = normalizedHash(candidate.transaction_hash);
    const peerHash = normalizedHash(peer.transaction_hash);
    if (candidateHash === null || peerHash === null) return { classification: "AMBIGUOUS", reasons: ["same_identity_missing_transaction_hash"] };
    if (candidateHash !== peerHash) return { classification: "CONFLICT", reasons: ["same_identity_different_transaction_hash"] };
    if (candidate.dedupe_key === peer.dedupe_key && candidate.payload_hash === peer.payload_hash) return { classification: "EQUIVALENT_DUPLICATE", reasons: ["equivalent_durable_event_duplicate"] };
    return { classification: "AMBIGUOUS", reasons: ["same_identity_inconsistent_durable_representation"] };
  }
  return { classification: "SAFE_UNIQUE", reasons: [] };
}

export function validateJournalRawConsistency(row: CandidateRow): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const normalized = normalizeTransferEvent(row.raw_payload, "1970-01-01T00:00:00.000Z");
  if (!normalized) return { valid: false, reasons: ["raw_event_not_normalizable"] };
  const journalIdentity = parseNftIdentity(row.nft_id);
  const rawIdentity = normalized.nft;
  if (row.event_type !== normalized.eventType) reasons.push("journal_raw_event_type_mismatch");
  if (!journalIdentity || !rawIdentity || journalIdentity.chain !== rawIdentity.chain || journalIdentity.contractAddress !== rawIdentity.contractAddress || journalIdentity.tokenId !== rawIdentity.tokenId) reasons.push("journal_raw_nft_identity_mismatch");
  if (lower(row.chain) !== lower(rawIdentity?.chain ?? null)) reasons.push("journal_raw_chain_mismatch");
  if (lower(row.contract_address) !== lower(rawIdentity?.contractAddress ?? null)) reasons.push("journal_raw_contract_mismatch");
  if (row.token_id !== rawIdentity?.tokenId) reasons.push("journal_raw_token_mismatch");
  const journalTimestamp = row.event_timestamp === null ? null : normalizeObserverTimestamp(row.event_timestamp);
  if (journalTimestamp !== normalized.eventTimestamp) reasons.push("journal_raw_timestamp_mismatch");
  const journalVersion = normalizeEventVersion(row.event_version);
  if (journalVersion !== normalized.eventVersion) reasons.push("journal_raw_version_mismatch");
  if (normalizedHash(row.transaction_hash) !== normalizedHash(normalized.transactionHash)) reasons.push("journal_raw_transaction_hash_mismatch");
  return { valid: reasons.length === 0, reasons };
}

function nftFromRow(row: Row | null): NftState | null {
  if (!row) return null;
  return {
    identity: { nftId: row.nft_id, chain: row.chain, contractAddress: row.contract_address, tokenId: String(row.token_id) },
    collectionSlug: row.collection_slug,
    currentOwnerAddress: row.current_owner_address,
    lastTransferFromAddress: row.last_transfer_from_address,
    lastTransferToAddress: row.last_transfer_to_address,
    lastTransferTransactionHash: row.last_transfer_transaction_hash,
    lastTransferAt: row.last_transfer_at,
    lastNftEventTimestamp: row.last_nft_event_timestamp,
    lastNftEventVersion: row.last_nft_event_version == null ? null : String(row.last_nft_event_version),
    item: { name: row.item_name ?? null, imageUrl: row.image_url ?? null, permalink: row.permalink ?? null },
    metadataUpdatedAt: row.metadata_updated_at ?? null,
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? ""
  };
}

export type ChronologyClassification = "APPLY" | "IGNORED_OLDER" | "AMBIGUOUS" | "UNSAFE_TO_DETERMINE";

export function classifyChronology(current: NftState | null, event: NormalizedTransferEvent, now: string): { classification: ChronologyClassification; applyResult: string; ignored: boolean } {
  if (!event.nft || !event.eventTimestamp || !event.transactionHash) return { classification: "UNSAFE_TO_DETERMINE", applyResult: "ignored_malformed_transfer", ignored: true };
  if (current?.lastNftEventTimestamp && current.lastNftEventVersion) {
    const incomingTime = Date.parse(event.eventTimestamp);
    const currentTime = Date.parse(current.lastNftEventTimestamp);
    if (!Number.isFinite(incomingTime) || !Number.isFinite(currentTime)) return { classification: "UNSAFE_TO_DETERMINE", applyResult: "unknown", ignored: true };
    if (incomingTime === currentTime && compareEventVersions(event.eventVersion, current.lastNftEventVersion) === null) return { classification: "AMBIGUOUS", applyResult: "unknown", ignored: true };
  }
  const reduced = reduceNftState(current, event, now);
  return reduced.ignored
    ? { classification: reduced.applyResult === "ignored_older_transfer" ? "IGNORED_OLDER" : "UNSAFE_TO_DETERMINE", applyResult: reduced.applyResult, ignored: true }
    : { classification: "APPLY", applyResult: reduced.applyResult, ignored: false };
}

const NORMAL_NON_CANDIDATE_REASONS = new Set(["event_type_mismatch", "event_not_pending", "attempt_count_not_zero", "active_order_count_not_one", "multiple_matching_active_orders"]);

function evaluateRow(row: CandidateRow, observedAt: string, allDurableEvents: DurableEventRow[]): { safe: boolean; unsafe: boolean; reasons: string[]; candidate: unknown } {
  const reasons: string[] = [];
  const identity = parseNftIdentity(row.nft_id);
  const normalized = normalizeTransferEvent(row.raw_payload, observedAt);
  const consistency = validateJournalRawConsistency(row);
  if (row.event_type !== "item_transferred") reasons.push("event_type_mismatch");
  if (row.processing_status !== "pending") reasons.push("event_not_pending");
  if (row.attempt_count !== 0) reasons.push("attempt_count_not_zero");
  if (!identity || !normalized?.nft) reasons.push("malformed_nft_identity");
  if (identity && (identity.chain !== PRODUCTION_CHAIN || identity.contractAddress !== PRODUCTION_CONTRACT)) reasons.push("production_identity_mismatch");
  if (!normalized?.eventTimestamp || !normalized.transactionHash) reasons.push("malformed_transfer_payload");
  if (normalized?.nft && row.nft_id !== normalized.nft.nftId) reasons.push("row_payload_nft_mismatch");
  if (row.chain !== PRODUCTION_CHAIN || row.contract_address?.toLowerCase() !== PRODUCTION_CONTRACT || !row.token_id) reasons.push("journal_identity_mismatch");
  const markers = syntheticMarkerReasons(row);
  reasons.push(...markers);
  if (!consistency.valid) reasons.push(...consistency.reasons);
  if (row.nft && row.nft.collection_slug !== PRODUCTION_COLLECTION) reasons.push("nft_state_collection_mismatch");
  if (row.order && (row.order.collection_slug !== PRODUCTION_COLLECTION || row.order.nft_id !== row.nft_id)) reasons.push("order_identity_mismatch");
  if (row.matching_active_order_count !== 1) reasons.push(row.matching_active_order_count > 1 ? "multiple_matching_active_orders" : "active_order_count_not_one");
  const durableCandidate = allDurableEvents.find((event) => event.event_id === row.event_id);
  const eventSafety = durableCandidate ? classifyDurableEventSafety(durableCandidate, allDurableEvents) : { classification: "AMBIGUOUS" as const, reasons: ["candidate_durable_event_missing"] };
  if (eventSafety.classification !== "SAFE_UNIQUE") reasons.push(`durable_event_${eventSafety.classification.toLowerCase()}`);
  const chronology = consistency.valid && normalized ? classifyChronology(nftFromRow(row.nft), normalized, observedAt) : { classification: "UNSAFE_TO_DETERMINE" as const, applyResult: "unknown", ignored: true };
  if (chronology.classification !== "APPLY") reasons.push(`chronology_${chronology.classification.toLowerCase()}`);
  const candidate = {
    event_id: row.event_id, event_type: row.event_type, processing_status: row.processing_status, attempt_count: row.attempt_count,
    dedupe_key: row.dedupe_key, businessTimestamp: row.event_timestamp, version: row.event_version, transactionHash: row.transaction_hash,
    eventNft: normalized?.nft ? { chain: normalized.nft.chain, contract: normalized.nft.contractAddress, token: normalized.nft.tokenId, nft_id: normalized.nft.nftId } : null,
    nft: row.nft ? { chain: row.nft.chain, contract: row.nft.contract_address, token: String(row.nft.token_id), nft_id: row.nft.nft_id, currentOwner: row.nft.current_owner_address, currentTimestamp: row.nft.last_nft_event_timestamp, currentVersion: row.nft.last_nft_event_version } : null,
    order: row.order ? { order_hash: row.order.order_hash, seller_address: row.order.seller_address, source: row.order.source, status: row.order.status, is_active: row.order.is_active, needs_reconciliation: row.order.needs_reconciliation, reconciliation_reason: row.order.reconciliation_reason, last_nft_event_timestamp: row.order.last_nft_event_timestamp, last_nft_event_version: row.order.last_nft_event_version, last_transfer_transaction_hash: row.order.last_transfer_transaction_hash } : null,
    matchingActiveOrderCount: row.matching_active_order_count,
    expectedSuppressionCount: row.matching_active_order_count === 1 ? 1 : 0,
    gates: { productionIdentity: row.chain === PRODUCTION_CHAIN && row.contract_address?.toLowerCase() === PRODUCTION_CONTRACT, syntheticExclusion: markers.length === 0, durableEventSafety: eventSafety.classification, journalRawConsistency: consistency.valid, chronology: chronology.classification, matchingActiveOrderCount: row.matching_active_order_count },
    chronology: chronology.classification,
    expectedApplication: { classification: chronology.classification, applyResult: chronology.applyResult }
  };
  const unsafe = reasons.some((reason) => !NORMAL_NON_CANDIDATE_REASONS.has(reason) && reason !== "chronology_ignored_older");
  return { safe: reasons.length === 0, unsafe, reasons, candidate: reasons.length === 0 ? candidate : { ...candidate, rejectedReasons: reasons } };
}

export function evaluateSnapshot(snapshot: ObserverSnapshot): ObserverResult {
  const observedAt = snapshot.identity.serverTime;
  const warnings = ["Observation is not execution authorization; candidate state may change immediately after this SELECT-only snapshot."];
  const errors: string[] = [];
  if (snapshot.identity.database !== PRODUCTION_DATABASE) return { result: "UNSAFE", observedAt, database: snapshot.identity.database, user: snapshot.identity.user, counts: snapshot.counts, candidateCount: 0, candidates: [], warnings, errors: ["wrong_database"], sourceProvenance: sourceProvenance() };
  const allDurableEvents = snapshot.durableEvents ?? snapshot.events.map((row) => ({ event_id: row.event_id, event_type: row.event_type, event_timestamp: row.event_timestamp, event_version: row.event_version, transaction_hash: row.transaction_hash, dedupe_key: row.dedupe_key, payload_hash: "", chain: row.chain, contract_address: row.contract_address, token_id: row.token_id, nft_id: row.nft_id, raw_payload: row.raw_payload }));
  const evaluated = snapshot.events.map((row) => evaluateRow(row, observedAt, allDurableEvents));
  const unsafe = evaluated.filter((entry) => entry.unsafe);
  const safe = evaluated.filter((entry) => entry.safe).map((entry) => entry.candidate);
  const rejected = evaluated.filter((entry) => !entry.safe).map((entry) => entry.candidate);
  if (unsafe.length > 0) return { result: "UNSAFE", observedAt, database: snapshot.identity.database, user: snapshot.identity.user, counts: snapshot.counts, candidateCount: 0, candidates: unsafe.map((entry) => entry.candidate), warnings, errors: unsafe.flatMap((entry) => entry.reasons), sourceProvenance: sourceProvenance() };
  const result = safe.length === 0 ? "NO_CANDIDATE" : safe.length === 1 ? "CANDIDATE_FOUND" : "MULTIPLE_CANDIDATES";
  return { result, observedAt, database: snapshot.identity.database, user: snapshot.identity.user, counts: snapshot.counts, candidateCount: safe.length, candidates: safe.length ? safe : rejected, warnings, errors, sourceProvenance: sourceProvenance() };
}

const EVENT_COLUMNS = `e.event_id::text,e.event_type,e.processing_status,e.attempt_count,e.dedupe_key,e.event_timestamp::text,e.event_version::text,e.transaction_hash,e.nft_id,e.chain,e.contract_address,e.token_id,e.raw_payload,count(o.order_hash) OVER (PARTITION BY e.event_id) AS matching_active_order_count`;
const NFT_COLUMNS = `n.chain AS nft_chain,n.contract_address AS nft_contract,n.token_id AS nft_token,n.nft_id AS nft_nft_id,n.collection_slug AS nft_collection_slug,n.current_owner_address,n.last_transfer_from_address,n.last_transfer_to_address,n.last_transfer_transaction_hash,n.last_transfer_at::text AS last_transfer_at,n.last_nft_event_timestamp::text AS nft_last_nft_event_timestamp,n.last_nft_event_version::text AS nft_last_nft_event_version,n.item_name,n.image_url,n.permalink,n.metadata_updated_at::text AS metadata_updated_at,n.created_at::text AS nft_created_at,n.updated_at::text AS nft_updated_at`;
const ORDER_COLUMNS = `o.order_hash,o.nft_id AS order_nft_id,o.collection_slug AS order_collection_slug,o.seller_address,o.source,o.status,o.is_active,o.needs_reconciliation,o.reconciliation_reason,o.last_nft_event_timestamp::text AS order_last_nft_event_timestamp,o.last_nft_event_version::text AS order_last_nft_event_version,o.last_transfer_transaction_hash`;

function mergeJoinedRow(row: Row): CandidateRow {
  const nft = row.nft_nft_id == null ? null : { chain: row.nft_chain, contract_address: row.nft_contract, token_id: row.nft_token, nft_id: row.nft_nft_id, collection_slug: row.nft_collection_slug, current_owner_address: row.current_owner_address, last_transfer_from_address: row.last_transfer_from_address, last_transfer_to_address: row.last_transfer_to_address, last_transfer_transaction_hash: row.last_transfer_transaction_hash, last_transfer_at: row.last_transfer_at, last_nft_event_timestamp: row.nft_last_nft_event_timestamp, last_nft_event_version: row.nft_last_nft_event_version, item_name: row.item_name, image_url: row.image_url, permalink: row.permalink, metadata_updated_at: row.metadata_updated_at, created_at: row.nft_created_at, updated_at: row.nft_updated_at };
  const order = row.order_hash == null ? null : { order_hash: row.order_hash, nft_id: row.order_nft_id, collection_slug: row.order_collection_slug, seller_address: row.seller_address, source: row.source, status: row.status, is_active: row.is_active, needs_reconciliation: row.needs_reconciliation, reconciliation_reason: row.reconciliation_reason, last_nft_event_timestamp: row.order_last_nft_event_timestamp, last_nft_event_version: row.order_last_nft_event_version, last_transfer_transaction_hash: row.last_transfer_transaction_hash };
  return { event_id: row.event_id, event_type: row.event_type, processing_status: row.processing_status, attempt_count: numberValue(row.attempt_count), dedupe_key: row.dedupe_key, event_timestamp: row.event_timestamp, event_version: row.event_version == null ? null : String(row.event_version), transaction_hash: row.transaction_hash, nft_id: row.nft_id, chain: row.chain, contract_address: row.contract_address, token_id: row.token_id == null ? null : String(row.token_id), raw_payload: row.raw_payload, dedupe_count: 1, identity_conflict_count: 1, nft, order, matching_active_order_count: numberValue(row.matching_active_order_count) };
}

async function readSnapshot(pool: DbPool): Promise<ObserverSnapshot> {
  const identity = (await select<{ database: string; user: string; server_time: string }>(pool, "SELECT current_database() AS database, current_user AS user, now()::text AS server_time")).rows[0];
  if (!identity) throw new Error("database identity query returned no row");
  if (identity.database !== PRODUCTION_DATABASE) return { identity: { database: identity.database, user: identity.user, serverTime: identity.server_time }, counts: {}, synthetic: { orders: 0, events: 0, nftStates: 0 }, events: [] };
  const countsRow = (await select<Row>(pool, `SELECT
    (SELECT count(*)::int FROM public.opensea_listings_v2) AS total_orders,
    (SELECT count(*)::int FROM public.opensea_listings_v2 WHERE status='active' AND is_active=true) AS active_orders,
    (SELECT count(DISTINCT (chain,contract_address,token_id))::int FROM public.opensea_listings_v2 WHERE status='active' AND is_active=true) AS nfts_with_active_orders,
    (SELECT count(*)::int FROM (SELECT chain,contract_address,token_id FROM public.opensea_listings_v2 WHERE status='active' AND is_active=true GROUP BY chain,contract_address,token_id HAVING count(*) > 1) x) AS nfts_with_multiple_active_orders,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE apply_result IS NULL) AS pending_unfinalized_events,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='reconciliation_required') AS reconciliation_required_events,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE processing_status='pending' AND event_type='item_transferred') AS pending_item_transferred_events,
    (SELECT count(*)::int FROM (SELECT e.event_id FROM public.opensea_listings_events_v2 e JOIN public.opensea_listings_v2 o ON o.chain=e.chain AND o.contract_address=e.contract_address AND o.token_id=e.token_id AND o.status='active' AND o.is_active=true WHERE e.processing_status='pending' AND e.event_type='item_transferred' GROUP BY e.event_id HAVING count(*)=1) x) AS pending_item_transferred_one_active,
    (SELECT count(*)::int FROM (SELECT e.event_id FROM public.opensea_listings_events_v2 e JOIN public.opensea_listings_v2 o ON o.chain=e.chain AND o.contract_address=e.contract_address AND o.token_id=e.token_id AND o.status='active' AND o.is_active=true WHERE e.processing_status='pending' AND e.event_type='item_transferred' GROUP BY e.event_id HAVING count(*)>1) x) AS pending_item_transferred_multiple_active`)).rows[0];
  if (!countsRow) throw new Error("aggregate query returned no row");
  const eventRows = (await select<Row>(pool, `SELECT ${EVENT_COLUMNS}, ${NFT_COLUMNS}, ${ORDER_COLUMNS}
    FROM public.opensea_listings_events_v2 e
    LEFT JOIN public.opensea_listings_nft_state_v2 n ON n.chain=e.chain AND n.contract_address=e.contract_address AND n.token_id=e.token_id
    LEFT JOIN public.opensea_listings_v2 o ON o.chain=e.chain AND o.contract_address=e.contract_address AND o.token_id=e.token_id AND o.status='active' AND o.is_active=true
    WHERE e.processing_status='pending' AND e.event_type='item_transferred' AND e.chain=$1 AND lower(e.contract_address)=lower($2)
    ORDER BY e.event_id,o.order_hash`, [PRODUCTION_CHAIN, PRODUCTION_CONTRACT])).rows.map(mergeJoinedRow);
  const durableEvents = (await select<DurableEventRow>(pool, `SELECT event_id::text,event_type,event_timestamp::text,event_version::text,transaction_hash,dedupe_key,payload_hash,chain,contract_address,token_id,nft_id,raw_payload
    FROM public.opensea_listings_events_v2
    WHERE event_type='item_transferred' AND chain=$1 AND lower(contract_address)=lower($2)
    ORDER BY event_id`, [PRODUCTION_CHAIN, PRODUCTION_CONTRACT])).rows;
  const synthetic = (await select<Row>(pool, `SELECT
    (SELECT count(*)::int FROM public.opensea_listings_v2 WHERE lower(coalesce(source,'')) LIKE ANY(ARRAY['%synthetic%','%disposable%','%test%']) OR lower(coalesce(order_hash,'')) LIKE ANY(ARRAY['%synthetic%','%disposable%','%test%'])) AS orders,
    (SELECT count(*)::int FROM public.opensea_listings_events_v2 WHERE lower(coalesce(dedupe_key,'')) LIKE ANY(ARRAY['%synthetic%','%disposable%','%test%']) OR raw_payload::text ILIKE ANY(ARRAY['%synthetic%','%disposable%'])) AS events,
    (SELECT count(*)::int FROM public.opensea_listings_nft_state_v2 WHERE lower(coalesce(nft_id,'')) LIKE ANY(ARRAY['%synthetic%','%disposable%','%test%'])) AS nft_states`)).rows[0];
  if (!synthetic) throw new Error("synthetic marker query returned no row");
  return { identity: { database: identity.database, user: identity.user, serverTime: identity.server_time }, counts: Object.fromEntries(Object.entries(countsRow).map(([key, value]) => [key, numberValue(value)])), synthetic: { orders: numberValue(synthetic.orders), events: numberValue(synthetic.events), nftStates: numberValue(synthetic.nft_states) }, events: eventRows, durableEvents };
}

function sourceRoot(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); }
function sourceProvenance(): { files: Record<string, string>; combinedSha256: string } {
  const root = sourceRoot();
  const relative = ["src/db/eventApplicationService.ts", "src/db/pendingInboxApplicationService.ts", "src/db/listingRepository.ts", "src/db/nftStateRepository.ts", "src/state/nftReducer.ts", "src/state/orderReducer.ts", "src/db/pool.ts", "package.json", "scripts/observeActiveOrderCanaryCandidate.ts"];
  const files: Record<string, string> = {};
  for (const file of relative) { try { files[file] = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"); } catch { files[file] = "unavailable"; } }
  const combinedSha256 = createHash("sha256").update(relative.map((file) => `${file}:${files[file]}\n`).join(""), "utf8").digest("hex");
  return { files, combinedSha256 };
}

export async function runObserver(pool: DbPool): Promise<ObserverResult> {
  try { return evaluateSnapshot(await readSnapshot(pool)); }
  catch (error) { const observedAt = new Date().toISOString(); return { result: "UNSAFE", observedAt, database: null, user: null, counts: {}, candidateCount: 0, candidates: [], warnings: ["No mutation or fallback query was attempted."], errors: [error instanceof Error ? error.message : String(error)], sourceProvenance: sourceProvenance() }; }
}

async function writeJson(output: string | undefined, value: ObserverResult): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (!output) { process.stdout.write(json); return; }
  const handle = await fs.open(path.resolve(output), "wx");
  try { await handle.writeFile(json, "utf8"); } finally { await handle.close(); }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const outputIndex = args.indexOf("--output-file");
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !output) throw new Error("--output-file requires a path");
  const config = { ...loadDatabaseConfig(), applicationName: "opensea_active_order_candidate_observer", statementTimeoutMillis: 15_000, queryTimeoutMillis: 15_000 };
  const pool = createDatabasePool(config);
  try { const result = await runObserver(pool); await writeJson(output, result); return result.result === "UNSAFE" ? 2 : 0; }
  finally { await closeDatabasePool(pool); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
