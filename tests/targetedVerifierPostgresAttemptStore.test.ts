import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import {
  InMemoryTargetedVerifierAttemptStore, PostgresTargetedVerifierAttemptStore,
  createTargetedVerifierOperationalWorker, __createTargetedVerifierOperationalWorkerForTest,
  operationalSemanticEvidenceHash, operationalIdempotencyKey, type OperationalAttemptRecord
} from "../src/reconciliation/verifier/targetedVerifierOperationalWorker.js";
import { sha256Canonical } from "../src/reconciliation/evidence/canonicalEvidence.js";
import { attemptIdentity, canonicalAttemptMaterial, eventFingerprint } from "../src/reconciliation/verifier/targetedVerifierPolicy.js";
import { adaptOpenSeaExactOrder } from "../src/reconciliation/verifier/openSeaExactOrderAdapter.js";
import { rehydrateProviderResult, interpretOpenSeaExactOrderObservation, validateProviderResult } from "../src/reconciliation/verifier/targetedVerifierNormalizer.js";
import { makeTrustedContexts, disposeTrustedContexts } from "./helpers/trustedVerifierContexts.js";

const NOW = "2026-01-01T00:00:00.000Z";
const fixture = await makeTrustedContexts();
after(() => disposeTrustedContexts(fixture.root));
const context = fixture.contexts[0];
const { orderHash, chain, protocolAddress, contractAddress, expectedIdentity } = context;
const body = new TextEncoder().encode(JSON.stringify({ order: {
  order_hash: orderHash, chain, protocol_address: protocolAddress, status: "INACTIVE", type: "basic",
  price: { current: { currency: "ETH", decimals: 18, value: "1" } },
  asset: { contract: contractAddress, identifier: expectedIdentity.tokenId }, remaining_quantity: 1,
  protocol_data: { parameters: {
    offerer: "0x" + "2".repeat(40), zone: "0x" + "3".repeat(40), zoneHash: "0x" + "0".repeat(64),
    salt: "1", conduitKey: "0x" + "0".repeat(64), totalOriginalConsiderationItems: 0, counter: 0, orderType: 0,
    startTime: "1760000000", endTime: "1760001000",
    offer: [{ itemType: 2, token: contractAddress, identifierOrCriteria: expectedIdentity.tokenId, startAmount: "1", endAmount: "1" }],
    consideration: [{ itemType: 2, token: contractAddress, identifierOrCriteria: expectedIdentity.tokenId, startAmount: "1", endAmount: "1", recipient: "0x" + "2".repeat(40) }]
  } }
} }));
const inactiveObservation = adaptOpenSeaExactOrder({
  context, httpStatus: 200, body,
  rawResponseArtifactHash: sha256Canonical({ syntheticArtifact: "inactive-response" }),
  headers: [{ name: "Content-Type", value: "application/json" }, { name: "Content-Encoding", value: "identity" }, { name: "Date", value: "Thu, 01 Jan 2026 00:00:00 GMT" }],
  timing: { requestStartedAt: NOW, responseHeadersAt: "2026-01-01T00:00:00.100Z", responseCompletedAt: "2026-01-01T00:00:00.200Z", elapsedMs: 200, overallDeadlineMs: 1000, deadlineExceeded: false }
});
const rateObservation = adaptOpenSeaExactOrder({ context, httpStatus: 429, body: null });
const inactiveProvider = interpretOpenSeaExactOrderObservation({ context, observation: inactiveObservation });
const rateProvider = interpretOpenSeaExactOrderObservation({ context, observation: rateObservation });
assert.equal(inactiveProvider.status, "INACTIVE_CONFIRMED");
assert.equal(rateProvider.status, "RATE_LIMITED");

// Capture real worker/store transitions once. No hand-written ProviderResult combinations.
async function capture(mode: "stable" | "retry" | "exhausted" | "reconciliation" | "stale" | "execution") {
  const store = new InMemoryTargetedVerifierAttemptStore();
  const stages = new Map<string, OperationalAttemptRecord>();
  const save = store.saveResponse.bind(store);
  store.saveResponse = async (id, token, record, at) => {
    const ok = await save(id, token, record, at);
    if (ok) stages.set(record.lifecycle, (await store.get(id))!);
    return ok;
  };
  const claim = store.claim.bind(store);
  store.claim = async (...args) => {
    const result = await claim(...args);
    if (result) stages.set("REQUEST_PENDING", result.record);
    return result;
  };
  const post = mode === "reconciliation"
    ? { watermark: { eventId: "101", receivedAt: "2026-01-01T00:02:00.000Z" }, relevantOrderFingerprint: eventFingerprint([{ eventId: "101", eventType: "item_sold", orderHash, eventVersion: "1" }], orderHash) }
    : context.preVerification;
  const options = {
    store, now: () => NOW, nowMs: () => 0,
    credentialProvider: async () => { if (mode === "execution") throw new Error("SYNTHETIC_CREDENTIAL_FAILURE"); return "synthetic-key"; },
    execute: async () => mode === "retry" || mode === "exhausted" ? rateObservation : inactiveObservation,
    policy: { maxAttempts: mode === "retry" ? 2 : 1 }
  };
  const worker = mode === "stale"
    ? __createTargetedVerifierOperationalWorkerForTest({ ...options, postFence: async () => ({ valid: false, status: "STALE", postVerification: post, reasonCodes: inactiveProvider.reasonCodes }) })
    : createTargetedVerifierOperationalWorker({ ...options, snapshotReader: { readSnapshot: async () => post } });
  const initial = await worker.createAttempt({ context, preVerification: context.preVerification, createdAt: NOW });
  stages.set("NOT_STARTED", initial);
  const run = await worker.runOnce(initial.attemptId);
  assert.equal(run.outcome, mode === "retry" ? "RETRY_SCHEDULED" : ["reconciliation", "stale", "execution"].includes(mode) ? "FAILED" : "COMPLETE");
  stages.set("final", (await store.get(initial.attemptId))!);
  return stages;
}
const stableStages = await capture("stable");
const retryStages = await capture("retry");
const exhaustedStages = await capture("exhausted");
const reconciliationStages = await capture("reconciliation");
const staleStages = await capture("stale");
const executionStages = await capture("execution");
const uncertainStore = new InMemoryTargetedVerifierAttemptStore({ records: [stableStages.get("NOT_STARTED")!] });
await uncertainStore.claim(stableStages.get("NOT_STARTED")!.attemptId, "expired-owner", NOW, 1);
await uncertainStore.reclaimExpired("2026-01-01T00:00:00.002Z");
const uncertainTemplate = (await uncertainStore.get(stableStages.get("NOT_STARTED")!.attemptId))!;

// Labels identify test cases only. Every fixture retains the trusted scope/sweep/artifacts;
// distinct attempt numbers are bound by both unchanged production identity algorithms.
const fixtureNumbers = new Map<string, number>();
function numberFor(id: string): number {
  if (!fixtureNumbers.has(id)) fixtureNumbers.set(id, fixtureNumbers.size);
  return fixtureNumbers.get(id)!;
}
function fixtureId(id: string) { return attemptIdentity(context, numberFor(id)); }
function fromStage(id: string, template: OperationalAttemptRecord): OperationalAttemptRecord {
  const attemptNumber = numberFor(id);
  const record = { ...structuredClone(template), attemptNumber,
    attemptId: attemptIdentity(context, attemptNumber),
    idempotencyKey: operationalIdempotencyKey(context, attemptNumber),
    leaseToken: null, leaseExpiresAt: null };
  assert.equal(record.attemptId, sha256Canonical(canonicalAttemptMaterial(record)));
  return record.semanticEvidenceHash === null ? record : { ...record, semanticEvidenceHash: operationalSemanticEvidenceHash(record) };
}
const validNotStartedRecord = (id = "a") => fromStage(id, stableStages.get("NOT_STARTED")!);
const validRequestPendingRecord = (id: string) => fromStage(id, stableStages.get("REQUEST_PENDING")!);
const validResponseObservedRecord = (id: string, retryable = false) => fromStage(id, (retryable ? retryStages : stableStages).get("RESPONSE_OBSERVED")!);
const validPendingFenceRecord = (id: string, retryable = false) => fromStage(id, (retryable ? retryStages : stableStages).get("PENDING_FENCE")!);
const validCompleteRecord = (id: string, exhausted = false) => fromStage(id, (exhausted ? exhaustedStages : stableStages).get("final")!);
const validRequestOutcomeUncertainRecord = (id: string) => fromStage(id, uncertainTemplate);
const validExecutionFailedRecord = (id: string) => fromStage(id, executionStages.get("final")!);
const validRetryScheduledRecord = (id: string) => fromStage(id, retryStages.get("final")!);
const validStaleRecord = (id: string) => fromStage(id, staleStages.get("final")!);
const validReconciliationRequiredRecord = (id: string) => fromStage(id, reconciliationStages.get("final")!);
function rec(id = "a", lifecycle: OperationalAttemptRecord["lifecycle"] = "NOT_STARTED") {
  switch (lifecycle) {
    case "NOT_STARTED": return validNotStartedRecord(id);
    case "REQUEST_PENDING": return validRequestPendingRecord(id);
    case "RESPONSE_OBSERVED": return validResponseObservedRecord(id);
    case "PENDING_FENCE": return validPendingFenceRecord(id);
    case "COMPLETE": return validCompleteRecord(id);
    case "FAILED": return validExecutionFailedRecord(id);
  }
}

type Row={payload:OperationalAttemptRecord;lifecycle:string;claimedAt:string|null;leaseExpiresAt:string|null;leaseToken:string|null;nextAttemptAt:string|null;failureClassification:string|null};
const clone=<T>(x:T):T=>JSON.parse(JSON.stringify(x));
class AttemptDb implements DbPool{
 rows=new Map<string,Row>(); sql:string[]=[];
 resolve(id:string){return this.rows.get(id) ?? this.rows.get(fixtureId(id));}
 async end(){} async connect():Promise<TransactionClient>{return {release(){},query:(q,v)=>this.query(q,v)}}
 private out<T>(rows:T[],rowCount=rows.length):QueryResult<T>{return {rows,rowCount};}
 async query<T=unknown>(q:string,v?:readonly unknown[]):Promise<QueryResult<T>>{const l=q.toLowerCase();this.sql.push(q);
  if(l.startsWith("insert into public.targeted_verifier_attempts")){const p=JSON.parse(String(v?.[11])) as OperationalAttemptRecord;const old=[...this.rows.values()].find(x=>x.payload.idempotencyKey===p.idempotencyKey);if(old)return this.out([{payload:clone(old.payload)} as T]);this.rows.set(p.attemptId,{payload:clone(p),lifecycle:p.lifecycle,claimedAt:p.claimedAt,leaseExpiresAt:p.leaseExpiresAt,leaseToken:p.leaseToken,nextAttemptAt:p.nextAttemptAt,failureClassification:p.failureClassification});return this.out([{payload:clone(p)} as T]);}
  if(l.startsWith("select payload from public.targeted_verifier_attempts where ((")){const now=Date.parse(String(v?.[0]));const rows=[...this.rows.values()].filter(r=>{const leaseFree=!r.leaseToken||!r.leaseExpiresAt||Date.parse(r.leaseExpiresAt)<=now;if(r.lifecycle==="NOT_STARTED")return (!r.nextAttemptAt||Date.parse(r.nextAttemptAt)<=now)&&leaseFree;if(r.lifecycle==="RESPONSE_OBSERVED"||r.lifecycle==="PENDING_FENCE")return leaseFree;return false;}).slice(0,Number(v?.[1]??99)).map(r=>({payload:clone(r.payload)} as T));return this.out(rows);}
  if(l.startsWith("select payload")){const r=this.resolve(String(v?.[0]));return this.out(r?[{payload:clone(r.payload)} as T]:[]);}
  if(l.startsWith("update public.targeted_verifier_attempts set lifecycle=case when lifecycle='request_pending'")){let n=0;const now=Date.parse(String(v?.[0]));for(const r of this.rows.values()){if(!r.leaseExpiresAt||Date.parse(r.leaseExpiresAt)>now||!["REQUEST_PENDING","RESPONSE_OBSERVED","PENDING_FENCE"].includes(r.lifecycle))continue;const old=r.lifecycle;r.lifecycle=old==="REQUEST_PENDING"?"FAILED":old;r.failureClassification=old==="REQUEST_PENDING"?"REQUEST_OUTCOME_UNCERTAIN":r.failureClassification;r.leaseToken=null;r.leaseExpiresAt=null;r.payload={...r.payload,lifecycle:r.lifecycle as OperationalAttemptRecord["lifecycle"],failureClassification:r.failureClassification,leaseToken:null,leaseExpiresAt:null};n++;}return this.out([],n);}
  if(l.startsWith("update public.targeted_verifier_attempts set lifecycle=case")){const r=this.resolve(String(v?.[0]));if(!r)return this.out([]);const now=Date.parse(String(v?.[1]));const dueNow=(!r.nextAttemptAt||Date.parse(r.nextAttemptAt)<=now);const leaseFree=!r.leaseToken||!r.leaseExpiresAt||Date.parse(r.leaseExpiresAt)<=now;const runnable=(r.lifecycle==="NOT_STARTED"&&dueNow&&leaseFree)||( (r.lifecycle==="RESPONSE_OBSERVED"||r.lifecycle==="PENDING_FENCE")&&leaseFree);if(!runnable)return this.out([]);const token=String(v?.[3]);r.lifecycle=r.lifecycle==="NOT_STARTED"?"REQUEST_PENDING":r.lifecycle;r.claimedAt=String(v?.[1]);r.leaseExpiresAt=String(v?.[2]);r.leaseToken=token;r.payload={...r.payload,lifecycle:r.lifecycle as OperationalAttemptRecord["lifecycle"],claimedAt:r.claimedAt,leaseExpiresAt:r.leaseExpiresAt,leaseToken:token,verificationStartedAt:r.payload.verificationStartedAt??r.claimedAt};return this.out([{payload:clone(r.payload)} as T]);}
  if(l.startsWith("update public.targeted_verifier_attempts set lifecycle=$3")){const r=this.resolve(String(v?.[0]));const now=Date.parse(String(v?.[9]));if(!r||!(r.lifecycle==="REQUEST_PENDING"||r.lifecycle==="RESPONSE_OBSERVED"||r.lifecycle==="PENDING_FENCE")||r.leaseToken!==String(v?.[1])||!r.leaseExpiresAt||Date.parse(r.leaseExpiresAt)<=now)return this.out([],0);const p=JSON.parse(String(v?.[3])) as OperationalAttemptRecord;r.payload=clone(p);r.lifecycle=p.lifecycle;r.claimedAt=p.claimedAt;r.leaseExpiresAt=p.leaseExpiresAt;r.leaseToken=p.leaseToken;r.nextAttemptAt=p.nextAttemptAt;r.failureClassification=p.failureClassification;return this.out([],1);}
  throw new Error("UNSUPPORTED_SQL:"+q);
 }}

const parity=(db:AttemptDb,id:string)=>{const r=db.resolve(id);assert.ok(r);assert.equal(r.lifecycle,r.payload.lifecycle);assert.equal(r.claimedAt,r.payload.claimedAt);assert.equal(r.leaseExpiresAt,r.payload.leaseExpiresAt);assert.equal(r.leaseToken,r.payload.leaseToken);assert.equal(r.nextAttemptAt,r.payload.nextAttemptAt);assert.equal(r.failureClassification,r.payload.failureClassification);};
const evidence=(r:OperationalAttemptRecord)=>({providerObservedAt:r.providerObservedAt,httpStatus:r.httpStatus,transportOutcome:r.transportOutcome,responseBodySha256:r.responseBodySha256,rawResponseArtifactHash:r.rawResponseArtifactHash,normalizedProviderStatus:r.normalizedProviderStatus,providerResultStatus:r.providerResultStatus,providerReasonCodes:r.providerReasonCodes,providerResultReasonCodes:r.providerResultReasonCodes,normalizedOrder:r.normalizedOrder,retry:r.retry,preVerificationWatermark:r.preVerificationWatermark,preRelevantFingerprint:r.preRelevantFingerprint});
test("Postgres attempt store create/get/claim/CAS parity", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db), r = validNotStartedRecord("a");
  assert.deepEqual(await s.createOrGet(r), r);
  assert.deepEqual(await s.createOrGet({ ...r, providerResultStatus: "MUTATED" } as OperationalAttemptRecord), r);
  parity(db, "a");
  const c = await s.claim(r.attemptId, "w", NOW, 1000); assert.ok(c); parity(db, "a");
  const before = clone(await s.get(r.attemptId)), complete = validCompleteRecord("a");
  assert.equal(await s.complete(r.attemptId, "wrong", complete, "2026-01-01T00:00:00.100Z"), false);
  assert.deepEqual(await s.get(r.attemptId), before);
  assert.equal(await s.complete(r.attemptId, c.leaseToken, complete, "2026-01-01T00:00:00.100Z"), true);
  assert.deepEqual(await s.get(r.attemptId), complete); parity(db, "a");
});
test("Postgres recovery/reclaim/CAS transitions preserve evidence and retry", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  const rich = { ...validResponseObservedRecord("o", true), leaseToken: "old", leaseExpiresAt: "2025-12-31T23:59:00.000Z" };
  await s.createOrGet(rich);
  const ev = evidence(rich), c = await s.claim(rich.attemptId, "new", NOW, 1000); assert.ok(c);
  assert.deepEqual(evidence((await s.get(rich.attemptId))!), ev); parity(db, "o");
  assert.equal(await s.saveResponse(rich.attemptId, "bad", rich, "2026-01-01T00:00:00.100Z"), false);
  assert.equal(await s.saveResponse(rich.attemptId, c.leaseToken, c.record, "2026-01-01T00:00:00.100Z"), true);
  parity(db, "o"); assert.deepEqual((await s.get(rich.attemptId))?.retry, rich.retry);
  const p = { ...validPendingFenceRecord("p", true), leaseToken: "p", leaseExpiresAt: "2026-01-01T00:00:10.000Z" };
  await s.createOrGet(p);
  assert.equal(await s.reclaimExpired("2026-01-01T00:00:11.000Z"), 2);
  for (const r of [rich, p]) { const after = await s.get(r.attemptId); assert.ok(after); assert.deepEqual(evidence(after), evidence(r)); parity(db, r.attemptId); }
  assert.equal((await s.get(p.attemptId))?.lifecycle, "PENDING_FENCE");
});
test("Postgres recovery claims preserve lifecycle, evidence and original verification time", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  for (const r of [validResponseObservedRecord("ro", true), validPendingFenceRecord("pf")]) {
    await s.createOrGet(r); const c = await s.claim(r.attemptId, "recover", NOW, 1000); assert.ok(c);
    assert.equal(c.record.lifecycle, r.lifecycle);
    assert.equal(c.record.verificationStartedAt, r.verificationStartedAt);
    assert.deepEqual(evidence(c.record), evidence(r)); parity(db, r.attemptId);
  }
});
test("Postgres listDue excludes active recovery leases",async()=>{const db=new AttemptDb();const s=new PostgresTargetedVerifierAttemptStore(db);await s.createOrGet(rec("n"));await s.createOrGet(rec("o","RESPONSE_OBSERVED"));await s.createOrGet(rec("p","PENDING_FENCE"));assert.ok(await s.claim("o","w","2026-01-01T00:00:00.000Z",100000));const ids=(await s.listDue("2026-01-01T00:00:01.000Z",10)).map(x=>x.attemptId).sort();assert.deepEqual(ids,[sha256Canonical(canonicalAttemptMaterial(rec("n"))),sha256Canonical(canonicalAttemptMaterial(rec("p")))].sort());});
test("Postgres listDue full lifecycle matrix",async()=>{const db=new AttemptDb();const s=new PostgresTargetedVerifierAttemptStore(db);const rows=[{id:"n-due",l:"NOT_STARTED" as const},{id:"n-future",l:"NOT_STARTED" as const,next:"2026-01-02T00:00:00.000Z"},{id:"n-active",l:"NOT_STARTED" as const,token:"a",expiry:"2026-01-01T01:00:00.000Z"},{id:"n-expired",l:"NOT_STARTED" as const,token:"b",expiry:"2025-12-31T23:00:00.000Z"},{id:"o-free",l:"RESPONSE_OBSERVED" as const},{id:"o-active",l:"RESPONSE_OBSERVED" as const,token:"c",expiry:"2026-01-01T01:00:00.000Z"},{id:"o-expired",l:"RESPONSE_OBSERVED" as const,token:"d",expiry:"2025-12-31T23:00:00.000Z"},{id:"o-future",l:"RESPONSE_OBSERVED" as const,next:"2026-01-02T00:00:00.000Z"},{id:"p-free",l:"PENDING_FENCE" as const},{id:"p-active",l:"PENDING_FENCE" as const,token:"e",expiry:"2026-01-01T01:00:00.000Z"},{id:"p-expired",l:"PENDING_FENCE" as const,token:"f",expiry:"2025-12-31T23:00:00.000Z"},{id:"p-future",l:"PENDING_FENCE" as const,next:"2026-01-02T00:00:00.000Z"}];for(const x of rows){await s.createOrGet({...rec(x.id,x.l),nextAttemptAt:x.next??null,leaseToken:x.token??null,leaseExpiresAt:x.expiry??null});}const ids=(await s.listDue("2026-01-01T00:00:00.000Z",20)).map(x=>x.attemptId).sort();assert.deepEqual(ids,["n-due","n-expired","o-expired","o-free","o-future","p-expired","p-free","p-future"].map(id=>sha256Canonical(canonicalAttemptMaterial(rec(id)))).sort());});
test("REQUEST_PENDING expiry fails closed in indexed and payload state",async()=>{const db=new AttemptDb();const s=new PostgresTargetedVerifierAttemptStore(db);const r=rec("u","REQUEST_PENDING");r.leaseToken="u-token";r.leaseExpiresAt="2026-01-01T00:00:00.100Z";r.claimedAt="2026-01-01T00:00:00.000Z";await s.createOrGet(r);assert.equal(await s.reclaimExpired("2026-01-01T00:00:01.000Z"),1);const got=await s.get("u");assert.equal(got?.lifecycle,"FAILED");assert.equal(got?.failureClassification,"REQUEST_OUTCOME_UNCERTAIN");assert.equal(got?.leaseToken,null);assert.equal(got?.leaseExpiresAt,null);parity(db,"u");});
test("Postgres CAS expiry, takeover, fail and retry parity", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  const observed = validResponseObservedRecord("x", true); await s.createOrGet(observed);
  const a = await s.claim(observed.attemptId, "a", NOW, 1000); assert.ok(a);
  const before = clone(await s.get(observed.attemptId));
  assert.equal(await s.fail(observed.attemptId, a.leaseToken, validRetryScheduledRecord("x"), "2026-01-01T00:00:01.000Z"), false);
  assert.deepEqual(await s.get(observed.attemptId), before);
  const b = await s.claim(observed.attemptId, "b", "2026-01-01T00:00:01.001Z", 1000); assert.ok(b);
  assert.equal(await s.complete(observed.attemptId, a.leaseToken, validCompleteRecord("x", true), "2026-01-01T00:00:01.100Z"), false);
  assert.equal(await s.scheduleRetry(observed.attemptId, b.leaseToken, { ...b.record, nextAttemptAt: "2026-01-01T00:10:00.000Z" }, "2026-01-01T00:00:01.100Z"), true);
  assert.deepEqual(evidence((await s.get(observed.attemptId))!), evidence(observed)); parity(db, "x");
});
test("Postgres successful fail clears both lease representations", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  const initial = validNotStartedRecord("f"); await s.createOrGet(initial);
  const c = await s.claim(initial.attemptId, "w", NOW, 1000); assert.ok(c);
  const failed = validExecutionFailedRecord("f");
  assert.equal(await s.fail(initial.attemptId, c.leaseToken, failed, "2026-01-01T00:00:00.100Z"), true);
  const got = await s.get(initial.attemptId); assert.ok(got);
  assert.equal(got.lifecycle, "FAILED"); assert.equal(got.failureClassification, "EXECUTION_FAILED");
  assert.equal(got.leaseToken, null); assert.equal(got.leaseExpiresAt, null);
  assert.equal(got.providerResultStatus, null); assert.equal(got.finalResultStatus, null);
  assert.deepEqual(got, failed); parity(db, "f");
});
test("Postgres rejects future NOT_STARTED and terminal claims", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  const future = { ...validNotStartedRecord("future"), nextAttemptAt: "2026-01-02T00:00:00.000Z" };
  await s.createOrGet(future); assert.equal(await s.claim(future.attemptId, "w", NOW, 1000), null);
  for (const r of [validCompleteRecord("complete"), validExecutionFailedRecord("failed")]) {
    await s.createOrGet(r); assert.equal(await s.claim(r.attemptId, "w", NOW, 1000), null);
    assert.deepEqual(await s.get(r.attemptId), r);
  }
});
test("Postgres CAS rejects matching-token terminal current rows", async () => {
  for (const terminal of [validCompleteRecord("terminal-complete"), validExecutionFailedRecord("terminal-failed")]) {
    const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
    // Deliberate current-row ownership fault: semantic state is valid; terminal lease
    // is retained in raw storage to prove the SQL lifecycle predicate independently.
    const r = { ...terminal, leaseToken: "terminal-token", leaseExpiresAt: "2026-01-01T01:00:00.000Z" };
    db.rows.set(r.attemptId, { payload: clone(r), lifecycle: r.lifecycle, claimedAt: r.claimedAt, leaseExpiresAt: r.leaseExpiresAt, leaseToken: r.leaseToken, nextAttemptAt: r.nextAttemptAt, failureClassification: r.failureClassification });
    const before = clone(await s.get(r.attemptId));
    const proposed = { ...validResponseObservedRecord(r.attemptId === fixtureId("terminal-complete") ? "terminal-complete" : "terminal-failed"), leaseToken: r.leaseToken, leaseExpiresAt: r.leaseExpiresAt };
    assert.ok(Date.parse(r.leaseExpiresAt) > Date.parse(NOW));
    assert.equal(await s.saveResponse(r.attemptId, "terminal-token", proposed, NOW), false);
    assert.deepEqual(await s.get(r.attemptId), before); parity(db, r.attemptId);
  }
});
test("Postgres RESPONSE_OBSERVED reclaim preserves rich provider evidence", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  const r = { ...validResponseObservedRecord("rich-observed"), leaseToken: "lease", leaseExpiresAt: "2026-01-01T00:00:00.100Z" };
  await s.createOrGet(r);
  assert.equal(r.providerResultStatus, "INACTIVE_CONFIRMED");
  assert.ok(r.normalizedOrder); assert.ok(r.responseBodySha256); assert.ok(r.rawResponseArtifactHash);
  assert.equal(await s.reclaimExpired("2026-01-01T00:00:01.000Z"), 1);
  const after = await s.get(r.attemptId); assert.ok(after);
  assert.equal(after.lifecycle, "RESPONSE_OBSERVED"); assert.equal(after.leaseToken, null); assert.equal(after.leaseExpiresAt, null);
  assert.deepEqual(evidence(after), evidence(r)); assert.equal(after.verificationStartedAt, r.verificationStartedAt);
  assert.equal(after.failureClassification, null); parity(db, r.attemptId);
});
test("Postgres PENDING_FENCE reclaim preserves rich provider and fence evidence", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  const r = { ...validPendingFenceRecord("rich-fence"), leaseToken: "lease", leaseExpiresAt: "2026-01-01T00:00:00.100Z" };
  await s.createOrGet(r);
  assert.equal(await s.reclaimExpired("2026-01-01T00:00:01.000Z"), 1);
  const after = await s.get(r.attemptId); assert.ok(after);
  assert.equal(after.lifecycle, "PENDING_FENCE"); assert.equal(after.leaseToken, null); assert.equal(after.leaseExpiresAt, null);
  assert.deepEqual(evidence(after), evidence(r));
  assert.equal(after.verificationStartedAt, r.verificationStartedAt);
  assert.deepEqual(after.preVerificationWatermark, r.preVerificationWatermark);
  assert.deepEqual(after.preRelevantFingerprint, r.preRelevantFingerprint);
  assert.equal(after.finalResultStatus, null); assert.equal(after.semanticEvidenceHash, null);
  assert.equal(after.postVerificationWatermark, null); assert.equal(after.postRelevantFingerprint, null);
  parity(db, r.attemptId);
});

test("Postgres legacy payload policy and non-null final status parity", async () => {
  const db = new AttemptDb(), s = new PostgresTargetedVerifierAttemptStore(db);
  const put = (id: string, payload: OperationalAttemptRecord) => db.rows.set(id, { payload: clone(payload), lifecycle: payload.lifecycle, claimedAt: payload.claimedAt, leaseExpiresAt: payload.leaseExpiresAt, leaseToken: payload.leaseToken, nextAttemptAt: payload.nextAttemptAt, failureClassification: payload.failureClassification });
  const base = validNotStartedRecord("legacy");
  const { finalResultStatus: _missing, ...legacy } = base;
  put("legacy", legacy as OperationalAttemptRecord);
  assert.equal((await s.get("legacy"))?.finalResultStatus, null);
  put("hashed", { ...legacy, semanticEvidenceHash: "b".repeat(64) } as OperationalAttemptRecord);
  await assert.rejects(() => s.get("hashed"), /LEGACY_OPERATIONAL_SEMANTIC_HASH_INCOMPATIBLE/);
  const current = validReconciliationRequiredRecord("current");
  await s.createOrGet(current); const loaded = await s.get(current.attemptId); assert.ok(loaded);
  assert.equal(loaded.providerResultStatus, "INACTIVE_CONFIRMED");
  assert.equal(loaded.finalResultStatus, "RECONCILIATION_REQUIRED");
  assert.equal(loaded.semanticEvidenceHash, operationalSemanticEvidenceHash(loaded)); parity(db, current.attemptId);
  // Mutate one semantic field without recomputing the stored hash.
  put("tampered", { ...current, reasonCodes: [...current.reasonCodes, "HTTP_429"].sort() });
  await assert.rejects(() => s.get("tampered"), /OPERATIONAL_SEMANTIC_HASH_MISMATCH/);
  put("bad-hash", { ...current, semanticEvidenceHash: "z" });
  await assert.rejects(() => s.get("bad-hash"), /INVALID_OPERATIONAL_SEMANTIC_HASH/);
  put("no-hash", { ...current, semanticEvidenceHash: null });
  await assert.rejects(() => s.get("no-hash"), /INVALID_OPERATIONAL_RECORD/);
  put("hash-no-final", { ...current, finalResultStatus: null });
  await assert.rejects(() => s.get("hash-no-final"), /INVALID_OPERATIONAL_RECORD/);
});

test("strict operational admission rejects partial and malformed durable records",async()=>{const base=rec("strict");const malformed:unknown[]=[{}, {finalResultStatus:null,semanticEvidenceHash:null}, {...base,attemptId:undefined}, {...base,attemptNumber:-1}, {...base,lifecycle:"BROKEN"}, {...base,authorityGranted:true}, {...base,deactivationAuthorityGranted:true}, {...base,transportOutcome:"BROKEN"}, {...base,createdAt:"not-a-time"}, {...base,expectedIdentity:null}, {...base,requestIdentity:null}, {...base,retry:{retryable:"yes"}}, {...base,preVerificationWatermark:null}, {...base,preRelevantFingerprint:null}, {...base,reasonCodes:{bad:true}}, {...base,failureClassification:"UNKNOWN_FAILURE"}];for(const value of malformed){assert.throws(()=>new InMemoryTargetedVerifierAttemptStore({records:[value as OperationalAttemptRecord]}),/INVALID_OPERATIONAL_RECORD|INVALID_FINAL_RESULT_STATUS|LEGACY_OPERATIONAL_SEMANTIC_HASH_INCOMPATIBLE/);const db=new AttemptDb();const store=new PostgresTargetedVerifierAttemptStore(db);await assert.rejects(()=>store.createOrGet(value as OperationalAttemptRecord),/INVALID_OPERATIONAL_RECORD|INVALID_FINAL_RESULT_STATUS|LEGACY_OPERATIONAL_SEMANTIC_HASH_INCOMPATIBLE/);}});
test("semantic durable identity and journal bindings reject malformed current records",async()=>{const base=rec("semantic");const malformed:unknown[]=[{...base,candidateModelVersion:"wrong"},{...base,generationModelVersion:"wrong"},{...base,verifierSchemaVersion:"wrong"},{...base,verifierPolicyVersion:"wrong"},{...base,providerContractVersion:"wrong"},{...base,normalizerVersion:"wrong"},{...base,requestIdentity:{...base.requestIdentity,orderHash:"0x"+"b".repeat(64)}},{...base,requestIdentity:{...base.requestIdentity,endpointPath:"/wrong"}},{...base,requestIdentity:{...base.requestIdentity,protocolAddress:"bad"}},{...base,expectedIdentity:{...base.expectedIdentity,orderHash:"0x"+"b".repeat(64)}},{...base,expectedIdentity:{...base.expectedIdentity,tokenId:"01"}},{...base,expectedIdentity:{...base.expectedIdentity,protocolAddress:"bad"}},{...base,preRelevantFingerprint:{...base.preRelevantFingerprint,orderHash:"0x"+"b".repeat(64)}},{...base,preVerificationWatermark:{eventId:"x",receivedAt:base.createdAt}},{...base,postVerificationWatermark:{eventId:"1",receivedAt:base.createdAt}},{...base,postRelevantFingerprint:{...base.preRelevantFingerprint,eventIds:["1"],events:[]}},{...base,reasonCodes:{bad:true}},{...base,extraField:"reject"}];for(const value of malformed){assert.throws(()=>new InMemoryTargetedVerifierAttemptStore({records:[value as OperationalAttemptRecord]}));}const db=new AttemptDb();const store=new PostgresTargetedVerifierAttemptStore(db);const raw={...base,requestIdentity:{...base.requestIdentity,orderHash:"0x"+"b".repeat(64)}};db.rows.set("raw-semantic",{payload:clone(raw) as OperationalAttemptRecord,lifecycle:raw.lifecycle,claimedAt:raw.claimedAt,leaseExpiresAt:raw.leaseExpiresAt,leaseToken:raw.leaseToken,nextAttemptAt:raw.nextAttemptAt,failureClassification:raw.failureClassification});await assert.rejects(()=>store.get("raw-semantic"),/INVALID_OPERATIONAL_RECORD/);});
test("canonical-looking but non-derived attempt identities fail durable admission",async()=>{const base=rec("identity");const wrongAttempt={...base,sweepId:"different",attemptId:"a".repeat(64)};assert.throws(()=>new InMemoryTargetedVerifierAttemptStore({records:[wrongAttempt]}),/INVALID_OPERATIONAL_RECORD/);const db=new AttemptDb();const store=new PostgresTargetedVerifierAttemptStore(db);db.rows.set("identity-raw",{payload:clone(wrongAttempt),lifecycle:wrongAttempt.lifecycle,claimedAt:wrongAttempt.claimedAt,leaseExpiresAt:wrongAttempt.leaseExpiresAt,leaseToken:wrongAttempt.leaseToken,nextAttemptAt:wrongAttempt.nextAttemptAt,failureClassification:wrongAttempt.failureClassification});await assert.rejects(()=>store.get("identity-raw"),/INVALID_OPERATIONAL_RECORD/);});

function providerProjection(record: OperationalAttemptRecord) {
  return {
    status: record.providerResultStatus, providerStatus: record.normalizedProviderStatus,
    normalizedOrder: record.normalizedOrder, observedAt: record.providerObservedAt,
    httpStatus: record.httpStatus, responseBodySha256: record.responseBodySha256,
    rawResponseArtifactHash: record.rawResponseArtifactHash, reasonCodes: record.providerResultReasonCodes,
    retry: record.retry, authorityGranted: record.authorityGranted,
    deactivationAuthorityGranted: record.deactivationAuthorityGranted
  };
}

test("observed fixture provider projections rehydrate exactly from trusted normalization", () => {
  for (const [record, original] of [
    [validResponseObservedRecord("provider-inactive"), inactiveProvider],
    [validResponseObservedRecord("provider-rate", true), rateProvider]
  ] as const) {
    const serialized = providerProjection(record);
    assert.equal(validateProviderResult(serialized), false);
    const recovered = rehydrateProviderResult(serialized);
    assert.equal(validateProviderResult(recovered), true);
    assert.equal(validateProviderResult(serialized), false);
    assert.deepEqual(recovered, original);
    assert.deepEqual(record.providerReasonCodes, recovered.reasonCodes);
    assert.deepEqual(record.providerResultReasonCodes, recovered.reasonCodes);
    assert.deepEqual(record.reasonCodes, recovered.reasonCodes);
    assert.equal(record.finalResultStatus, null);
    assert.equal(record.semanticEvidenceHash, null);
    assert.equal(record.postVerificationWatermark, null);
    assert.equal(record.postRelevantFingerprint, null);
    assert.equal(record.failureClassification, null);
  }
  assert.deepEqual(inactiveProvider.reasonCodes, []);
  assert.equal(inactiveProvider.providerStatus, "INACTIVE");
  assert.equal(inactiveProvider.retry.retryable, false);
  assert.equal(rateProvider.retry.retryable, true);
});

const validFamilies = [
  ["NOT_STARTED", validNotStartedRecord],
  ["REQUEST_PENDING", validRequestPendingRecord],
  ["RESPONSE_OBSERVED", validResponseObservedRecord],
  ["PENDING_FENCE", validPendingFenceRecord],
  ["COMPLETE", validCompleteRecord],
  ["RETRY_EXHAUSTED", (id: string) => validCompleteRecord(id, true)],
  ["REQUEST_OUTCOME_UNCERTAIN", validRequestOutcomeUncertainRecord],
  ["EXECUTION_FAILED", validExecutionFailedRecord],
  ["RETRY_SCHEDULED", validRetryScheduledRecord],
  ["STALE", validStaleRecord],
  ["RECONCILIATION_REQUIRED", validReconciliationRequiredRecord]
] as const;
for (const [family, build] of validFamilies) {
  test("worker-reachable " + family + " fixture survives InMemory and PostgreSQL admission", async () => {
    const record = build("positive-" + family);
    const memory = new InMemoryTargetedVerifierAttemptStore({ records: [record] });
    assert.deepEqual(await memory.get(record.attemptId), record);
    const db = new AttemptDb(), postgres = new PostgresTargetedVerifierAttemptStore(db);
    assert.deepEqual(await postgres.createOrGet(record), record);
    const durable = await postgres.get(record.attemptId); assert.ok(durable);
    assert.deepEqual(durable, record); parity(db, record.attemptId);
    assert.equal(durable.attemptId, attemptIdentity(context, durable.attemptNumber));
    assert.equal(durable.idempotencyKey, operationalIdempotencyKey(context, durable.attemptNumber));
    assert.equal(durable.authorityGranted, false);
    assert.equal(durable.deactivationAuthorityGranted, false);
    if (durable.providerResultStatus !== null) {
      assert.equal(validateProviderResult(rehydrateProviderResult(providerProjection(durable))), true);
      assert.deepEqual(durable.providerReasonCodes, durable.providerResultReasonCodes);
    }
    if (durable.semanticEvidenceHash !== null) {
      assert.equal(durable.semanticEvidenceHash, operationalSemanticEvidenceHash(durable));
      assert.ok(durable.postVerificationWatermark); assert.ok(durable.postRelevantFingerprint);
    }
    if (family === "RETRY_SCHEDULED" || family === "RETRY_EXHAUSTED") {
      assert.equal(durable.retry.retryable, true);
      assert.equal(durable.finalResultStatus, durable.providerResultStatus);
      assert.equal(durable.failureClassification, family);
      assert.equal(durable.lifecycle, family === "RETRY_SCHEDULED" ? "FAILED" : "COMPLETE");
    }
  });
}

const observed = validResponseObservedRecord("negative-observed");
const pending = validPendingFenceRecord("negative-pending");
const complete = validCompleteRecord("negative-complete");
const scheduled = validRetryScheduledRecord("negative-scheduled");
const malformedStates: readonly [string, OperationalAttemptRecord][] = [
  ["RESPONSE_OBSERVED without provider", { ...observed, providerResultStatus: null }],
  ["PENDING_FENCE without provider", { ...pending, providerResultStatus: null }],
  ["RESPONSE_OBSERVED with final result", { ...observed, finalResultStatus: "INACTIVE_CONFIRMED" }],
  ["PENDING_FENCE with hash", { ...pending, semanticEvidenceHash: "a".repeat(64) }],
  ["COMPLETE without provider", { ...complete, providerResultStatus: null }],
  ["COMPLETE without final result", { ...complete, finalResultStatus: null }],
  ["COMPLETE without hash", { ...complete, semanticEvidenceHash: null }],
  ["COMPLETE without post watermark", { ...complete, postVerificationWatermark: null }],
  ["COMPLETE without post fingerprint", { ...complete, postRelevantFingerprint: null }],
  ["COMPLETE with RETRY_SCHEDULED", { ...complete, failureClassification: "RETRY_SCHEDULED" }],
  ["FAILED without classification", { ...validExecutionFailedRecord("negative-failed"), failureClassification: null }],
  ["RETRY_SCHEDULED without provider", { ...scheduled, providerResultStatus: null }],
  ["RETRY_SCHEDULED without final result", { ...scheduled, finalResultStatus: null }],
  ["REQUEST_OUTCOME_UNCERTAIN with provider", { ...observed, lifecycle: "FAILED", failureClassification: "REQUEST_OUTCOME_UNCERTAIN" }],
  ["EXECUTION_FAILED with provider", { ...observed, lifecycle: "FAILED", failureClassification: "EXECUTION_FAILED" }],
  ["STALE without post evidence", { ...validStaleRecord("negative-stale"), postVerificationWatermark: null, postRelevantFingerprint: null }],
  ["RECONCILIATION_REQUIRED without hash", { ...validReconciliationRequiredRecord("negative-reconciliation"), semanticEvidenceHash: null }],
  ["invalid confirmed provider projection with empty reasons", { ...observed, normalizedOrder: null }],
  ["provider reason mismatch from empty", { ...observed, providerResultReasonCodes: ["HTTP_429"] }],
  ["provider reason mismatch to empty", { ...observed, providerReasonCodes: ["HTTP_429"] }],
  ["wrong canonical attempt identity", { ...observed, attemptId: "f".repeat(64) }],
  ["wrong canonical idempotency identity", { ...observed, idempotencyKey: "f".repeat(64) }]
];
for (const [name, record] of malformedStates) {
  test("strict durable matrix rejects " + name + " in memory and raw PostgreSQL decode", async () => {
    assert.throws(() => new InMemoryTargetedVerifierAttemptStore({ records: [record] }), /INVALID_OPERATIONAL_RECORD/);
    const db = new AttemptDb(), postgres = new PostgresTargetedVerifierAttemptStore(db);
    // Deliberately inject the invalid payload, bypassing createOrGet to exercise raw get/decode.
    db.rows.set(record.attemptId, { payload: clone(record), lifecycle: record.lifecycle,
      claimedAt: record.claimedAt, leaseExpiresAt: record.leaseExpiresAt, leaseToken: record.leaseToken,
      nextAttemptAt: record.nextAttemptAt, failureClassification: record.failureClassification });
    await assert.rejects(() => postgres.get(record.attemptId), /INVALID_OPERATIONAL_RECORD/);
  });
}
