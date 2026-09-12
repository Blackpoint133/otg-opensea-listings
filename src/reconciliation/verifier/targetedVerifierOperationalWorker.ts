import { randomUUID } from "node:crypto";
import type { DbPool } from "../../db/types.js";
import { canonicalEvidence, deepFreeze, sha256Canonical } from "../evidence/canonicalEvidence.js";
import type { OpenSeaExactOrderObservationV1 } from "./openSeaExactOrderAdapter.js";
import { interpretOpenSeaExactOrderObservation } from "./targetedVerifierNormalizer.js";
import {
  attemptIdentity, canonicalRequestIdentity, semanticEvidenceMaterial, validateTargetedVerifierEligibility,
} from "./targetedVerifierPolicy.js";
import {
  OPENSEA_ORDER_CONTRACT_VERSION, TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION,
  TARGETED_VERIFIER_GENERATION_MODEL_VERSION, TARGETED_VERIFIER_NORMALIZER_VERSION,
  TARGETED_VERIFIER_POLICY_VERSION, TARGETED_VERIFIER_SCHEMA_VERSION,
  type ProviderResult, type TargetedVerifierContext, type VerifierLifecycle, type JournalFenceSnapshot, type RelevantOrderFingerprint
} from "./targetedVerifierTypes.js";

export interface TargetedVerifierOperationalPolicy {
  readonly minimumSpacingMs: number;
  readonly maxConcurrent: number;
  readonly rateLimitedDelayMs: number;
  readonly transientTransportDelayMs: number;
  readonly maxAttempts: number;
  readonly leaseMs: number;
}

export const DEFAULT_TARGETED_VERIFIER_OPERATIONAL_POLICY: TargetedVerifierOperationalPolicy = Object.freeze({
  minimumSpacingMs: 1_000,
  maxConcurrent: 2,
  rateLimitedDelayMs: 60_000,
  transientTransportDelayMs: 5_000,
  maxAttempts: 3,
  leaseMs: 120_000,
});

export interface OperationalAttemptRecord {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
  readonly sweepId: string;
  readonly orderHash: string;
  readonly candidateArtifactHash: string;
  readonly barrierArtifactHash: string;
  readonly generationRootHash: string;
  readonly candidateModelVersion: string;
  readonly generationModelVersion: string;
  readonly verifierSchemaVersion: string;
  readonly verifierPolicyVersion: string;
  readonly providerContractVersion: string;
  readonly normalizerVersion: string;
  readonly expectedIdentity: TargetedVerifierContext["expectedIdentity"];
  readonly requestIdentity: ReturnType<typeof canonicalRequestIdentity>;
  readonly lifecycle: VerifierLifecycle;
  readonly leaseToken: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly verificationStartedAt: string | null;
  readonly verificationCompletedAt: string | null;
  readonly providerObservedAt: string | null;
  readonly httpStatus: number | null;
  readonly transportOutcome: "HTTP" | "TIMEOUT" | "CONNECTION_RESET" | null;
  readonly responseBodySha256: string | null;
  readonly rawResponseArtifactHash: string | null;
  readonly normalizedProviderStatus: ProviderResult["providerStatus"];
  readonly providerResultStatus: ProviderResult["status"] | null;
  readonly providerReasonCodes: readonly string[];
  readonly normalizedOrder: ProviderResult["normalizedOrder"];
  readonly providerResultReasonCodes: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly preVerificationWatermark: JournalFenceSnapshot["watermark"];
  readonly postVerificationWatermark: JournalFenceSnapshot["watermark"] | null;
  readonly preRelevantFingerprint: RelevantOrderFingerprint;
  readonly postRelevantFingerprint: RelevantOrderFingerprint | null;
  readonly semanticEvidenceHash: string | null;
  readonly authorityGranted: false;
  readonly deactivationAuthorityGranted: false;
  readonly failureClassification: string | null;
  readonly nextAttemptAt: string | null;
}

export interface AttemptCreateInput {
  readonly context: TargetedVerifierContext;
  readonly preVerification: JournalFenceSnapshot;
  readonly createdAt: string;
  readonly attemptNumber?: number;
}

export interface ClaimedAttempt {
  readonly record: OperationalAttemptRecord;
  readonly leaseToken: string;
}

export interface PostVerificationFenceResult {
  readonly valid: boolean;
  readonly status: "STABLE" | "STALE" | "RECONCILIATION_REQUIRED";
  readonly postVerification: JournalFenceSnapshot;
  readonly reasonCodes: readonly string[];
}

export interface TargetedVerifierAttemptStore {
  createOrGet(input: OperationalAttemptRecord): Promise<OperationalAttemptRecord>;
  get(attemptId: string): Promise<OperationalAttemptRecord | null>;
  listDue(now: string, limit: number): Promise<readonly OperationalAttemptRecord[]>;
  claim(attemptId: string, workerId: string, now: string, leaseMs: number): Promise<ClaimedAttempt | null>;
  saveResponse(attemptId: string, leaseToken: string, record: OperationalAttemptRecord): Promise<boolean>;
  complete(attemptId: string, leaseToken: string, record: OperationalAttemptRecord): Promise<boolean>;
  fail(attemptId: string, leaseToken: string, record: OperationalAttemptRecord): Promise<boolean>;
  scheduleRetry(attemptId: string, leaseToken: string, record: OperationalAttemptRecord): Promise<boolean>;
  reclaimExpired(now: string): Promise<number>;
}

export interface InMemoryTargetedVerifierAttemptStoreOptions { readonly records?: readonly OperationalAttemptRecord[]; }

function clone<T>(value: T): T { return structuredClone(value); }
function frozen<T>(value: T): T { return deepFreeze(value); }
function validIso(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function requireIso(value: string): void { if (!validIso(value)) throw new Error("INVALID_OPERATIONAL_TIMESTAMP"); }
function leaseUntil(now: string, leaseMs: number): string { const value = Date.parse(now) + leaseMs; if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isFinite(value)) throw new Error("INVALID_LEASE"); return new Date(value).toISOString(); }
function sameLease(record: OperationalAttemptRecord, token: string): boolean { return (record.lifecycle === "REQUEST_PENDING" || record.lifecycle === "RESPONSE_OBSERVED" || record.lifecycle === "PENDING_FENCE") && record.leaseToken === token && record.leaseExpiresAt !== null && token.length > 0; }
function due(record: OperationalAttemptRecord, now: string): boolean { return record.lifecycle === "NOT_STARTED" && (record.nextAttemptAt === null || record.nextAttemptAt <= now); }

export class InMemoryTargetedVerifierAttemptStore implements TargetedVerifierAttemptStore {
  private readonly rows = new Map<string, OperationalAttemptRecord>();
  constructor(options: InMemoryTargetedVerifierAttemptStoreOptions = {}) { for (const row of options.records ?? []) this.rows.set(row.attemptId, frozen(clone(row))); }
  async createOrGet(input: OperationalAttemptRecord): Promise<OperationalAttemptRecord> {
    const existing = [...this.rows.values()].find((row) => row.idempotencyKey === input.idempotencyKey);
    if (existing) return clone(existing);
    this.rows.set(input.attemptId, frozen(clone(input))); return clone(input);
  }
  async get(attemptId: string): Promise<OperationalAttemptRecord | null> { const row = this.rows.get(attemptId); return row ? clone(row) : null; }
  async listDue(now: string, limit: number): Promise<readonly OperationalAttemptRecord[]> { return [...this.rows.values()].filter((row) => due(row, now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(clone); }
  async claim(attemptId: string, workerId: string, now: string, leaseMs: number): Promise<ClaimedAttempt | null> {
    const row = this.rows.get(attemptId); if (!row || !due(row, now) || workerId.length === 0) return null;
    const token = `${workerId}:${randomUUID()}`;
    const claimed = frozen({ ...row, lifecycle: "REQUEST_PENDING" as const, leaseToken: token, claimedAt: now, leaseExpiresAt: leaseUntil(now, leaseMs), verificationStartedAt: now });
    this.rows.set(attemptId, claimed); return { record: clone(claimed), leaseToken: token };
  }
  private cas(attemptId: string, leaseToken: string, record: OperationalAttemptRecord): boolean {
    const current = this.rows.get(attemptId); if (!current || !sameLease(current, leaseToken)) return false;
    this.rows.set(attemptId, frozen(clone(record))); return true;
  }
  async saveResponse(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record); }
  async complete(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record); }
  async fail(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record); }
  async scheduleRetry(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record); }
  async reclaimExpired(now: string): Promise<number> {
    let count = 0;
    for (const [id, row] of this.rows) if (row.lifecycle === "REQUEST_PENDING" && row.leaseExpiresAt !== null && row.leaseExpiresAt <= now) {
      this.rows.set(id, frozen({ ...row, lifecycle: "FAILED" as const, leaseToken: null, leaseExpiresAt: null, failureClassification: "REQUEST_OUTCOME_UNCERTAIN" })); count++;
    }
    return count;
  }
}

function rowForContext(input: AttemptCreateInput): OperationalAttemptRecord {
  const eligibility = validateTargetedVerifierEligibility(input.context);
  if (!eligibility.valid) throw new Error(`VERIFIER_NOT_ELIGIBLE:${eligibility.reasons.join(",")}`);
  requireIso(input.createdAt);
  if (!Number.isSafeInteger(input.attemptNumber ?? 0) || (input.attemptNumber ?? 0) < 0) throw new Error("INVALID_ATTEMPT_NUMBER");
  const attemptNumber = input.attemptNumber ?? 0;
  const requestIdentity = canonicalRequestIdentity(input.context);
  const attemptId = attemptIdentity(input.context, attemptNumber);
  const idempotencyKey = sha256Canonical({ sweepId: input.context.sweepId, orderHash: input.context.orderHash, candidateArtifactHash: input.context.candidateArtifactHash, barrierArtifactHash: input.context.barrierArtifactHash, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, attemptNumber });
  return frozen({ attemptId, attemptNumber, idempotencyKey, sweepId: input.context.sweepId, orderHash: input.context.orderHash, candidateArtifactHash: input.context.candidateArtifactHash, barrierArtifactHash: input.context.barrierArtifactHash, generationRootHash: input.context.generationRootHash, candidateModelVersion: TARGETED_VERIFIER_CANDIDATE_MODEL_VERSION, generationModelVersion: TARGETED_VERIFIER_GENERATION_MODEL_VERSION, verifierSchemaVersion: TARGETED_VERIFIER_SCHEMA_VERSION, verifierPolicyVersion: TARGETED_VERIFIER_POLICY_VERSION, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, normalizerVersion: TARGETED_VERIFIER_NORMALIZER_VERSION, expectedIdentity: clone(input.context.expectedIdentity), requestIdentity, lifecycle: "NOT_STARTED" as const, leaseToken: null, createdAt: input.createdAt, claimedAt: null, leaseExpiresAt: null, verificationStartedAt: null, verificationCompletedAt: null, providerObservedAt: null, httpStatus: null, transportOutcome: null, responseBodySha256: null, rawResponseArtifactHash: null, normalizedProviderStatus: null, providerResultStatus: null, providerReasonCodes: [], normalizedOrder: null, providerResultReasonCodes: [], reasonCodes: [], preVerificationWatermark: clone(input.preVerification.watermark), postVerificationWatermark: null, preRelevantFingerprint: clone(input.preVerification.relevantOrderFingerprint), postRelevantFingerprint: null, semanticEvidenceHash: null, authorityGranted: false as const, deactivationAuthorityGranted: false as const, failureClassification: null, nextAttemptAt: null });
}

export interface TargetedVerifierExecution { readonly observation: OpenSeaExactOrderObservationV1; readonly providerResult: ProviderResult; }
export interface TargetedVerifierOperationalWorkerOptions {
  readonly store: TargetedVerifierAttemptStore;
  readonly execute: (input: { readonly context: TargetedVerifierContext; readonly apiKey: string }) => Promise<TargetedVerifierExecution>;
  readonly credentialProvider: () => Promise<string>;
  readonly postFence: (input: { readonly context: TargetedVerifierContext; readonly providerResult: ProviderResult }) => Promise<PostVerificationFenceResult>;
  readonly contextResolver?: (record: OperationalAttemptRecord) => Promise<TargetedVerifierContext>;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly workerId?: string;
  readonly policy?: Partial<TargetedVerifierOperationalPolicy>;
}

export type OperationalRunOutcome = "IDLE" | "CADENCE_BLOCKED" | "CLAIMED" | "STALE_LEASE" | "COMPLETE" | "FAILED" | "RETRY_SCHEDULED";
export interface OperationalRunResult { readonly outcome: OperationalRunOutcome; readonly attemptId: string | null; readonly record: OperationalAttemptRecord | null; }

export class TargetedVerifierOperationalWorker {
  private readonly policy: TargetedVerifierOperationalPolicy;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly workerId: string;
  private active = 0;
  private lastRequestMs: number | null = null;
  private readonly contexts = new Map<string, TargetedVerifierContext>();
  constructor(private readonly options: TargetedVerifierOperationalWorkerOptions) {
    this.policy = { ...DEFAULT_TARGETED_VERIFIER_OPERATIONAL_POLICY, ...(options.policy ?? {}) };
    if (!Number.isSafeInteger(this.policy.minimumSpacingMs) || this.policy.minimumSpacingMs < 1 || !Number.isSafeInteger(this.policy.maxConcurrent) || this.policy.maxConcurrent < 1 || !Number.isSafeInteger(this.policy.maxAttempts) || this.policy.maxAttempts < 1) throw new Error("INVALID_OPERATIONAL_POLICY");
    this.now = options.now ?? (() => new Date().toISOString()); this.nowMs = options.nowMs ?? (() => Date.now()); this.workerId = options.workerId ?? randomUUID();
  }
  async createAttempt(input: AttemptCreateInput): Promise<OperationalAttemptRecord> { const row = await this.options.store.createOrGet(rowForContext(input)); this.contexts.set(row.attemptId, input.context); return row; }
  async runOnce(attemptId: string): Promise<OperationalRunResult> {
    const before = await this.options.store.get(attemptId); if (!before) return { outcome: "IDLE", attemptId, record: null };
    const nowMs = this.nowMs(); if (this.lastRequestMs !== null && nowMs - this.lastRequestMs < this.policy.minimumSpacingMs) return { outcome: "CADENCE_BLOCKED", attemptId, record: before };
    if (this.active >= this.policy.maxConcurrent) return { outcome: "CADENCE_BLOCKED", attemptId, record: before };
    const claim = await this.options.store.claim(attemptId, this.workerId, this.now(), this.policy.leaseMs); if (!claim) return { outcome: "STALE_LEASE", attemptId, record: await this.options.store.get(attemptId) };
    this.active++; this.lastRequestMs = this.nowMs();
    try {
      const credential = await this.options.credentialProvider(); if (typeof credential !== "string" || credential.length === 0 || /[\r\n]/.test(credential)) throw new Error("INVALID_CREDENTIAL");
      const context = await this.resolveContext(claim.record);
      const execution = await this.options.execute({ context, apiKey: credential });
      const observed = this.withProviderResult(claim.record, execution);
      if (!await this.options.store.saveResponse(attemptId, claim.leaseToken, observed)) return { outcome: "STALE_LEASE", attemptId, record: await this.options.store.get(attemptId) };
      const pendingFence = frozen({ ...observed, lifecycle: "PENDING_FENCE" as const });
      if (!await this.options.store.saveResponse(attemptId, claim.leaseToken, pendingFence)) return { outcome: "STALE_LEASE", attemptId, record: await this.options.store.get(attemptId) };
      const fence = await this.options.postFence({ context, providerResult: execution.providerResult });
      const finished = this.withFence(pendingFence, fence, this.now());
      if (!fence.valid) { await this.options.store.fail(attemptId, claim.leaseToken, finished); return { outcome: "FAILED", attemptId, record: finished }; }
      if (execution.providerResult.retry.retryable && observed.attemptNumber + 1 < this.policy.maxAttempts) {
        const delay = execution.providerResult.retry.recommendedPolicyClass === "RATE_LIMITED" ? this.policy.rateLimitedDelayMs : this.policy.transientTransportDelayMs;
        const nextAttemptAt = new Date(Date.parse(this.now()) + delay).toISOString();
        const nextBase = rowForContext({ context, preVerification: { watermark: finished.postVerificationWatermark ?? finished.preVerificationWatermark, relevantOrderFingerprint: finished.postRelevantFingerprint ?? finished.preRelevantFingerprint }, createdAt: this.now(), attemptNumber: observed.attemptNumber + 1 });
        const next = frozen({ ...nextBase, nextAttemptAt });
        const retired = frozen({ ...finished, lifecycle: "FAILED" as const, leaseToken: null, leaseExpiresAt: null, failureClassification: "RETRY_SCHEDULED" });
        await this.options.store.fail(attemptId, claim.leaseToken, retired);
        await this.options.store.createOrGet(next);
        return { outcome: "RETRY_SCHEDULED", attemptId: next.attemptId, record: next };
      }
      const complete = frozen({ ...finished, lifecycle: "COMPLETE" as const, verificationCompletedAt: this.now() }); await this.options.store.complete(attemptId, claim.leaseToken, complete); return { outcome: "COMPLETE", attemptId, record: complete };
    } catch (error) {
      const failed = frozen({ ...claim.record, lifecycle: "FAILED" as const, leaseExpiresAt: null, failureClassification: error instanceof Error ? error.message.slice(0, 120) : "EXECUTION_FAILED" });
      await this.options.store.fail(attemptId, claim.leaseToken, failed); return { outcome: "FAILED", attemptId, record: failed };
    } finally { this.active--; }
  }
  async runDue(limit = this.policy.maxConcurrent): Promise<readonly OperationalRunResult[]> { const rows = await this.options.store.listDue(this.now(), limit); return Promise.all(rows.map((row) => this.runOnce(row.attemptId))); }
  async reclaimExpired(): Promise<number> { return this.options.store.reclaimExpired(this.now()); }
  private async resolveContext(record: OperationalAttemptRecord): Promise<TargetedVerifierContext> { const local = this.contexts.get(record.attemptId); if (local) return local; if (this.options.contextResolver) return this.options.contextResolver(record); throw new Error("CONTEXT_RECONSTRUCTION_REQUIRED"); }
  private withProviderResult(record: OperationalAttemptRecord, execution: TargetedVerifierExecution): OperationalAttemptRecord { const p = execution.providerResult; return frozen({ ...record, lifecycle: "RESPONSE_OBSERVED" as const, verificationCompletedAt: null, providerObservedAt: p.observedAt, httpStatus: p.httpStatus, transportOutcome: p.retry.recommendedPolicyClass === "RATE_LIMITED" ? "HTTP" : p.status === "TRANSPORT_FAILED" ? (p.reasonCodes.includes("REQUEST_TIMEOUT") ? "TIMEOUT" : "CONNECTION_RESET") : "HTTP", responseBodySha256: p.responseBodySha256, rawResponseArtifactHash: p.rawResponseArtifactHash, normalizedProviderStatus: p.providerStatus, providerResultStatus: p.status, providerReasonCodes: p.reasonCodes, normalizedOrder: p.normalizedOrder, providerResultReasonCodes: p.reasonCodes, reasonCodes: p.reasonCodes, failureClassification: null }); }
  private withFence(record: OperationalAttemptRecord, fence: PostVerificationFenceResult, _now: string): OperationalAttemptRecord {
    const resultStatus = fence.valid ? record.providerResultStatus : fence.status === "STALE" ? "STALE" : "RECONCILIATION_REQUIRED";
    const semantic = sha256Canonical(semanticEvidenceMaterial({ ...record, postVerificationWatermark: fence.postVerification.watermark, postRelevantFingerprint: fence.postVerification.relevantOrderFingerprint, resultStatus, reasonCodes: fence.reasonCodes } as unknown as Record<string, unknown>));
    return frozen({ ...record, postVerificationWatermark: fence.postVerification.watermark, postRelevantFingerprint: fence.postVerification.relevantOrderFingerprint, semanticEvidenceHash: semantic, providerReasonCodes: [...record.providerReasonCodes].sort(), providerResultReasonCodes: [...record.providerResultReasonCodes].sort(), reasonCodes: [...fence.reasonCodes].sort(), failureClassification: fence.valid ? record.failureClassification : fence.status });
  }
}

/** SQL storage boundary. It stores only the sanitized operational record JSON; no listing row is mutated. */
export class PostgresTargetedVerifierAttemptStore implements TargetedVerifierAttemptStore {
  constructor(private readonly pool: DbPool) {}
  private decode(row: { payload: OperationalAttemptRecord }): OperationalAttemptRecord { return row.payload; }
  async createOrGet(input: OperationalAttemptRecord): Promise<OperationalAttemptRecord> { const result = await this.pool.query<{ payload: OperationalAttemptRecord }>(`INSERT INTO public.targeted_verifier_attempts (attempt_id, idempotency_key, attempt_number, order_hash, sweep_id, lifecycle, next_attempt_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING payload`, [input.attemptId, input.idempotencyKey, input.attemptNumber, input.orderHash, input.sweepId, input.lifecycle, input.nextAttemptAt, JSON.stringify(input)]); return this.decode(result.rows[0]); }
  async get(attemptId: string): Promise<OperationalAttemptRecord | null> { const result = await this.pool.query<{ payload: OperationalAttemptRecord }>(`SELECT payload FROM public.targeted_verifier_attempts WHERE attempt_id=$1`, [attemptId]); return result.rows[0] ? this.decode(result.rows[0]) : null; }
  async listDue(now: string, limit: number): Promise<readonly OperationalAttemptRecord[]> { const result = await this.pool.query<{ payload: OperationalAttemptRecord }>(`SELECT payload FROM public.targeted_verifier_attempts WHERE lifecycle='NOT_STARTED' AND (next_attempt_at IS NULL OR next_attempt_at <= $1) ORDER BY created_at, attempt_id LIMIT $2`, [now, limit]); return result.rows.map((row) => this.decode(row)); }
  async claim(id: string, workerId: string, now: string, leaseMs: number): Promise<ClaimedAttempt | null> { const token = `${workerId}:${randomUUID()}`; const expires = leaseUntil(now, leaseMs); const result = await this.pool.query<{ payload: OperationalAttemptRecord }>(`UPDATE public.targeted_verifier_attempts SET lifecycle='REQUEST_PENDING', claimed_at=$2, lease_expires_at=$3, lease_token=$4, payload=jsonb_set(jsonb_set(jsonb_set(jsonb_set(payload,'{lifecycle}','"REQUEST_PENDING"'),'{claimedAt}',to_jsonb($2::text)),'{leaseExpiresAt}',to_jsonb($3::text)),'{leaseToken}',to_jsonb($4::text)) WHERE attempt_id=$1 AND lifecycle='NOT_STARTED' AND (next_attempt_at IS NULL OR next_attempt_at <= $2) RETURNING payload`, [id, now, expires, token]); return result.rows[0] ? { record: this.decode(result.rows[0]), leaseToken: token } : null; }
  private async cas(id: string, token: string, record: OperationalAttemptRecord, releaseLease: boolean): Promise<boolean> { const result = await this.pool.query(`UPDATE public.targeted_verifier_attempts SET lifecycle=$3, payload=$4::jsonb, lease_token=${releaseLease ? "NULL" : "$2"}, lease_expires_at=${releaseLease ? "NULL" : "lease_expires_at"} WHERE attempt_id=$1 AND lease_token=$2`, [id, token, record.lifecycle, JSON.stringify(record)]); return result.rowCount === 1; }
  async saveResponse(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record, false); }
  async complete(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record, true); }
  async fail(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record, true); }
  async scheduleRetry(id: string, token: string, record: OperationalAttemptRecord): Promise<boolean> { return this.cas(id, token, record, true); }
  async reclaimExpired(now: string): Promise<number> { const result = await this.pool.query(`UPDATE public.targeted_verifier_attempts SET lifecycle='FAILED', lease_token=NULL, lease_expires_at=NULL, failure_classification='REQUEST_OUTCOME_UNCERTAIN', payload=jsonb_set(payload,'{lifecycle}','"FAILED"') WHERE lifecycle='REQUEST_PENDING' AND lease_expires_at < $1`, [now]); return result.rowCount ?? 0; }
}

export function operationalIdempotencyKey(context: TargetedVerifierContext, attemptNumber = 0): string { return sha256Canonical({ sweepId: context.sweepId, orderHash: context.orderHash, candidateArtifactHash: context.candidateArtifactHash, barrierArtifactHash: context.barrierArtifactHash, providerContractVersion: OPENSEA_ORDER_CONTRACT_VERSION, attemptNumber }); }
export function operationalSemanticEvidenceHash(record: OperationalAttemptRecord): string { return sha256Canonical(semanticEvidenceMaterial(record as unknown as Record<string, unknown>)); }
export function operationalRecordCanonicalBytes(record: OperationalAttemptRecord): string { return canonicalEvidence(record); }
