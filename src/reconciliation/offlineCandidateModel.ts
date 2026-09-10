import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const OFFLINE_CANDIDATE_MODEL_VERSION = "active-listings-offline-candidate-v2" as const;
export const OFFLINE_AUTHORITY_STATEMENT = "THIS OFFLINE MODEL DOES NOT AUTHORIZE DEACTIVATION." as const;

export type GenerationState = "OPEN" | "TRANSPORT_COMPLETE" | "CATCHING_UP" | "VERIFIED" | "ABORTED";
export type TransportResult = "COMPLETE" | "PARTIAL" | "FAILED" | "UNSAFE";
export type CandidateClassification = "PRESENT" | "ABSENT_CANDIDATE" | "BLOCKED";

export const OFFLINE_REASON_CODES = [
  "SNAPSHOT_NOT_COMPLETE",
  "SNAPSHOT_SEMANTICALLY_UNSAFE",
  "ORDER_NOT_ACTIVE",
  "NEEDS_RECONCILIATION",
  "ORDER_CREATED_OR_UPDATED_AFTER_BASELINE",
  "NEWER_EVENT_AFTER_BASELINE",
  "PENDING_EVENT",
  "PROCESSING_EVENT",
  "FAILED_EVENT",
  "UNRESOLVED_EVENT",
  "EVENT_ORDERING_AMBIGUOUS",
  "TERMINAL_EVENT_PRESENT",
  "REVALIDATE_UNVERIFIED",
  "UNKNOWN_EVENT_TYPE",
  "UNKNOWN_PROCESSING_STATUS",
  "IDENTITY_AMBIGUOUS"
  ,"INVALID_LOCAL_IDENTITY"
] as const;

export type OfflineReasonCode = (typeof OFFLINE_REASON_CODES)[number];

export const OFFLINE_EVENT_TYPES = ["item_listed", "item_cancelled", "item_sold", "item_transferred", "order_invalidate", "order_revalidate"] as const;
export type OfflineEventType = (typeof OFFLINE_EVENT_TYPES)[number];
export const OFFLINE_PROCESSING_STATUSES = ["pending", "processing", "applied", "reconciliation_required", "failed", "ignored_duplicate", "ignored_older"] as const;
export type OfflineProcessingStatus = (typeof OFFLINE_PROCESSING_STATUSES)[number];
const OFFLINE_EVENT_TYPE_SET = new Set<string>(OFFLINE_EVENT_TYPES);
const OFFLINE_PROCESSING_STATUS_SET = new Set<string>(OFFLINE_PROCESSING_STATUSES);

export function isSupportedOfflineEventType(value: unknown): value is OfflineEventType {
  return typeof value === "string" && OFFLINE_EVENT_TYPE_SET.has(value);
}

export function isSupportedOfflineProcessingStatus(value: unknown): value is OfflineProcessingStatus {
  return typeof value === "string" && OFFLINE_PROCESSING_STATUS_SET.has(value);
}

export interface OfflineSweepManifest {
  sweepId: string;
  generationState: GenerationState;
  transportResult: TransportResult;
  snapshotStartedAt: string;
  snapshotCompletedAt: string;
  paginationExhausted: boolean;
  nextCursor: string | null;
  truncatedByPageLimit: boolean;
  truncatedByListingLimit: boolean;
  malformedCount: number;
  unsupportedCount: number;
  conflictCount: number;
  cursorCycleDetected: boolean;
  repeatedPageDetected: boolean;
  sourceProvenance: Record<string, string>;
}

export interface SeenOrder {
  sweepId: string;
  orderHash: string;
  pageNumber: number;
  rawPageHash: string;
  normalizedMaterialHash: string;
}

export type OfflineJournalProcessingStatus = "pending" | "processing" | "applied" | "reconciliation_required" | "failed" | "ignored_duplicate" | "ignored_older";

export interface OfflineLocalOrder {
  orderHash: string;
  status: string;
  isActive: boolean;
  needsReconciliation: boolean;
  lastOrderEventTimestamp: string | null;
  lastOrderEventVersion: string | null;
  lastReconciledAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  identity: OfflineCandidateIdentity;
}

export interface OfflineCandidateIdentity {
  readonly orderHash: string;
  readonly chain: "gunzilla";
  readonly contractAddress: string;
  readonly tokenId: string;
  readonly collectionSlug: "off-the-grid";
  readonly protocolAddress: string;
}

export interface OfflineJournalEvent {
  eventId: string;
  orderHash: string | null;
  eventType: string;
  eventTimestamp: string | null;
  eventVersion: string | null;
  receivedAt: string;
  processingStatus: OfflineJournalProcessingStatus;
  applyResult?: string | null;
  ambiguous?: boolean;
  reconciliationRequired?: boolean;
}

export interface ManifestValidation {
  readonly eligible: boolean;
  readonly reasons: readonly OfflineReasonCode[];
}

export interface OfflineOrderExplanation {
  readonly orderHash: string;
  readonly classification: CandidateClassification;
  readonly reasons: readonly OfflineReasonCode[];
  readonly seenInSweep: boolean;
  readonly relevantJournalEventIds: readonly string[];
  readonly relevantEventSummary: ReadonlyArray<{
    readonly eventId: string;
    readonly eventType: string;
    readonly eventTimestamp: string | null;
    readonly eventVersion: string | null;
    readonly receivedAt: string;
    readonly processingStatus: OfflineJournalProcessingStatus;
  }>;
  readonly authorityGranted: false;
  readonly identity: OfflineCandidateIdentity;
}

export interface OfflineCandidateBundle {
  readonly modelVersion: typeof OFFLINE_CANDIDATE_MODEL_VERSION;
  readonly authorityStatement: typeof OFFLINE_AUTHORITY_STATEMENT;
  readonly authorityGranted: false;
  readonly sweepId: string;
  readonly sourceEvidencePath?: string;
  readonly sourceProvenance: Readonly<Record<string, string>>;
  readonly snapshotStartedAt: string;
  readonly snapshotCompletedAt: string;
  readonly manifestValidation: ManifestValidation;
  readonly counts: Readonly<{ present: number; absentCandidate: number; blocked: number; total: number }>;
  readonly orders: readonly OfflineOrderExplanation[];
}

export interface ImportedCompleteEvidence {
  sourceEvidencePath: string;
  manifest: OfflineSweepManifest;
  seenOrders: SeenOrder[];
}

export interface OfflineCandidateValidationResult {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function orderKey(value: string): string {
  return value.trim().toLowerCase();
}

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function sortedReasons(reasons: Iterable<OfflineReasonCode>): OfflineReasonCode[] {
  return [...new Set(reasons)].sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const object = value as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    const child = object[key];
    if (child !== null && (typeof child === "object" || typeof child === "function") && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function requireNonNegativeInteger(value: unknown, name: string): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && name.length > 0;
}

const ORDER_HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const TOKEN_ID = /^(0|[1-9][0-9]*)$/;
export function validateOfflineCandidateIdentity(value: unknown): value is OfflineCandidateIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.orderHash === "string" && ORDER_HASH.test(row.orderHash)
    && row.chain === "gunzilla" && typeof row.contractAddress === "string" && ADDRESS.test(row.contractAddress)
    && typeof row.tokenId === "string" && TOKEN_ID.test(row.tokenId)
    && row.collectionSlug === "off-the-grid" && typeof row.protocolAddress === "string" && ADDRESS.test(row.protocolAddress);
}

function identityKey(identity: OfflineCandidateIdentity): string {
  return `${identity.orderHash}\u0000${identity.chain}\u0000${identity.contractAddress}\u0000${identity.tokenId}\u0000${identity.collectionSlug}\u0000${identity.protocolAddress}`;
}

export function validateOfflineSweepManifest(manifest: OfflineSweepManifest): ManifestValidation {
  const reasons: OfflineReasonCode[] = [];
  const complete = manifest.transportResult === "COMPLETE"
    && manifest.generationState === "TRANSPORT_COMPLETE"
    && manifest.paginationExhausted
    && manifest.nextCursor === null
    && !manifest.truncatedByPageLimit
    && !manifest.truncatedByListingLimit
    && manifest.malformedCount === 0
    && manifest.unsupportedCount === 0
    && manifest.conflictCount === 0
    && !manifest.cursorCycleDetected
    && !manifest.repeatedPageDetected;
  if (!complete) reasons.push("SNAPSHOT_NOT_COMPLETE");
  if (manifest.malformedCount !== 0 || manifest.unsupportedCount !== 0 || manifest.conflictCount !== 0 || manifest.cursorCycleDetected || manifest.repeatedPageDetected) reasons.push("SNAPSHOT_SEMANTICALLY_UNSAFE");
  if (!text(manifest.sweepId) || !validIso(manifest.snapshotStartedAt) || !validIso(manifest.snapshotCompletedAt) || Date.parse(manifest.snapshotCompletedAt) < Date.parse(manifest.snapshotStartedAt)) reasons.push("SNAPSHOT_NOT_COMPLETE");
  if (!manifest.sourceProvenance || Object.keys(manifest.sourceProvenance).length === 0) reasons.push("SNAPSHOT_NOT_COMPLETE");
  if (![manifest.malformedCount, manifest.unsupportedCount, manifest.conflictCount].every((value) => requireNonNegativeInteger(value, "counter"))) reasons.push("SNAPSHOT_SEMANTICALLY_UNSAFE");
  return { eligible: reasons.length === 0, reasons: sortedReasons(reasons) };
}

function compareVersions(left: string | null, right: string | null): number | null {
  if (left === null || right === null || !/^[0-9]+$/.test(left) || !/^[0-9]+$/.test(right)) return null;
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function eventIsNewerThanOrder(event: OfflineJournalEvent, order: OfflineLocalOrder): boolean | null {
  if (!event.eventTimestamp || !validIso(event.eventTimestamp) || !order.lastOrderEventTimestamp || !validIso(order.lastOrderEventTimestamp)) return null;
  const eventTime = Date.parse(event.eventTimestamp);
  const orderTime = Date.parse(order.lastOrderEventTimestamp);
  if (eventTime !== orderTime) return eventTime > orderTime;
  const version = compareVersions(event.eventVersion, order.lastOrderEventVersion);
  return version === null ? null : version > 0;
}

function journalReasons(order: OfflineLocalOrder, events: OfflineJournalEvent[], baseline: string): OfflineReasonCode[] {
  const reasons: OfflineReasonCode[] = [];
  if (order.createdAt && validIso(order.createdAt) && Date.parse(order.createdAt) > Date.parse(baseline)) reasons.push("ORDER_CREATED_OR_UPDATED_AFTER_BASELINE");
  if (order.updatedAt && validIso(order.updatedAt) && Date.parse(order.updatedAt) > Date.parse(baseline)) reasons.push("ORDER_CREATED_OR_UPDATED_AFTER_BASELINE");
  for (const event of events) {
    if (!isSupportedOfflineEventType(event.eventType)) reasons.push("UNKNOWN_EVENT_TYPE");
    if (!isSupportedOfflineProcessingStatus(event.processingStatus)) reasons.push("UNKNOWN_PROCESSING_STATUS");
    if (event.processingStatus === "pending") reasons.push("PENDING_EVENT");
    if (event.processingStatus === "processing") reasons.push("PROCESSING_EVENT");
    if (event.processingStatus === "failed") reasons.push("FAILED_EVENT");
    if (event.processingStatus === "reconciliation_required" || event.reconciliationRequired || event.applyResult?.includes("reconciliation")) reasons.push("UNRESOLVED_EVENT");
    if (event.ambiguous) reasons.push("EVENT_ORDERING_AMBIGUOUS");
    if (event.receivedAt && validIso(event.receivedAt) && Date.parse(event.receivedAt) > Date.parse(baseline)) reasons.push("NEWER_EVENT_AFTER_BASELINE");
    if (event.eventType === "order_revalidate") reasons.push("REVALIDATE_UNVERIFIED");
    const newer = eventIsNewerThanOrder(event, order);
    if (newer === null && (event.eventTimestamp !== null || event.eventVersion !== null)) reasons.push("EVENT_ORDERING_AMBIGUOUS");
    if (newer === true && ["item_sold", "item_cancelled", "order_invalidate"].includes(event.eventType)) reasons.push("TERMINAL_EVENT_PRESENT");
  }
  return reasons;
}

export function classifyOfflineCandidates(input: {
  manifest: OfflineSweepManifest;
  seenOrders: readonly SeenOrder[];
  localOrders: readonly OfflineLocalOrder[];
  journalEvents: readonly OfflineJournalEvent[];
  sourceEvidencePath?: string;
}): OfflineCandidateBundle {
  const validation = validateOfflineSweepManifest(input.manifest);
  const seen = new Map<string, SeenOrder>();
  const identityAmbiguity = new Set<string>();
  for (const item of input.seenOrders) {
    const key = text(item.orderHash) ? orderKey(item.orderHash) : "";
    if (!key || seen.has(key)) identityAmbiguity.add(key || "<missing>");
    else seen.set(key, item);
  }
  const localKeys = new Set<string>();
  const localKeyCounts = new Map<string, number>();
  const identityKeys = new Map<string, Set<string>>();
  for (const order of input.localOrders) {
    const key = text(order.orderHash) ? orderKey(order.orderHash) : "";
    localKeyCounts.set(key, (localKeyCounts.get(key) ?? 0) + 1);
    if (validateOfflineCandidateIdentity(order.identity)) { const set = identityKeys.get(key) ?? new Set<string>(); set.add(identityKey(order.identity)); identityKeys.set(key, set); }
  }
  const output: OfflineOrderExplanation[] = [];
  for (const order of input.localOrders) {
    const key = text(order.orderHash) ? orderKey(order.orderHash) : "";
    const events = input.journalEvents.filter((event) => event.orderHash !== null && orderKey(event.orderHash) === key).sort((a, b) => a.eventId.localeCompare(b.eventId));
    const reasons: OfflineReasonCode[] = [];
    if (!key || (localKeyCounts.get(key) ?? 0) > 1 || localKeys.has(key) || identityAmbiguity.has(key)) reasons.push("IDENTITY_AMBIGUOUS");
    if (!validateOfflineCandidateIdentity(order.identity)) reasons.push("INVALID_LOCAL_IDENTITY");
    if ((identityKeys.get(key)?.size ?? 0) > 1) reasons.push("IDENTITY_AMBIGUOUS");
    localKeys.add(key);
    if (!validation.eligible) reasons.push(...validation.reasons);
    if (order.status !== "active" || !order.isActive) reasons.push("ORDER_NOT_ACTIVE");
    if (order.needsReconciliation) reasons.push("NEEDS_RECONCILIATION");
    reasons.push(...journalReasons(order, events, input.manifest.snapshotStartedAt));
    const seenInSweep = Boolean(key && seen.has(key));
    let classification: CandidateClassification;
    if (reasons.length > 0) classification = "BLOCKED";
    else if (seenInSweep) classification = "PRESENT";
    else classification = "ABSENT_CANDIDATE";
    output.push({
      orderHash: key,
      classification,
      reasons: sortedReasons(reasons),
      seenInSweep,
      relevantJournalEventIds: events.map((event) => event.eventId).sort(),
      relevantEventSummary: events.map((event) => ({ eventId: event.eventId, eventType: event.eventType, eventTimestamp: event.eventTimestamp, eventVersion: event.eventVersion, receivedAt: event.receivedAt, processingStatus: event.processingStatus })),
      authorityGranted: false,
      identity: deepFreeze({ ...order.identity })
    });
  }
  output.sort((a, b) => a.orderHash.localeCompare(b.orderHash));
  return deepFreeze({
    modelVersion: OFFLINE_CANDIDATE_MODEL_VERSION,
    authorityStatement: OFFLINE_AUTHORITY_STATEMENT,
    authorityGranted: false,
    sweepId: input.manifest.sweepId,
    sourceEvidencePath: input.sourceEvidencePath,
    sourceProvenance: Object.fromEntries(Object.entries(input.manifest.sourceProvenance).sort(([a], [b]) => a.localeCompare(b))),
    snapshotStartedAt: input.manifest.snapshotStartedAt,
    snapshotCompletedAt: input.manifest.snapshotCompletedAt,
    manifestValidation: validation,
    counts: {
      present: output.filter((item) => item.classification === "PRESENT").length,
      absentCandidate: output.filter((item) => item.classification === "ABSENT_CANDIDATE").length,
      blocked: output.filter((item) => item.classification === "BLOCKED").length,
      total: output.length
    },
    orders: output
  });
}

/** Pure runtime validation of the complete canonical classifier result. */
export function validateOfflineCandidateBundle(value: unknown): OfflineCandidateValidationResult {
  const reasons: string[] = [];
  const knownReasons = new Set<string>(OFFLINE_REASON_CODES);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { valid: false, reasons: ["INVALID_CANDIDATE_BUNDLE"] };
  const bundle = value as Record<string, unknown>;
  if (!Object.isFrozen(bundle) || !Object.isFrozen(bundle.sourceProvenance) || !Object.isFrozen(bundle.manifestValidation) || !Object.isFrozen(bundle.counts) || !Object.isFrozen(bundle.orders)) reasons.push("INVALID_CANDIDATE_BUNDLE");
  if (bundle.modelVersion !== OFFLINE_CANDIDATE_MODEL_VERSION || bundle.authorityStatement !== OFFLINE_AUTHORITY_STATEMENT || bundle.authorityGranted !== false) reasons.push("INVALID_CANDIDATE_AUTHORITY");
  if (typeof bundle.sweepId !== "string" || bundle.sweepId.trim().length === 0 || typeof bundle.snapshotStartedAt !== "string" || !validIso(bundle.snapshotStartedAt) || typeof bundle.snapshotCompletedAt !== "string" || !validIso(bundle.snapshotCompletedAt) || Date.parse(bundle.snapshotCompletedAt) < Date.parse(bundle.snapshotStartedAt)) reasons.push("INVALID_CANDIDATE_BUNDLE");
  if (bundle.sourceEvidencePath !== undefined && typeof bundle.sourceEvidencePath !== "string") reasons.push("INVALID_CANDIDATE_BUNDLE");
  if (bundle.sourceProvenance === null || typeof bundle.sourceProvenance !== "object" || Array.isArray(bundle.sourceProvenance) || Object.keys(bundle.sourceProvenance as object).length === 0 || !Object.entries(bundle.sourceProvenance as Record<string, unknown>).every(([key, item]) => nonEmptyText(key) && nonEmptyText(item))) reasons.push("INVALID_CANDIDATE_BUNDLE");
  const manifest = bundle.manifestValidation;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) || !Object.isFrozen(manifest)) reasons.push("INVALID_CANDIDATE_BUNDLE");
  else {
    const validation = manifest as Record<string, unknown>;
    if (validation.eligible !== true || !Array.isArray(validation.reasons) || !Object.isFrozen(validation.reasons) || validation.reasons.length !== 0 || !validation.reasons.every((reason) => typeof reason === "string" && knownReasons.has(reason))) reasons.push("INVALID_CANDIDATE_BUNDLE");
  }
  const counts = bundle.counts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts) || !Object.isFrozen(counts)) reasons.push("INVALID_CANDIDATE_BUNDLE");
  const orders = bundle.orders;
  if (!Array.isArray(orders)) reasons.push("INVALID_CANDIDATE_BUNDLE");
  let present = 0; let absent = 0; let blocked = 0;
  const orderHashes = new Set<string>();
  if (Array.isArray(orders)) for (const item of orders) {
    if (item === null || typeof item !== "object" || Array.isArray(item) || !Object.isFrozen(item)) { reasons.push("INVALID_CANDIDATE_BUNDLE"); continue; }
    const order = item as Record<string, unknown>;
    const hash = order.orderHash;
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash) || hash !== hash.toLowerCase()) reasons.push("INVALID_CANDIDATE_IDENTITY");
    else if (orderHashes.has(hash)) reasons.push("IDENTITY_AMBIGUOUS"); else orderHashes.add(hash);
    if (order.authorityGranted !== false) reasons.push("INVALID_CANDIDATE_AUTHORITY");
    if (!Object.isFrozen(order.identity) || !validateOfflineCandidateIdentity(order.identity) || (order.identity as unknown as Record<string, unknown>).orderHash !== hash) reasons.push("INVALID_LOCAL_IDENTITY");
    if (order.classification !== "PRESENT" && order.classification !== "ABSENT_CANDIDATE" && order.classification !== "BLOCKED") reasons.push("INVALID_CANDIDATE_BUNDLE");
    else if (order.classification === "PRESENT") present += 1; else if (order.classification === "ABSENT_CANDIDATE") absent += 1; else blocked += 1;
    const orderReasons = order.reasons;
    if (!Array.isArray(orderReasons) || !Object.isFrozen(orderReasons) || !orderReasons.every((reason) => typeof reason === "string" && knownReasons.has(reason))) reasons.push("INVALID_CANDIDATE_BUNDLE");
    else {
      const canonicalReasons = [...new Set(orderReasons)].sort();
      if (canonicalReasons.length !== orderReasons.length || canonicalReasons.some((reason, index) => reason !== orderReasons[index])) reasons.push("INVALID_CANDIDATE_BUNDLE");
      if (order.classification === "PRESENT" && (orderReasons.length > 0 || order.seenInSweep !== true)) reasons.push("INVALID_CANDIDATE_BUNDLE");
      if (order.classification === "ABSENT_CANDIDATE" && (orderReasons.length > 0 || order.seenInSweep !== false)) reasons.push("INVALID_CANDIDATE_BUNDLE");
      if (order.classification === "BLOCKED" && orderReasons.length === 0) reasons.push("INVALID_CANDIDATE_BUNDLE");
    }
    if (typeof order.seenInSweep !== "boolean") reasons.push("INVALID_CANDIDATE_BUNDLE");
    const journalIds = order.relevantJournalEventIds;
    if (!Array.isArray(journalIds) || !Object.isFrozen(journalIds) || !journalIds.every((eventId) => nonEmptyText(eventId))) reasons.push("INVALID_CANDIDATE_BUNDLE");
    else if (new Set(journalIds).size !== journalIds.length || journalIds.some((eventId, index) => index > 0 && journalIds[index - 1].localeCompare(eventId) > 0)) reasons.push("INVALID_CANDIDATE_BUNDLE");
    const summaries = order.relevantEventSummary;
    if (!Array.isArray(summaries) || !Object.isFrozen(summaries)) reasons.push("INVALID_CANDIDATE_BUNDLE");
    else for (const item of summaries) {
      if (item === null || typeof item !== "object" || Array.isArray(item) || !Object.isFrozen(item)) { reasons.push("INVALID_CANDIDATE_BUNDLE"); continue; }
      const summary = item as Record<string, unknown>;
      if (!nonEmptyText(summary.eventId) || !isSupportedOfflineEventType(summary.eventType) || (summary.eventTimestamp !== null && (typeof summary.eventTimestamp !== "string" || !validIso(summary.eventTimestamp))) || (summary.eventVersion !== null && (typeof summary.eventVersion !== "string" || !nonEmptyText(summary.eventVersion))) || typeof summary.receivedAt !== "string" || !validIso(summary.receivedAt) || !isSupportedOfflineProcessingStatus(summary.processingStatus)) reasons.push("INVALID_CANDIDATE_BUNDLE");
    }
    if (Array.isArray(journalIds) && Array.isArray(summaries)) {
      const summaryIds = summaries.map((item) => item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).eventId : undefined);
      if (summaryIds.length !== journalIds.length || summaryIds.some((eventId, index) => eventId !== journalIds[index])) reasons.push("INVALID_CANDIDATE_BUNDLE");
    }
  }
  if (Array.isArray(orders)) for (let index = 1; index < orders.length; index += 1) {
    const previous = orders[index - 1]; const current = orders[index];
    if (previous !== null && typeof previous === "object" && !Array.isArray(previous) && current !== null && typeof current === "object" && !Array.isArray(current) && typeof (previous as Record<string, unknown>).orderHash === "string" && typeof (current as Record<string, unknown>).orderHash === "string" && ((previous as Record<string, unknown>).orderHash as string).localeCompare((current as Record<string, unknown>).orderHash as string) > 0) reasons.push("INVALID_CANDIDATE_BUNDLE");
  }
  if (counts && typeof counts === "object" && !Array.isArray(counts)) {
    const c = counts as Record<string, unknown>;
    if (![c.present, c.absentCandidate, c.blocked, c.total].every((item) => requireNonNegativeInteger(item, "count")) || c.present !== present || c.absentCandidate !== absent || c.blocked !== blocked || c.total !== present + absent + blocked) reasons.push("INVALID_CANDIDATE_BUNDLE");
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

function parseEvidence(value: unknown, sourceEvidencePath: string, sweepId: string): ImportedCompleteEvidence {
  if (value === null || typeof value !== "object") throw new Error("evidence_not_object");
  const root = value as Record<string, any>;
  const snapshot = root.snapshot as Record<string, any> | undefined;
  if (!snapshot || typeof snapshot !== "object") throw new Error("evidence_snapshot_missing");
  const manifest: OfflineSweepManifest = {
    sweepId,
    generationState: "TRANSPORT_COMPLETE",
    transportResult: snapshot.result,
    snapshotStartedAt: snapshot.startedAt,
    snapshotCompletedAt: snapshot.completedAt,
    paginationExhausted: snapshot.paginationExhausted,
    nextCursor: snapshot.nextCursor,
    truncatedByPageLimit: snapshot.truncatedByPageLimit,
    truncatedByListingLimit: snapshot.truncatedByListingLimit,
    malformedCount: snapshot.counters?.malformed,
    unsupportedCount: snapshot.counters?.unsupported,
    conflictCount: snapshot.counters?.conflicts,
    cursorCycleDetected: snapshot.cursorCycleDetected,
    repeatedPageDetected: snapshot.repeatedPageDetected,
    sourceProvenance: root.sourceProvenance ?? snapshot.sourceProvenance
  };
  const validation = validateOfflineSweepManifest(manifest);
  if (!validation.eligible) throw new Error(`evidence_not_complete:${validation.reasons.join(",")}`);
  if (!Array.isArray(snapshot.rawPages) || !Array.isArray(snapshot.listings) || !Array.isArray(snapshot.responseHashes)) throw new Error("evidence_payload_missing");
  const seenOrders: SeenOrder[] = [];
  let listingIndex = 0;
  for (let pageIndex = 0; pageIndex < snapshot.rawPages.length; pageIndex += 1) {
    const page = snapshot.rawPages[pageIndex];
    const pageListings = Array.isArray(page?.listings) ? page.listings : [];
    const pageHash = typeof snapshot.responseHashes[pageIndex] === "string" ? snapshot.responseHashes[pageIndex] : "";
    for (const raw of pageListings) {
      const normalized = snapshot.listings[listingIndex];
      const orderHash = text(raw?.order_hash ?? normalized?.orderHash);
      if (!orderHash || !pageHash || !normalized) throw new Error("evidence_order_identity_missing");
      const material = { ...normalized };
      delete material.rawListing;
      seenOrders.push({ sweepId, orderHash: orderKey(orderHash), pageNumber: pageIndex + 1, rawPageHash: pageHash, normalizedMaterialHash: sha256(canonicalJson(material)) });
      listingIndex += 1;
    }
  }
  if (listingIndex !== snapshot.listings.length || seenOrders.length !== snapshot.counters.normalized) throw new Error("evidence_listing_count_mismatch");
  return { sourceEvidencePath, manifest, seenOrders };
}

export function importActiveListingsEvidenceObject(value: unknown, options: { sourceEvidencePath: string; sweepId: string }): ImportedCompleteEvidence {
  return parseEvidence(value, options.sourceEvidencePath, options.sweepId);
}

export async function importActiveListingsEvidenceFile(path: string, options: { sweepId: string }): Promise<ImportedCompleteEvidence> {
  const sourceEvidencePath = path;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("evidence_read_or_json_failed");
  }
  return importActiveListingsEvidenceObject(parsed, { sourceEvidencePath, sweepId: options.sweepId });
}
