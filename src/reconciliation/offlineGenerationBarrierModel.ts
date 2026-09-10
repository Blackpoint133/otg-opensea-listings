export const OFFLINE_GENERATION_MODEL_VERSION = "active-listings-offline-generation-barrier-v1" as const;

export type OfflineGenerationState = "OPEN" | "TRANSPORT_COMPLETE" | "CATCHING_UP" | "VERIFIED" | "ABORTED";
export type OfflineTransportResult = "COMPLETE" | "PARTIAL" | "FAILED" | "UNSAFE";
export type OfflineCatchUpOutcome = "STABLE" | "NOT_STABLE" | "UNSAFE" | "BUDGET_EXHAUSTED";
export type OfflineFenceOutcome = "FENCE_ELIGIBLE" | "FENCE_BLOCKED";
export type OfflineCandidateClass = "PRESENT" | "ABSENT_CANDIDATE" | "BLOCKED";

export const OFFLINE_GENERATION_REASON_CODES = [
  "INVALID_SWEEP_ID",
  "INVALID_INITIAL_STATE",
  "INVALID_START_BARRIER",
  "INVALID_END_BARRIER",
  "INVALID_PROVENANCE",
  "SNAPSHOT_NOT_COMPLETE",
  "SNAPSHOT_SEMANTICALLY_UNSAFE",
  "COUNTER_INCONSISTENT",
  "WATERMARK_REGRESSION",
  "CATCH_UP_NOT_STABLE",
  "CATCH_UP_BUDGET_EXHAUSTED",
  "PENDING_EVENTS_AT_BARRIER",
  "PROCESSING_EVENTS_AT_BARRIER",
  "FAILED_EVENTS_AT_BARRIER",
  "RECONCILIATION_REQUIRED_AT_BARRIER",
  "UNKNOWN_EVENT_STATE_AT_BARRIER",
  "INVALID_CATCH_UP_ROUND",
  "UNKNOWN_TRANSPORT_RESULT",
  "UNKNOWN_GENERATION_STATE",
  "UNKNOWN_CANDIDATE_CLASSIFICATION",
  "INVALID_CANDIDATE_BUNDLE",
  "INVALID_CANDIDATE_IDENTITY",
  "INVALID_CANDIDATE_AUTHORITY",
  "CANDIDATE_SWEEP_MISMATCH",
  "DUPLICATE_CANDIDATE_IDENTITY",
  "FENCE_BLOCKED"
] as const;

export type OfflineGenerationReasonCode = (typeof OFFLINE_GENERATION_REASON_CODES)[number];

export interface OfflineLocalAdmissionWatermark {
  eventId: string;
  receivedAt: string;
}

export interface OfflineStartBarrier {
  sweepId: string;
  snapshotStartedAt: string;
  eventHighWaterBefore: OfflineLocalAdmissionWatermark;
}

export interface OfflineEndBarrier {
  snapshotCompletedAt: string;
  eventHighWaterAfter: OfflineLocalAdmissionWatermark;
}

export interface OfflineTransportAccounting {
  pageAttempts: number;
  pagesFetched: number;
  httpAttempts: number;
  retryAttempts: number;
  rawPagesCount: number;
  responseHashesCount: number;
  observedCount: number;
  normalizedCount: number;
  pageAttemptDetailsCount: number;
  successfulPageAttempts: number;
}

export interface OfflineGenerationTransportEvidence extends OfflineTransportAccounting {
  transportResult: OfflineTransportResult;
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
  warnings: readonly string[];
  errors: readonly string[];
  sourceProvenance: Readonly<Record<string, string>>;
}

export interface OfflineCatchUpRound {
  roundNumber: number;
  observedHighWater: OfflineLocalAdmissionWatermark;
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  reconciliationRequiredCount: number;
  unknownStatusCount: number;
}

export interface OfflineGenerationInput {
  sweepId: string;
  initialState?: OfflineGenerationState;
  snapshotStartedAt: string;
  snapshotCompletedAt: string;
  sourceProvenance: Readonly<Record<string, string>>;
  startBarrier: OfflineStartBarrier;
  endBarrier: OfflineEndBarrier;
  transport: OfflineGenerationTransportEvidence;
  catchUpRounds: readonly OfflineCatchUpRound[];
  maxCatchUpRounds: number;
  candidateBundle?: unknown;
}

export interface OfflineCatchUpResult {
  readonly outcome: OfflineCatchUpOutcome;
  readonly stable: boolean;
  readonly roundsEvaluated: number;
  readonly stableWatermark: OfflineLocalAdmissionWatermark | null;
  readonly rounds: readonly OfflineCatchUpRound[];
  readonly reasons: readonly OfflineGenerationReasonCode[];
}

export interface OfflineGenerationCandidateAdvance {
  readonly orderHash: string;
  readonly sourceClassification: OfflineCandidateClass;
  readonly targetedVerifierEligible: boolean;
  readonly authorityGranted: false;
  readonly reasons: readonly OfflineGenerationReasonCode[];
}

export interface OfflineGenerationResult {
  readonly modelVersion: typeof OFFLINE_GENERATION_MODEL_VERSION;
  readonly sweepId: string;
  readonly state: OfflineGenerationState;
  readonly stateHistory: readonly OfflineGenerationState[];
  readonly sourceProvenance: Readonly<Record<string, string>>;
  readonly snapshotStartedAt: string;
  readonly snapshotCompletedAt: string;
  readonly startBarrier: OfflineStartBarrier;
  readonly endBarrier: OfflineEndBarrier;
  readonly transportValidation: Readonly<{
    eligible: boolean;
    reasons: readonly OfflineGenerationReasonCode[];
    accounting: OfflineTransportAccounting;
  }>;
  readonly catchUp: OfflineCatchUpResult;
  readonly finalFence: Readonly<{
    outcome: OfflineFenceOutcome;
    eligible: boolean;
    reasons: readonly OfflineGenerationReasonCode[];
  }>;
  readonly candidateAdvancement: readonly OfflineGenerationCandidateAdvance[];
  readonly abortReasons: readonly OfflineGenerationReasonCode[];
  readonly deactivationAuthorityGranted: false;
}

export interface OfflineGenerationValidationResult {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

const TRANSPORT_RESULTS = new Set<string>(["COMPLETE", "PARTIAL", "FAILED", "UNSAFE"]);
const GENERATION_STATES = new Set<string>(["OPEN", "TRANSPORT_COMPLETE", "CATCHING_UP", "VERIFIED", "ABORTED"]);
const CANDIDATE_CLASSES = new Set<string>(["PRESENT", "ABSENT_CANDIDATE", "BLOCKED"]);
const CANDIDATE_MODEL_VERSION = "active-listings-offline-candidate-v1";
const CANDIDATE_AUTHORITY_STATEMENT = "THIS OFFLINE MODEL DOES NOT AUTHORIZE DEACTIVATION.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTransportResult(value: unknown): value is OfflineTransportResult {
  return typeof value === "string" && TRANSPORT_RESULTS.has(value);
}

function isGenerationState(value: unknown): value is OfflineGenerationState {
  return typeof value === "string" && GENERATION_STATES.has(value);
}

function isCandidateClass(value: unknown): value is OfflineCandidateClass {
  return typeof value === "string" && CANDIDATE_CLASSES.has(value);
}

function validOrderHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validIso(value: unknown): value is string {
  return nonEmptyText(value) && Number.isFinite(Date.parse(value));
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function decimalEventId(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function copyWatermark(value: OfflineLocalAdmissionWatermark): OfflineLocalAdmissionWatermark {
  return { eventId: value.eventId, receivedAt: value.receivedAt };
}

function compareWatermark(left: OfflineLocalAdmissionWatermark, right: OfflineLocalAdmissionWatermark): number {
  const leftId = BigInt(left.eventId);
  const rightId = BigInt(right.eventId);
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  const leftTime = Date.parse(left.receivedAt);
  const rightTime = Date.parse(right.receivedAt);
  return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
}

function sameWatermark(left: OfflineLocalAdmissionWatermark, right: OfflineLocalAdmissionWatermark): boolean {
  return left.eventId === right.eventId && Date.parse(left.receivedAt) === Date.parse(right.receivedAt);
}

function sortedReasons(reasons: Iterable<OfflineGenerationReasonCode>): OfflineGenerationReasonCode[] {
  return [...new Set(reasons)].sort();
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

function invalidWatermark(value: unknown): boolean {
  if (!isRecord(value) || !decimalEventId(value.eventId) || !validIso(value.receivedAt)) return true;
  return false;
}

function validateProvenance(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([key, hash]) => nonEmptyText(key) && nonEmptyText(hash));
}

function validateAccounting(transport: OfflineTransportAccounting): OfflineGenerationReasonCode[] {
  const reasons: OfflineGenerationReasonCode[] = [];
  const fields = [transport.pageAttempts, transport.pagesFetched, transport.httpAttempts, transport.retryAttempts, transport.rawPagesCount, transport.responseHashesCount, transport.observedCount, transport.normalizedCount, transport.pageAttemptDetailsCount, transport.successfulPageAttempts];
  if (!fields.every((value) => safeInteger(value))) reasons.push("COUNTER_INCONSISTENT");
  if (transport.pagesFetched !== transport.rawPagesCount || transport.pagesFetched !== transport.responseHashesCount) reasons.push("COUNTER_INCONSISTENT");
  if (transport.normalizedCount !== transport.observedCount) reasons.push("COUNTER_INCONSISTENT");
  if (transport.retryAttempts !== transport.httpAttempts - transport.pageAttempts) reasons.push("COUNTER_INCONSISTENT");
  if (transport.pageAttemptDetailsCount !== transport.pageAttempts || transport.successfulPageAttempts !== transport.pagesFetched) reasons.push("COUNTER_INCONSISTENT");
  if (transport.httpAttempts < transport.pageAttempts || transport.pagesFetched > transport.pageAttempts) reasons.push("COUNTER_INCONSISTENT");
  return reasons;
}

function validateTransport(transport: unknown, startedAt: string, completedAt: string): { eligible: boolean; reasons: OfflineGenerationReasonCode[]; accounting: OfflineTransportAccounting } {
  const fallback: OfflineTransportAccounting = { pageAttempts: 0, pagesFetched: 0, httpAttempts: 0, retryAttempts: 0, rawPagesCount: 0, responseHashesCount: 0, observedCount: 0, normalizedCount: 0, pageAttemptDetailsCount: 0, successfulPageAttempts: 0 };
  if (!isRecord(transport)) return { eligible: false, reasons: ["SNAPSHOT_NOT_COMPLETE"], accounting: fallback };
  const accounting = {
    pageAttempts: transport.pageAttempts,
    pagesFetched: transport.pagesFetched,
    httpAttempts: transport.httpAttempts,
    retryAttempts: transport.retryAttempts,
    rawPagesCount: transport.rawPagesCount,
    responseHashesCount: transport.responseHashesCount,
    observedCount: transport.observedCount,
    normalizedCount: transport.normalizedCount,
    pageAttemptDetailsCount: transport.pageAttemptDetailsCount,
    successfulPageAttempts: transport.successfulPageAttempts
  } as OfflineTransportAccounting;
  const reasons: OfflineGenerationReasonCode[] = [];
  if (!isTransportResult(transport.transportResult)) reasons.push(typeof transport.transportResult === "string" ? "SNAPSHOT_NOT_COMPLETE" : "UNKNOWN_TRANSPORT_RESULT");
  if (transport.transportResult !== "COMPLETE" || transport.paginationExhausted !== true || transport.nextCursor !== null || transport.truncatedByPageLimit !== false || transport.truncatedByListingLimit !== false) reasons.push("SNAPSHOT_NOT_COMPLETE");
  if (transport.malformedCount !== 0 || transport.unsupportedCount !== 0 || transport.conflictCount !== 0 || transport.cursorCycleDetected !== false || transport.repeatedPageDetected !== false || !Array.isArray(transport.warnings) || !Array.isArray(transport.errors) || transport.warnings.length > 0 || transport.errors.length > 0) reasons.push("SNAPSHOT_SEMANTICALLY_UNSAFE");
  if (!validIso(transport.snapshotStartedAt) || !validIso(transport.snapshotCompletedAt) || Date.parse(transport.snapshotCompletedAt) < Date.parse(transport.snapshotStartedAt) || transport.snapshotStartedAt !== startedAt || transport.snapshotCompletedAt !== completedAt || !validateProvenance(transport.sourceProvenance)) reasons.push("SNAPSHOT_NOT_COMPLETE");
  reasons.push(...validateAccounting(accounting));
  return { eligible: reasons.length === 0, reasons: sortedReasons(reasons), accounting };
}

function validateBarrier(value: unknown, sweepId: string, startedAt: string, completedAt: string, start: boolean): OfflineGenerationReasonCode[] {
  if (!isRecord(value)) return [start ? "INVALID_START_BARRIER" : "INVALID_END_BARRIER"];
  const reasons: OfflineGenerationReasonCode[] = [];
  if (start && value.sweepId !== sweepId) reasons.push("INVALID_START_BARRIER");
  if (start && value.snapshotStartedAt !== startedAt) reasons.push("INVALID_START_BARRIER");
  if (!start && value.snapshotCompletedAt !== completedAt) reasons.push("INVALID_END_BARRIER");
  const watermark = start ? value.eventHighWaterBefore : value.eventHighWaterAfter;
  if (invalidWatermark(watermark)) reasons.push(start ? "INVALID_START_BARRIER" : "INVALID_END_BARRIER");
  return reasons;
}

function validateRound(value: unknown): value is OfflineCatchUpRound {
  if (!isRecord(value) || !safeInteger(value.roundNumber, 1) || invalidWatermark(value.observedHighWater)) return false;
  return [value.pendingCount, value.processingCount, value.failedCount, value.reconciliationRequiredCount, value.unknownStatusCount].every((item) => safeInteger(item));
}

function canonicalReasonList(value: unknown, knownReasons: ReadonlySet<string>): value is readonly string[] {
  return Array.isArray(value) && Object.isFrozen(value) && value.every((reason) => typeof reason === "string" && knownReasons.has(reason)) && [...new Set(value)].length === value.length && value.every((reason, index) => index === 0 || value[index - 1].localeCompare(reason) <= 0);
}

function cleanRound(round: OfflineCatchUpRound): boolean {
  return round.pendingCount === 0 && round.processingCount === 0 && round.failedCount === 0 && round.reconciliationRequiredCount === 0 && round.unknownStatusCount === 0;
}

function recomputeCatchUpPrefix(rounds: readonly OfflineCatchUpRound[], evaluated: number, before: OfflineLocalAdmissionWatermark, after: OfflineLocalAdmissionWatermark): { reasons: OfflineGenerationReasonCode[]; stableWatermark: OfflineLocalAdmissionWatermark | null } {
  const reasons: OfflineGenerationReasonCode[] = [];
  let previous = before;
  let stableWatermark: OfflineLocalAdmissionWatermark | null = null;
  for (const round of rounds.slice(0, evaluated)) {
    if (compareWatermark(round.observedHighWater, previous) < 0) reasons.push("WATERMARK_REGRESSION");
    if (round.pendingCount > 0) reasons.push("PENDING_EVENTS_AT_BARRIER");
    if (round.processingCount > 0) reasons.push("PROCESSING_EVENTS_AT_BARRIER");
    if (round.failedCount > 0) reasons.push("FAILED_EVENTS_AT_BARRIER");
    if (round.reconciliationRequiredCount > 0) reasons.push("RECONCILIATION_REQUIRED_AT_BARRIER");
    if (round.unknownStatusCount > 0) reasons.push("UNKNOWN_EVENT_STATE_AT_BARRIER");
    if (sameWatermark(round.observedHighWater, previous) && cleanRound(round)) stableWatermark = copyWatermark(round.observedHighWater);
    previous = round.observedHighWater;
  }
  if (compareWatermark(after, before) < 0 || (evaluated > 0 && compareWatermark(previous, before) < 0)) reasons.push("WATERMARK_REGRESSION");
  return { reasons: sortedReasons(reasons), stableWatermark };
}

function copyRound(round: OfflineCatchUpRound): OfflineCatchUpRound {
  return { roundNumber: round.roundNumber, observedHighWater: copyWatermark(round.observedHighWater), pendingCount: round.pendingCount, processingCount: round.processingCount, failedCount: round.failedCount, reconciliationRequiredCount: round.reconciliationRequiredCount, unknownStatusCount: round.unknownStatusCount };
}

function evaluateCatchUp(rounds: readonly OfflineCatchUpRound[], before: OfflineLocalAdmissionWatermark, after: OfflineLocalAdmissionWatermark, budget: number): OfflineCatchUpResult {
  const reasons: OfflineGenerationReasonCode[] = [];
  let previous = before;
  let stableWatermark: OfflineLocalAdmissionWatermark | null = null;
  let roundsEvaluated = 0;
  for (const round of rounds.slice(0, budget)) {
    roundsEvaluated += 1;
    if (compareWatermark(round.observedHighWater, previous) < 0) reasons.push("WATERMARK_REGRESSION");
    if (round.pendingCount > 0) reasons.push("PENDING_EVENTS_AT_BARRIER");
    if (round.processingCount > 0) reasons.push("PROCESSING_EVENTS_AT_BARRIER");
    if (round.failedCount > 0) reasons.push("FAILED_EVENTS_AT_BARRIER");
    if (round.reconciliationRequiredCount > 0) reasons.push("RECONCILIATION_REQUIRED_AT_BARRIER");
    if (round.unknownStatusCount > 0) reasons.push("UNKNOWN_EVENT_STATE_AT_BARRIER");
    if (roundsEvaluated > 1 && sameWatermark(round.observedHighWater, previous) && round.pendingCount === 0 && round.processingCount === 0 && round.failedCount === 0 && round.reconciliationRequiredCount === 0 && round.unknownStatusCount === 0) stableWatermark = copyWatermark(round.observedHighWater);
    previous = round.observedHighWater;
  }
  if (compareWatermark(after, before) < 0 || (roundsEvaluated > 0 && compareWatermark(previous, before) < 0)) reasons.push("WATERMARK_REGRESSION");
  if (reasons.length > 0) return { outcome: "UNSAFE", stable: false, roundsEvaluated, stableWatermark: null, rounds: rounds.map(copyRound), reasons: sortedReasons(reasons) };
  if (stableWatermark) return { outcome: "STABLE", stable: true, roundsEvaluated, stableWatermark, rounds: rounds.map(copyRound), reasons: [] };
  if (rounds.length >= budget) return { outcome: "BUDGET_EXHAUSTED", stable: false, roundsEvaluated, stableWatermark: null, rounds: rounds.slice(0, budget).map(copyRound), reasons: ["CATCH_UP_BUDGET_EXHAUSTED"] };
  return { outcome: "NOT_STABLE", stable: false, roundsEvaluated, stableWatermark: null, rounds: rounds.map(copyRound), reasons: ["CATCH_UP_NOT_STABLE"] };
}

interface ValidatedCandidateEntry {
  orderHash: string;
  sourceClassification: OfflineCandidateClass;
  invalidReasons: OfflineGenerationReasonCode[];
}

interface CandidateHandoffValidation {
  valid: boolean;
  globalReasons: OfflineGenerationReasonCode[];
  entries: ValidatedCandidateEntry[];
}

function candidateBundleFrozen(value: Record<string, unknown>): boolean {
  if (!Object.isFrozen(value) || !Object.isFrozen(value.orders) || !Object.isFrozen(value.sourceProvenance) || !Object.isFrozen(value.manifestValidation)) return false;
  const validation = value.manifestValidation;
  if (!isRecord(validation) || !Object.isFrozen(validation.reasons)) return false;
  if (!Array.isArray(value.orders)) return false;
  return value.orders.every((order) => {
    if (!isRecord(order) || !Object.isFrozen(order) || !Array.isArray(order.reasons) || !Array.isArray(order.relevantJournalEventIds) || !Array.isArray(order.relevantEventSummary) || !Object.isFrozen(order.reasons) || !Object.isFrozen(order.relevantJournalEventIds) || !Object.isFrozen(order.relevantEventSummary)) return false;
    if (!order.reasons.every((reason) => typeof reason === "string") || !order.relevantJournalEventIds.every((eventId) => nonEmptyText(eventId))) return false;
    return order.relevantEventSummary.every((summary) => isRecord(summary) && Object.isFrozen(summary) && nonEmptyText(summary.eventId) && (summary.eventType === null || nonEmptyText(summary.eventType)) && (summary.eventTimestamp === null || validIso(summary.eventTimestamp)) && (summary.eventVersion === null || nonEmptyText(summary.eventVersion)) && validIso(summary.receivedAt) && nonEmptyText(summary.processingStatus));
  });
}

function validateCandidateBundle(value: unknown, sweepId: string): CandidateHandoffValidation {
  const globalReasons: OfflineGenerationReasonCode[] = [];
  if (!isRecord(value)) return { valid: false, globalReasons: ["INVALID_CANDIDATE_BUNDLE"], entries: [] };
  if (!candidateBundleFrozen(value)) globalReasons.push("INVALID_CANDIDATE_BUNDLE");
  if (value.modelVersion !== CANDIDATE_MODEL_VERSION || value.authorityStatement !== CANDIDATE_AUTHORITY_STATEMENT) globalReasons.push("INVALID_CANDIDATE_BUNDLE");
  if (value.authorityGranted !== false) globalReasons.push("INVALID_CANDIDATE_AUTHORITY");
  if (value.sweepId !== sweepId) globalReasons.push("CANDIDATE_SWEEP_MISMATCH");
  if (!validateProvenance(value.sourceProvenance)) globalReasons.push("INVALID_CANDIDATE_BUNDLE");
  const validation = value.manifestValidation;
  if (!isRecord(validation) || validation.eligible !== true || !Array.isArray(validation.reasons) || validation.reasons.length !== 0) globalReasons.push("INVALID_CANDIDATE_BUNDLE");
  if (isRecord(validation) && Array.isArray(validation.reasons) && !validation.reasons.every((reason) => typeof reason === "string")) globalReasons.push("INVALID_CANDIDATE_BUNDLE");
  if (!Array.isArray(value.orders)) return { valid: false, globalReasons: sortedReasons(globalReasons.concat("INVALID_CANDIDATE_BUNDLE")), entries: [] };
  const entries: ValidatedCandidateEntry[] = value.orders.map((item): ValidatedCandidateEntry => {
    const invalidReasons: OfflineGenerationReasonCode[] = [];
    if (!isRecord(item)) return { orderHash: "<invalid>", sourceClassification: "BLOCKED", invalidReasons: ["INVALID_CANDIDATE_BUNDLE"] };
    if (!validOrderHash(item.orderHash)) invalidReasons.push("INVALID_CANDIDATE_IDENTITY");
    if (!isCandidateClass(item.classification)) invalidReasons.push("UNKNOWN_CANDIDATE_CLASSIFICATION");
    if (item.authorityGranted !== false) invalidReasons.push("INVALID_CANDIDATE_AUTHORITY");
    const sourceClassification = isCandidateClass(item.classification) ? item.classification : "BLOCKED";
    return { orderHash: validOrderHash(item.orderHash) ? item.orderHash.toLowerCase() : "<invalid>", sourceClassification, invalidReasons };
  });
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.orderHash !== "<invalid>") counts.set(entry.orderHash, (counts.get(entry.orderHash) ?? 0) + 1);
  for (const entry of entries) if (entry.orderHash !== "<invalid>" && (counts.get(entry.orderHash) ?? 0) > 1) entry.invalidReasons.push("DUPLICATE_CANDIDATE_IDENTITY");
  return { valid: globalReasons.length === 0, globalReasons: sortedReasons(globalReasons), entries };
}

function candidateAdvancement(value: unknown, fenceEligible: boolean, sweepId: string): OfflineGenerationCandidateAdvance[] {
  const validation = validateCandidateBundle(value, sweepId);
  return validation.entries.map((entry): OfflineGenerationCandidateAdvance => {
    const reasons: OfflineGenerationReasonCode[] = [...validation.globalReasons, ...entry.invalidReasons];
    if (!fenceEligible) reasons.push("FENCE_BLOCKED");
    return {
      orderHash: entry.orderHash,
      sourceClassification: entry.sourceClassification,
      targetedVerifierEligible: validation.valid && fenceEligible && entry.invalidReasons.length === 0 && entry.sourceClassification === "ABSENT_CANDIDATE",
      authorityGranted: false as const,
      reasons: sortedReasons(reasons),
    };
  }).sort((a, b) => a.orderHash.localeCompare(b.orderHash) || a.sourceClassification.localeCompare(b.sourceClassification) || a.reasons.join(",").localeCompare(b.reasons.join(",")));
}

export function evaluateOfflineGeneration(input: unknown): OfflineGenerationResult {
  const value = isRecord(input) ? input : {};
  const sweepId = nonEmptyText(value.sweepId) ? value.sweepId.trim() : "<invalid>";
  const startedAt = typeof value.snapshotStartedAt === "string" ? value.snapshotStartedAt : "";
  const completedAt = typeof value.snapshotCompletedAt === "string" ? value.snapshotCompletedAt : "";
  const sourceProvenance = validateProvenance(value.sourceProvenance) ? Object.fromEntries(Object.entries(value.sourceProvenance as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))) : {};
  const startBarrier = isRecord(value.startBarrier) && !invalidWatermark(value.startBarrier.eventHighWaterBefore) ? { sweepId: String(value.startBarrier.sweepId ?? ""), snapshotStartedAt: String(value.startBarrier.snapshotStartedAt ?? ""), eventHighWaterBefore: copyWatermark(value.startBarrier.eventHighWaterBefore as OfflineLocalAdmissionWatermark) } : { sweepId: "", snapshotStartedAt: "", eventHighWaterBefore: { eventId: "0", receivedAt: "1970-01-01T00:00:00.000Z" } };
  const endBarrier = isRecord(value.endBarrier) && !invalidWatermark(value.endBarrier.eventHighWaterAfter) ? { snapshotCompletedAt: String(value.endBarrier.snapshotCompletedAt ?? ""), eventHighWaterAfter: copyWatermark(value.endBarrier.eventHighWaterAfter as OfflineLocalAdmissionWatermark) } : { snapshotCompletedAt: "", eventHighWaterAfter: { eventId: "0", receivedAt: "1970-01-01T00:00:00.000Z" } };
  const abortReasons: OfflineGenerationReasonCode[] = [];
  if (sweepId === "<invalid>") abortReasons.push("INVALID_SWEEP_ID");
  if (!validateProvenance(value.sourceProvenance)) abortReasons.push("INVALID_PROVENANCE");
  if (value.initialState !== undefined && value.initialState !== "OPEN") abortReasons.push(isGenerationState(value.initialState) ? "INVALID_INITIAL_STATE" : "UNKNOWN_GENERATION_STATE");
  if (!validIso(startedAt) || !validIso(completedAt) || Date.parse(completedAt) < Date.parse(startedAt)) abortReasons.push("INVALID_START_BARRIER");
  abortReasons.push(...validateBarrier(startBarrier, sweepId, startedAt, completedAt, true), ...validateBarrier(endBarrier, sweepId, startedAt, completedAt, false));
  if (!isRecord(value.transport) || !isTransportResult(value.transport.transportResult)) abortReasons.push("UNKNOWN_TRANSPORT_RESULT");
  const transportValidation = validateTransport(value.transport, startedAt, completedAt);
  abortReasons.push(...transportValidation.reasons);
  if (compareWatermark(endBarrier.eventHighWaterAfter, startBarrier.eventHighWaterBefore) < 0) abortReasons.push("WATERMARK_REGRESSION");
  const maxCatchUpRounds = value.maxCatchUpRounds;
  if (!safeInteger(maxCatchUpRounds, 2)) abortReasons.push("CATCH_UP_BUDGET_EXHAUSTED");
  const rawRounds = Array.isArray(value.catchUpRounds) ? value.catchUpRounds : [];
  if (rawRounds.some((round) => !validateRound(round))) abortReasons.push("INVALID_CATCH_UP_ROUND");
  const rounds = rawRounds.filter(validateRound).map(copyRound);
  const catchUp = evaluateCatchUp(rounds, startBarrier.eventHighWaterBefore, endBarrier.eventHighWaterAfter, safeInteger(maxCatchUpRounds, 2) ? maxCatchUpRounds : 2);
  abortReasons.push(...catchUp.reasons.filter((reason) => reason !== "CATCH_UP_NOT_STABLE"));
  let state: OfflineGenerationState = "OPEN";
  const stateHistory: OfflineGenerationState[] = ["OPEN"];
  if (abortReasons.length === 0) {
    state = "TRANSPORT_COMPLETE";
    stateHistory.push("TRANSPORT_COMPLETE", "CATCHING_UP");
    if (catchUp.stable) { state = "VERIFIED"; stateHistory.push("VERIFIED"); }
    else { state = "ABORTED"; stateHistory.push("ABORTED"); abortReasons.push(...catchUp.reasons); }
  } else { state = "ABORTED"; stateHistory.push("ABORTED"); }
  const sortedAbortReasons = sortedReasons(abortReasons);
  const fenceEligible = state === "VERIFIED" && transportValidation.eligible && catchUp.stable && sortedAbortReasons.length === 0;
  const fenceReasons = fenceEligible ? [] : ["FENCE_BLOCKED" as const];
  const result = {
    modelVersion: OFFLINE_GENERATION_MODEL_VERSION,
    sweepId,
    state,
    stateHistory,
    sourceProvenance,
    snapshotStartedAt: startedAt,
    snapshotCompletedAt: completedAt,
    startBarrier,
    endBarrier,
    transportValidation: { eligible: transportValidation.eligible, reasons: transportValidation.reasons, accounting: transportValidation.accounting },
    catchUp,
    finalFence: { outcome: fenceEligible ? "FENCE_ELIGIBLE" : "FENCE_BLOCKED", eligible: fenceEligible, reasons: fenceReasons },
    candidateAdvancement: candidateAdvancement(value.candidateBundle, fenceEligible, sweepId),
    abortReasons: sortedAbortReasons,
    deactivationAuthorityGranted: false
  } satisfies OfflineGenerationResult;
  return deepFreeze(result);
}

/** Pure runtime validation of the complete canonical evaluator result. */
export function validateOfflineGenerationResult(value: unknown): OfflineGenerationValidationResult {
  const reasons: OfflineGenerationReasonCode[] = [];
  const knownReasons = new Set<string>(OFFLINE_GENERATION_REASON_CODES);
  if (!isRecord(value) || !Object.isFrozen(value)) return { valid: false, reasons: ["INVALID_GENERATION_RESULT"] };
  const result = value;
  const frozen = (item: unknown): boolean => item !== null && typeof item === "object" && Object.isFrozen(item);
  if (result.modelVersion !== OFFLINE_GENERATION_MODEL_VERSION || !nonEmptyText(result.sweepId) || !isGenerationState(result.state) || result.deactivationAuthorityGranted !== false) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  if (!validIso(result.snapshotStartedAt) || !validIso(result.snapshotCompletedAt) || Date.parse(String(result.snapshotCompletedAt)) < Date.parse(String(result.snapshotStartedAt))) reasons.push("INVALID_START_BARRIER");
  if (!validateProvenance(result.sourceProvenance)) reasons.push("INVALID_PROVENANCE");
  if (!frozen(result.sourceProvenance) || !frozen(result.startBarrier) || !frozen(result.endBarrier) || !frozen(result.transportValidation) || !frozen(result.catchUp) || !frozen(result.finalFence) || !frozen(result.stateHistory) || !frozen(result.candidateAdvancement) || !frozen(result.abortReasons)) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  reasons.push(...validateBarrier(result.startBarrier, String(result.sweepId), String(result.snapshotStartedAt), String(result.snapshotCompletedAt), true));
  reasons.push(...validateBarrier(result.endBarrier, String(result.sweepId), String(result.snapshotStartedAt), String(result.snapshotCompletedAt), false));
  if (isRecord(result.startBarrier) && isRecord(result.endBarrier) && !invalidWatermark(result.startBarrier.eventHighWaterBefore) && !invalidWatermark(result.endBarrier.eventHighWaterAfter) && compareWatermark(result.endBarrier.eventHighWaterAfter as OfflineLocalAdmissionWatermark, result.startBarrier.eventHighWaterBefore as OfflineLocalAdmissionWatermark) < 0) reasons.push("WATERMARK_REGRESSION");
  const transport = result.transportValidation;
  if (!isRecord(transport) || typeof transport.eligible !== "boolean" || !Array.isArray(transport.reasons) || !Object.isFrozen(transport.reasons) || !transport.reasons.every((reason) => typeof reason === "string" && knownReasons.has(reason)) || !isRecord(transport.accounting)) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  else reasons.push(...validateAccounting(transport.accounting as unknown as OfflineTransportAccounting));
  const catchUp = result.catchUp;
  if (!isRecord(catchUp) || !["STABLE", "NOT_STABLE", "UNSAFE", "BUDGET_EXHAUSTED"].includes(String(catchUp.outcome)) || typeof catchUp.stable !== "boolean" || !safeInteger(catchUp.roundsEvaluated) || !Array.isArray(catchUp.rounds) || !Object.isFrozen(catchUp.rounds) || !Array.isArray(catchUp.reasons) || !Object.isFrozen(catchUp.reasons) || !catchUp.reasons.every((reason) => typeof reason === "string" && knownReasons.has(reason)) || (catchUp.stableWatermark !== null && invalidWatermark(catchUp.stableWatermark))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  else for (const round of catchUp.rounds) if (!validateRound(round) || !Object.isFrozen(round) || !frozen((round as OfflineCatchUpRound).observedHighWater)) reasons.push("INVALID_CATCH_UP_ROUND");
  if (isRecord(catchUp) && Array.isArray(catchUp.rounds) && Array.isArray(catchUp.reasons) && safeInteger(catchUp.roundsEvaluated) && catchUp.rounds.every((round) => validateRound(round) && Object.isFrozen(round) && frozen((round as OfflineCatchUpRound).observedHighWater)) && isRecord(result.startBarrier) && isRecord(result.endBarrier) && !invalidWatermark(result.startBarrier.eventHighWaterBefore) && !invalidWatermark(result.endBarrier.eventHighWaterAfter)) {
    const rounds = catchUp.rounds as OfflineCatchUpRound[];
    const evaluated = catchUp.roundsEvaluated;
    const requiresFullRoundList = catchUp.outcome === "NOT_STABLE" || catchUp.outcome === "BUDGET_EXHAUSTED";
    if (evaluated > rounds.length || (requiresFullRoundList && evaluated !== rounds.length) || (evaluated === 0 && rounds.length !== 0)) reasons.push("INVALID_CATCH_UP_ROUND");
    const recomputed = recomputeCatchUpPrefix(rounds, Math.min(evaluated, rounds.length), result.startBarrier.eventHighWaterBefore as OfflineLocalAdmissionWatermark, result.endBarrier.eventHighWaterAfter as OfflineLocalAdmissionWatermark);
    const actualReasons = catchUp.reasons as readonly string[];
    if (!canonicalReasonList(catchUp.reasons, knownReasons)) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
    if (catchUp.stable) {
      if (evaluated < 2 || catchUp.outcome !== "STABLE" || recomputed.reasons.length !== 0 || recomputed.stableWatermark === null || !isRecord(catchUp.stableWatermark) || invalidWatermark(catchUp.stableWatermark) || !Object.isFrozen(catchUp.stableWatermark) || !sameWatermark(catchUp.stableWatermark as unknown as OfflineLocalAdmissionWatermark, recomputed.stableWatermark) || actualReasons.length !== 0) reasons.push("INVALID_CATCH_UP_ROUND");
    } else {
      if (catchUp.stableWatermark !== null) reasons.push("INVALID_CATCH_UP_ROUND");
      if (recomputed.reasons.length > 0) {
        if (catchUp.outcome !== "UNSAFE" || actualReasons.join("\u0000") !== recomputed.reasons.join("\u0000")) reasons.push("INVALID_CATCH_UP_ROUND");
      } else if (catchUp.outcome === "UNSAFE" || catchUp.outcome === "STABLE" || (catchUp.outcome === "BUDGET_EXHAUSTED" && rounds.length === 0) || (catchUp.outcome !== "NOT_STABLE" && catchUp.outcome !== "BUDGET_EXHAUSTED")) reasons.push("INVALID_CATCH_UP_ROUND");
      else if (catchUp.outcome === "NOT_STABLE" && (actualReasons.length !== 1 || actualReasons[0] !== "CATCH_UP_NOT_STABLE")) reasons.push("INVALID_CATCH_UP_ROUND");
      else if (catchUp.outcome === "BUDGET_EXHAUSTED" && (actualReasons.length !== 1 || actualReasons[0] !== "CATCH_UP_BUDGET_EXHAUSTED")) reasons.push("INVALID_CATCH_UP_ROUND");
    }
  }
  const fence = result.finalFence;
  if (!isRecord(fence) || !["FENCE_ELIGIBLE", "FENCE_BLOCKED"].includes(String(fence.outcome)) || typeof fence.eligible !== "boolean" || !Array.isArray(fence.reasons) || !Object.isFrozen(fence.reasons) || !fence.reasons.every((reason) => typeof reason === "string" && knownReasons.has(reason))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  if (isRecord(fence) && ((fence.outcome === "FENCE_ELIGIBLE") !== (fence.eligible === true))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  if (!Array.isArray(result.abortReasons) || !Object.isFrozen(result.abortReasons) || !result.abortReasons.every((reason) => typeof reason === "string" && knownReasons.has(reason))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  const history = result.stateHistory;
  if (!Array.isArray(history) || !Object.isFrozen(history) || history.length < 2 || history[0] !== "OPEN" || history[history.length - 1] !== result.state || !history.every((state) => isGenerationState(state))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  else {
    const expected = result.state === "VERIFIED" ? ["OPEN", "TRANSPORT_COMPLETE", "CATCHING_UP", "VERIFIED"] : (history.length === 2 ? ["OPEN", "ABORTED"] : ["OPEN", "TRANSPORT_COMPLETE", "CATCHING_UP", "ABORTED"]);
    if (history.length !== expected.length || history.some((state, index) => state !== expected[index])) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  }
  if (!Array.isArray(result.candidateAdvancement) || !Object.isFrozen(result.candidateAdvancement)) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  else {
    const seen = new Set<string>();
    for (const item of result.candidateAdvancement) {
      if (!isRecord(item) || !Object.isFrozen(item) || !validOrderHash(item.orderHash) || item.orderHash !== String(item.orderHash).toLowerCase() || !isCandidateClass(item.sourceClassification) || typeof item.targetedVerifierEligible !== "boolean" || item.authorityGranted !== false || !Array.isArray(item.reasons) || !Object.isFrozen(item.reasons) || !item.reasons.every((reason) => typeof reason === "string" && knownReasons.has(reason)) || seen.has(String(item.orderHash))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
      else {
        seen.add(item.orderHash as string);
        const fenceEligible = isRecord(result.finalFence) && result.finalFence.outcome === "FENCE_ELIGIBLE" && result.finalFence.eligible === true;
        const hasReasons = (item.reasons as readonly unknown[]).length > 0;
        if (item.targetedVerifierEligible === true && (item.sourceClassification !== "ABSENT_CANDIDATE" || !fenceEligible || hasReasons)) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
        if (item.targetedVerifierEligible === false && item.sourceClassification === "ABSENT_CANDIDATE" && fenceEligible && !hasReasons) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
      }
    }
  }
  if (isRecord(result.transportValidation) && Array.isArray(result.transportValidation.reasons) && ((result.transportValidation.eligible === true) !== (result.transportValidation.reasons.length === 0))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  if (isRecord(fence) && Array.isArray(fence.reasons) && ((fence.eligible === true && fence.reasons.length !== 0) || (fence.eligible === false && (fence.reasons.length !== 1 || fence.reasons[0] !== "FENCE_BLOCKED")))) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  if (Array.isArray(result.abortReasons) && !canonicalReasonList(result.abortReasons, knownReasons)) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  if (Array.isArray(result.candidateAdvancement)) for (const item of result.candidateAdvancement) if (isRecord(item) && Array.isArray(item.reasons) && !canonicalReasonList(item.reasons, knownReasons)) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  if (result.state === "VERIFIED") {
    const transportValid = isRecord(result.transportValidation) && result.transportValidation.eligible === true && Array.isArray(result.transportValidation.reasons) && result.transportValidation.reasons.length === 0;
    const catchUpValid = isRecord(result.catchUp) && result.catchUp.stable === true && result.catchUp.outcome === "STABLE";
    const fenceValid = isRecord(result.finalFence) && result.finalFence.outcome === "FENCE_ELIGIBLE" && result.finalFence.eligible === true;
    const abortReasonsValid = Array.isArray(result.abortReasons) && result.abortReasons.length === 0;
    if (!transportValid || !catchUpValid || !fenceValid || !abortReasonsValid) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  } else if (result.state === "ABORTED") {
    if (!Array.isArray(result.abortReasons) || result.abortReasons.length === 0 || !isRecord(result.finalFence) || result.finalFence.outcome !== "FENCE_BLOCKED" || result.finalFence.eligible !== false) reasons.push("INVALID_GENERATION_RESULT" as OfflineGenerationReasonCode);
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}
