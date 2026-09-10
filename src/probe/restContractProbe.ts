import fs from "node:fs";
import path from "node:path";
import { extractInboxJournalEnvelope } from "../db/durableInboxRepository.js";
import { normalizeBusinessTimestamp, normalizeEventVersion, sha256, canonicalJson } from "../state/normalizers.js";
import { adaptRestEventToDurableIngress } from "../backfill/restEventAdapter.js";
import { RestEventsClient, RestEventsClientError, sanitizeBackfillError, validateRestBackfillPolicy, validateRestHttpRetryPolicy, type RestEventsClientDependencies } from "../backfill/restEventsClient.js";
import { OPENSEA_REST_COLLECTION_EVENTS_ENDPOINT, REST_BACKFILL_COLLECTION_SLUG, type RestBackfillRateLimit } from "../backfill/types.js";

export type ProbeResult = "REST_CONTRACT_PROBE_COMPLETE" | "REST_CONTRACT_PROBE_PARTIAL" | "REST_CONTRACT_PROBE_FAILED";
export type ProbeProfileName = "unfiltered" | "listing" | "sale" | "transfer" | "mint";

export interface RestContractProbeConfig {
  after: number;
  before: number;
  outputDir: string;
  pageLimit: number;
  maxPagesPerQuery: number;
  maxEventsPerQuery: number;
  maxTotalRequests: number;
  requestTimeoutMs: number;
  maxWindowSeconds: number;
  maxAttempts: number;
  allowedClockSkewSeconds: number;
  confirmLiveReadOnly: boolean;
  confirmNoDbWrite: boolean;
  confirmOpenseaRest: boolean;
}

export interface RestContractProbeDependencies extends RestEventsClientDependencies {
  nowSeconds?: () => number;
  nowIso?: () => string;
  env?: NodeJS.ProcessEnv;
  evidenceWriters?: EvidenceWriters;
}

export interface ProbeQueryProfile {
  name: ProbeProfileName;
  eventTypes: readonly string[];
}

export interface EvidenceWriters {
  rawPagesPath: string;
  analysisPath: string;
  appendRawPage(value: unknown): Promise<void>;
  appendAnalysis(value: unknown): Promise<void>;
  writeSummary(value: unknown): Promise<void>;
}

export interface RestContractProbeSummary {
  result: ProbeResult;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  collection: { slug: string; endpoint: string };
  window: { after: number; before: number };
  queryProfiles: ProbeQueryProfile[];
  requestsAttempted: number;
  requestsSucceeded: number;
  httpRetries: number;
  rateLimitedResponses: number;
  pagesFetched: number;
  eventsObserved: number;
  eventTypeDistribution: Record<string, number>;
  listingCount: number;
  saleCount: number;
  transferCount: number;
  mintCount: number;
  cancelObservedCount: number;
  offerExcludedCount: number;
  unknownCount: number;
  adapterSupported: number;
  adapterUnsupported: number;
  adapterMalformed: number;
  structuredDedupeCount: number;
  fallbackDedupeCount: number;
  listingVersionPresentCount: number;
  saleVersionPresentCount: number;
  listingOrderHashPresentCount: number;
  saleOrderHashPresentCount: number;
  transferTxHashPresentCount: number;
  unsafeParsedNumberCount: number;
  eventsWithUnsafeParsedNumbers: number;
  eventsWithIdentityCriticalUnsafeNumbers: number;
  unsafeParsedNumberPathsSample: string[];
  rawEvidenceFiles: string[];
  analysisEvidenceFiles: string[];
  truncatedProfiles: string[];
  sanitizedErrors: string[];
  databaseTouched: false;
  streamConnected: false;
  txAInvoked: false;
  txBInvoked: false;
  crossSourceAlgorithmReady: boolean;
  crossSourceEquivalenceProven: false;
  restInvalidationCoverageProbed: false;
  restRevalidationCoverageProbed: false;
}

export const DEFAULT_REST_CONTRACT_PROBE_CONFIG: Omit<RestContractProbeConfig, "after" | "before" | "outputDir" | "confirmLiveReadOnly" | "confirmNoDbWrite" | "confirmOpenseaRest"> = {
  pageLimit: 50,
  maxPagesPerQuery: 2,
  maxEventsPerQuery: 100,
  maxTotalRequests: 10,
  requestTimeoutMs: 30_000,
  maxWindowSeconds: 3_600,
  maxAttempts: 2,
  allowedClockSkewSeconds: 300
};

export function defaultRestContractProbePlan(): ProbeQueryProfile[] {
  return [
    { name: "unfiltered", eventTypes: [] },
    { name: "listing", eventTypes: ["listing"] },
    { name: "sale", eventTypes: ["sale"] },
    { name: "transfer", eventTypes: ["transfer"] },
    { name: "mint", eventTypes: ["mint"] }
  ];
}

function assertSafeIntegerSeconds(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer Unix timestamp`);
}

export function validateRestContractProbeConfig(config: RestContractProbeConfig, nowSeconds = Math.floor(Date.now() / 1000)): void {
  if (!config.confirmLiveReadOnly || !config.confirmNoDbWrite || !config.confirmOpenseaRest) throw new Error("all live read-only probe confirmation gates are required");
  assertSafeIntegerSeconds(config.after, "after");
  assertSafeIntegerSeconds(config.before, "before");
  if (config.after >= config.before) throw new Error("after must be lower than before");
  if (config.before - config.after > config.maxWindowSeconds) throw new Error("probe window exceeds maxWindowSeconds");
  if (config.before > nowSeconds + config.allowedClockSkewSeconds) throw new Error("probe window before timestamp exceeds allowed clock skew");
  validateRestBackfillPolicy({ pageLimit: config.pageLimit, maxPages: config.maxPagesPerQuery, maxEvents: config.maxEventsPerQuery, requestTimeoutMs: config.requestTimeoutMs, maxWindowSeconds: config.maxWindowSeconds });
  validateRestHttpRetryPolicy({ maxAttempts: config.maxAttempts });
  if (!Number.isSafeInteger(config.maxTotalRequests) || config.maxTotalRequests < 1 || config.maxTotalRequests > 50) throw new Error("maxTotalRequests must be an integer from 1 to 50");
  if (!Number.isSafeInteger(config.allowedClockSkewSeconds) || config.allowedClockSkewSeconds < 0 || config.allowedClockSkewSeconds > 3_600) throw new Error("allowedClockSkewSeconds must be an integer from 0 to 3600");
  if (typeof config.outputDir !== "string" || config.outputDir.trim().length === 0) throw new Error("outputDir is required");
}

export function parseRestContractProbeArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RestContractProbeConfig {
  const values = new Map<string, string | true>();
  const allowed = new Set([
    "--confirm-live-read-only",
    "--confirm-no-db-write",
    "--confirm-opensea-rest",
    "--after",
    "--before",
    "--output-dir",
    "--page-limit",
    "--max-pages-per-query",
    "--max-events-per-query",
    "--max-total-requests",
    "--request-timeout-ms",
    "--max-window-seconds",
    "--max-attempts",
    "--allowed-clock-skew-seconds"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (arg.startsWith("--confirm-")) {
      values.set(arg, true);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, next);
    index += 1;
  }
  const numberValue = (name: string, fallback?: number): number => {
    const raw = values.get(name);
    if (raw === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${name} is required`);
    }
    if (raw === true) throw new Error(`${name} requires a numeric value`);
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
    return parsed;
  };
  const outputDirValue = values.get("--output-dir");
  if (outputDirValue === undefined || outputDirValue === true) throw new Error("--output-dir is required");
  const config: RestContractProbeConfig = {
    ...DEFAULT_REST_CONTRACT_PROBE_CONFIG,
    after: numberValue("--after"),
    before: numberValue("--before"),
    outputDir: outputDirValue,
    pageLimit: numberValue("--page-limit", DEFAULT_REST_CONTRACT_PROBE_CONFIG.pageLimit),
    maxPagesPerQuery: numberValue("--max-pages-per-query", DEFAULT_REST_CONTRACT_PROBE_CONFIG.maxPagesPerQuery),
    maxEventsPerQuery: numberValue("--max-events-per-query", DEFAULT_REST_CONTRACT_PROBE_CONFIG.maxEventsPerQuery),
    maxTotalRequests: numberValue("--max-total-requests", DEFAULT_REST_CONTRACT_PROBE_CONFIG.maxTotalRequests),
    requestTimeoutMs: numberValue("--request-timeout-ms", DEFAULT_REST_CONTRACT_PROBE_CONFIG.requestTimeoutMs),
    maxWindowSeconds: numberValue("--max-window-seconds", DEFAULT_REST_CONTRACT_PROBE_CONFIG.maxWindowSeconds),
    maxAttempts: numberValue("--max-attempts", DEFAULT_REST_CONTRACT_PROBE_CONFIG.maxAttempts),
    allowedClockSkewSeconds: numberValue("--allowed-clock-skew-seconds", DEFAULT_REST_CONTRACT_PROBE_CONFIG.allowedClockSkewSeconds),
    confirmLiveReadOnly: values.get("--confirm-live-read-only") === true,
    confirmNoDbWrite: values.get("--confirm-no-db-write") === true,
    confirmOpenseaRest: values.get("--confirm-opensea-rest") === true
  };
  if (!env.OPENSEA_API_KEY || env.OPENSEA_API_KEY.trim().length === 0) throw new Error("OPENSEA_API_KEY is required");
  return config;
}

function primitiveType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

type NumericSafety = "safe_integer" | "unsafe_integer" | "finite_non_integer" | "not_numeric";

function numericSafetyFor(value: unknown): NumericSafety {
  if (typeof value !== "number") return "not_numeric";
  if (Number.isInteger(value)) return Number.isSafeInteger(value) ? "safe_integer" : "unsafe_integer";
  return Number.isFinite(value) ? "finite_non_integer" : "not_numeric";
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

const CONCEPT_PATTERNS: Record<string, RegExp> = {
  version: /(^|\.)(version|event_version|eventVersion)$/i,
  timestamp: /timestamp|created_date|created_at/i,
  orderHash: /order.*hash|order_hash|orderHash|(^|\.)hash$/i,
  nftIdentity: /nft|identifier|token_id|tokenId|contract|chain/i,
  transactionHash: /transaction.*hash|transaction_hash|transactionHash|(^|\.)hash$/i,
  from: /(^|\.)(from|from_account|from_address|fromAddress|address)$/i,
  to: /(^|\.)(to|to_account|to_address|toAddress|address)$/i
};

export interface FieldObservation {
  path: string;
  type: string;
  value?: unknown;
  numericSafety: NumericSafety;
  unsafeNumber: boolean;
  identityCritical: boolean;
}

export function discoverRestFieldPaths(value: unknown, maxDepth = 5, maxFields = 200): Record<string, FieldObservation[]> {
  const out: Record<string, FieldObservation[]> = { version: [], timestamp: [], orderHash: [], nftIdentity: [], transactionHash: [], from: [], to: [] };
  const addObservation = (concept: string, currentPath: string, current: unknown): void => {
    const numericSafety = numericSafetyFor(current);
    out[concept].push({
      path: currentPath,
      type: primitiveType(current),
      value: summarizeValue(current),
      numericSafety,
      unsafeNumber: numericSafety === "unsafe_integer",
      identityCritical: concept === "version" || concept === "timestamp" || concept === "orderHash" || concept === "nftIdentity" || concept === "transactionHash"
    });
  };
  const visit = (current: unknown, currentPath: string, depth: number): void => {
    if (Object.values(out).reduce((sum, fields) => sum + fields.length, 0) >= maxFields || depth > maxDepth) return;
    if (current === null || typeof current !== "object") {
      for (const [concept, pattern] of Object.entries(CONCEPT_PATTERNS)) {
        if (pattern.test(currentPath)) addObservation(concept, currentPath, current);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.slice(0, 5).forEach((item, index) => visit(item, `${currentPath}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      const childType = primitiveType(child);
      for (const [concept, pattern] of Object.entries(CONCEPT_PATTERNS)) {
        const topLevelTransactionHash = concept === "transactionHash" && nextPath === "transaction" && typeof child === "string";
        if (pattern.test(nextPath) || topLevelTransactionHash) {
          const numericSafety = numericSafetyFor(child);
          out[concept].push({
            path: nextPath,
            type: childType,
            value: summarizeValue(child),
            numericSafety,
            unsafeNumber: numericSafety === "unsafe_integer",
            identityCritical: concept === "version" || concept === "timestamp" || concept === "orderHash" || concept === "nftIdentity" || concept === "transactionHash"
          });
        }
      }
      visit(child, nextPath, depth + 1);
    }
  };
  visit(value, "", 0);
  return out;
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function classifyDedupe(dedupeKey: string | null): { strategy: string | null; usedFallback: boolean } {
  if (!dedupeKey) return { strategy: null, usedFallback: false };
  const strategy = dedupeKey.split(":")[0] ?? null;
  return { strategy, usedFallback: strategy?.includes("fallback") ?? false };
}

export function analyzeRestEvent(rawEvent: unknown, sequence: number, queryProfile: string, receivedAt: string): Record<string, unknown> {
  const rawEventType = typeof (rawEvent as any)?.event_type === "string" ? (rawEvent as any).event_type : typeof (rawEvent as any)?.eventType === "string" ? (rawEvent as any).eventType : "unknown";
  const fields = discoverRestFieldPaths(rawEvent);
  const adapted = adaptRestEventToDurableIngress(rawEvent);
  let envelope: ReturnType<typeof extractInboxJournalEnvelope> | null = null;
  let dedupeStrategy: string | null = null;
  let usedFallbackDedupe = false;
  if (adapted.outcome === "adapted") {
    envelope = extractInboxJournalEnvelope(adapted.rawEvent, receivedAt);
    const dedupe = classifyDedupe(envelope?.dedupeKey ?? null);
    dedupeStrategy = dedupe.strategy;
    usedFallbackDedupe = dedupe.usedFallback;
  }
  const eventVersionCandidate = fields.version.find((field) => field.value !== undefined)?.value;
  const timestampCandidate = fields.timestamp.find((field) => field.value !== undefined)?.value;
  const unsafeFields = Object.values(fields).flat().filter((field) => field.unsafeNumber);
  const identityUnsafeFields = unsafeFields.filter((field) => field.identityCritical);
  const trustworthyStructuredDedupe = Boolean(envelope?.dedupeKey) && !usedFallbackDedupe && identityUnsafeFields.length === 0;
  return {
    probeEventSequence: sequence,
    queryProfile,
    rawEventType,
    rawPayloadHash: sha256(canonicalJson(rawEvent)),
    observedTopLevelKeys: rawEvent !== null && typeof rawEvent === "object" && !Array.isArray(rawEvent) ? Object.keys(rawEvent as Record<string, unknown>).sort() : [],
    candidateTimestampFields: fields.timestamp,
    candidateVersionFields: fields.version,
    candidateOrderHashFields: fields.orderHash,
    candidateNftIdentityFields: fields.nftIdentity,
    candidateTransactionHashFields: fields.transactionHash,
    candidateFromFields: fields.from,
    candidateToFields: fields.to,
    adapterClassification: adapted.outcome,
    adapterReason: adapted.outcome === "adapted" ? null : sanitizeBackfillError(adapted.reason),
    adaptedDurableFamily: adapted.outcome === "adapted" ? adapted.durableEventType : null,
    dedupeStrategy,
    dedupeKey: envelope?.dedupeKey ?? null,
    usedFallbackDedupe,
    normalizedBusinessTimestamp: normalizeBusinessTimestamp(timestampCandidate),
    normalizedEventVersion: normalizeEventVersion(eventVersionCandidate),
    unsafeParsedNumberCount: unsafeFields.length,
    unsafeParsedNumberPaths: unsafeFields.slice(0, 20).map((field) => field.path),
    identityCriticalUnsafeNumber: identityUnsafeFields.length > 0,
    identityCriticalUnsafeNumberPaths: identityUnsafeFields.slice(0, 20).map((field) => field.path),
    trustworthyStructuredDedupe
  };
}

async function ensureOutputDirectory(outputDir: string): Promise<void> {
  const resolved = path.resolve(outputDir);
  if (fs.existsSync(resolved)) {
    const entries = await fs.promises.readdir(resolved);
    if (entries.length > 0) throw new Error("output directory must not already contain files");
    return;
  }
  await fs.promises.mkdir(resolved, { recursive: false });
}

async function createEvidenceWriters(outputDir: string): Promise<EvidenceWriters> {
  await ensureOutputDirectory(outputDir);
  const rawPagesPath = path.join(outputDir, "raw_pages.jsonl");
  const analysisPath = path.join(outputDir, "event_analysis.jsonl");
  const summaryPath = path.join(outputDir, "probe_summary.json");
  const appendLine = async (file: string, value: unknown): Promise<void> => {
    await fs.promises.appendFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
  };
  return {
    rawPagesPath,
    analysisPath,
    appendRawPage: (value) => appendLine(rawPagesPath, value),
    appendAnalysis: (value) => appendLine(analysisPath, value),
    writeSummary: async (value) => {
      const tmp = `${summaryPath}.tmp`;
      const handle = await fs.promises.open(tmp, "w");
      try {
        await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(tmp, summaryPath);
    }
  };
}

function emptySummary(config: RestContractProbeConfig, startedAt: string, profiles: ProbeQueryProfile[], writers: EvidenceWriters): RestContractProbeSummary {
  return {
    result: "REST_CONTRACT_PROBE_FAILED",
    startedAt,
    finishedAt: null,
    durationMs: null,
    collection: { slug: REST_BACKFILL_COLLECTION_SLUG, endpoint: OPENSEA_REST_COLLECTION_EVENTS_ENDPOINT },
    window: { after: config.after, before: config.before },
    queryProfiles: profiles,
    requestsAttempted: 0,
    requestsSucceeded: 0,
    httpRetries: 0,
    rateLimitedResponses: 0,
    pagesFetched: 0,
    eventsObserved: 0,
    eventTypeDistribution: {},
    listingCount: 0,
    saleCount: 0,
    transferCount: 0,
    mintCount: 0,
    cancelObservedCount: 0,
    offerExcludedCount: 0,
    unknownCount: 0,
    adapterSupported: 0,
    adapterUnsupported: 0,
    adapterMalformed: 0,
    structuredDedupeCount: 0,
    fallbackDedupeCount: 0,
    listingVersionPresentCount: 0,
    saleVersionPresentCount: 0,
    listingOrderHashPresentCount: 0,
    saleOrderHashPresentCount: 0,
    transferTxHashPresentCount: 0,
    unsafeParsedNumberCount: 0,
    eventsWithUnsafeParsedNumbers: 0,
    eventsWithIdentityCriticalUnsafeNumbers: 0,
    unsafeParsedNumberPathsSample: [],
    rawEvidenceFiles: [path.basename(writers.rawPagesPath)],
    analysisEvidenceFiles: [path.basename(writers.analysisPath)],
    truncatedProfiles: [],
    sanitizedErrors: [],
    databaseTouched: false,
    streamConnected: false,
    txAInvoked: false,
    txBInvoked: false,
    crossSourceAlgorithmReady: false,
    crossSourceEquivalenceProven: false,
    restInvalidationCoverageProbed: false,
    restRevalidationCoverageProbed: false
  };
}

function applyAnalysisToSummary(summary: RestContractProbeSummary, analysis: Record<string, unknown>): void {
  const type = String(analysis.rawEventType);
  increment(summary.eventTypeDistribution, type);
  summary.eventsObserved += 1;
  if (type === "listing") summary.listingCount += 1;
  else if (type === "sale") summary.saleCount += 1;
  else if (type === "transfer") summary.transferCount += 1;
  else if (type === "mint") summary.mintCount += 1;
  else if (/cancel/i.test(type)) summary.cancelObservedCount += 1;
  else if (type === "offer" || type === "trait_offer" || type === "collection_offer") summary.offerExcludedCount += 1;
  else summary.unknownCount += 1;

  if (analysis.adapterClassification === "adapted") summary.adapterSupported += 1;
  else if (analysis.adapterClassification === "unsupported") summary.adapterUnsupported += 1;
  else summary.adapterMalformed += 1;
  if (analysis.usedFallbackDedupe === true) summary.fallbackDedupeCount += 1;
  if (analysis.trustworthyStructuredDedupe === true) summary.structuredDedupeCount += 1;
  const unsafeCount = typeof analysis.unsafeParsedNumberCount === "number" ? analysis.unsafeParsedNumberCount : 0;
  if (unsafeCount > 0) {
    summary.unsafeParsedNumberCount += unsafeCount;
    summary.eventsWithUnsafeParsedNumbers += 1;
    for (const fieldPath of (analysis.unsafeParsedNumberPaths as string[] | undefined) ?? []) {
      if (summary.unsafeParsedNumberPathsSample.length < 20) summary.unsafeParsedNumberPathsSample.push(fieldPath);
    }
  }
  if (analysis.identityCriticalUnsafeNumber === true) summary.eventsWithIdentityCriticalUnsafeNumbers += 1;
  const versionFields = analysis.candidateVersionFields as FieldObservation[];
  const orderFields = analysis.candidateOrderHashFields as FieldObservation[];
  const txFields = analysis.candidateTransactionHashFields as FieldObservation[];
  if (type === "listing" && versionFields.length > 0) summary.listingVersionPresentCount += 1;
  if (type === "sale" && versionFields.length > 0) summary.saleVersionPresentCount += 1;
  if (type === "listing" && orderFields.length > 0) summary.listingOrderHashPresentCount += 1;
  if (type === "sale" && orderFields.length > 0) summary.saleOrderHashPresentCount += 1;
  if (type === "transfer" && txFields.length > 0) summary.transferTxHashPresentCount += 1;
}

function resultFor(summary: RestContractProbeSummary, mandatoryFailed: boolean, evidenceCompromised: boolean): ProbeResult {
  if (mandatoryFailed || evidenceCompromised || summary.requestsSucceeded === 0) return "REST_CONTRACT_PROBE_FAILED";
  if (summary.sanitizedErrors.length > 0 || summary.truncatedProfiles.length > 0 || summary.adapterMalformed > 0) return "REST_CONTRACT_PROBE_PARTIAL";
  return "REST_CONTRACT_PROBE_COMPLETE";
}

export async function runRestContractProbe(config: RestContractProbeConfig, dependencies: RestContractProbeDependencies = {}): Promise<RestContractProbeSummary> {
  validateRestContractProbeConfig(config, dependencies.nowSeconds?.() ?? Math.floor(Date.now() / 1000));
  const apiKey = dependencies.env?.OPENSEA_API_KEY ?? process.env.OPENSEA_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) throw new Error("OPENSEA_API_KEY is required");
  const startedAt = dependencies.nowIso?.() ?? new Date().toISOString();
  const startedMs = Date.parse(startedAt);
  const writers = dependencies.evidenceWriters ?? await createEvidenceWriters(config.outputDir);
  const profiles = defaultRestContractProbePlan();
  const summary = emptySummary(config, startedAt, profiles, writers);
  const client = new RestEventsClient({
    apiKey,
    policy: { pageLimit: config.pageLimit, maxPages: config.maxPagesPerQuery, maxEvents: config.maxEventsPerQuery, requestTimeoutMs: config.requestTimeoutMs, maxWindowSeconds: config.maxWindowSeconds },
    retryPolicy: { maxAttempts: config.maxAttempts },
    dependencies
  });
  let sequence = 0;
  let mandatoryFailed = false;
  let evidenceCompromised = false;
  try {
    for (const profile of profiles) {
      let cursor: string | null = null;
      let profileEvents = 0;
      for (let pageIndex = 0; pageIndex < config.maxPagesPerQuery; pageIndex += 1) {
        if (summary.requestsAttempted >= config.maxTotalRequests) {
          summary.truncatedProfiles.push(profile.name);
          break;
        }
        summary.requestsAttempted += 1;
        try {
          const page = await client.fetchCollectionEventsPage({ after: config.after, before: config.before, limit: config.pageLimit, cursor, eventTypes: profile.eventTypes });
          summary.requestsSucceeded += 1;
          summary.pagesFetched += 1;
          summary.httpRetries += page.retries;
          summary.rateLimitedResponses += page.rateLimitedResponses;
          try {
            await writers.appendRawPage({
              queryProfile: profile.name,
              requestedAfter: config.after,
              requestedBefore: config.before,
              eventTypeFilter: profile.eventTypes.length === 0 ? null : profile.eventTypes,
              limit: config.pageLimit,
              cursorInput: cursor,
              httpStatus: page.httpStatus,
              retrievedAt: dependencies.nowIso?.() ?? new Date().toISOString(),
              nextCursor: page.next,
              rateLimitMetadata: page.rateLimit satisfies RestBackfillRateLimit,
              literalResponseText: page.literalResponseText,
              literalResponseSha256: page.literalResponseSha256,
              literalResponseByteLength: page.literalResponseByteLength
            });
          } catch (error) {
            evidenceCompromised = true;
            throw error;
          }
          for (const rawEvent of page.events.slice(0, Math.max(0, config.maxEventsPerQuery - profileEvents))) {
            sequence += 1;
            profileEvents += 1;
            const analysis = analyzeRestEvent(rawEvent, sequence, profile.name, dependencies.nowIso?.() ?? new Date().toISOString());
            applyAnalysisToSummary(summary, analysis);
            try {
              await writers.appendAnalysis(analysis);
            } catch (error) {
              evidenceCompromised = true;
              throw error;
            }
          }
          if (profileEvents >= config.maxEventsPerQuery && page.next) {
            summary.truncatedProfiles.push(profile.name);
            break;
          }
          if (!page.next) break;
          if (pageIndex + 1 >= config.maxPagesPerQuery) {
            summary.truncatedProfiles.push(profile.name);
            break;
          }
          cursor = page.next;
        } catch (error) {
          if (error instanceof RestEventsClientError && error.literalResponseText !== null) {
            try {
              await writers.appendRawPage({
                queryProfile: profile.name,
                requestedAfter: config.after,
                requestedBefore: config.before,
                eventTypeFilter: profile.eventTypes.length === 0 ? null : profile.eventTypes,
                limit: config.pageLimit,
                cursorInput: cursor,
                httpStatus: error.status,
                retrievedAt: dependencies.nowIso?.() ?? new Date().toISOString(),
                nextCursor: null,
                rateLimitMetadata: error.rateLimit,
                literalResponseText: error.literalResponseText,
                literalResponseSha256: error.literalResponseSha256,
                literalResponseByteLength: error.literalResponseByteLength,
                parseOrRequestError: sanitizeBackfillError(error)
              });
            } catch (writeError) {
              evidenceCompromised = true;
              summary.sanitizedErrors.push(`${profile.name}: raw evidence write failed: ${sanitizeBackfillError(writeError)}`);
            }
          }
          summary.sanitizedErrors.push(`${profile.name}: ${sanitizeBackfillError(error)}`);
          if (profile.name === "unfiltered") mandatoryFailed = true;
          break;
        }
      }
    }
    summary.crossSourceAlgorithmReady = summary.structuredDedupeCount > 0 && summary.fallbackDedupeCount === 0 && summary.eventsWithIdentityCriticalUnsafeNumbers === 0;
    summary.result = resultFor(summary, mandatoryFailed, evidenceCompromised);
  } catch (error) {
    evidenceCompromised = true;
    summary.sanitizedErrors.push(`probe failed: ${sanitizeBackfillError(error)}`);
    summary.result = "REST_CONTRACT_PROBE_FAILED";
  } finally {
    const finishedAt = dependencies.nowIso?.() ?? new Date().toISOString();
    summary.finishedAt = finishedAt;
    const finishedMs = Date.parse(finishedAt);
    summary.durationMs = Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : null;
    try {
      await writers.writeSummary(summary);
    } catch (error) {
      summary.sanitizedErrors.push(`summary write failed: ${sanitizeBackfillError(error)}`);
      summary.result = "REST_CONTRACT_PROBE_FAILED";
    }
  }
  return summary;
}
