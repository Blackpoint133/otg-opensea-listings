import test from "node:test";
import assert from "node:assert/strict";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";
import { PostgresTargetedVerifierAttemptStore } from "../src/reconciliation/verifier/targetedVerifierOperationalWorker.js";

class ThrottleDb implements DbPool {
  nowMs = Date.parse("2026-01-01T00:00:10.000Z");
  permits = new Map<string, { expires: number }>();
  last: number | null = null;
  sql: string[] = [];
  async end() {}
  async connect(): Promise<TransactionClient> { return { release() {}, query: (q,v) => this.query(q,v) }; }
  async query<T=unknown>(q:string, values?:readonly unknown[]): Promise<QueryResult<T>> {
    this.sql.push(q); const low=q.toLowerCase();
    if (/^begin|^commit|^rollback|pg_advisory_xact_lock/.test(low)) return {rows:[],rowCount:0};
    if (/transaction_timestamp\(\)/.test(low)) return {rows:[{now:new Date(this.nowMs)} as T],rowCount:1};
    if (/^delete from public\.targeted_verifier_permits where permit_id/.test(low)) { this.permits.delete(String(values?.[0])); return {rows:[],rowCount:1}; }
    if (/delete from public\.targeted_verifier_permits/.test(low)) { const cutoff=Date.parse(String(values?.[0])); for(const [id,p] of this.permits) if(p.expires<=cutoff)this.permits.delete(id); return {rows:[],rowCount:1}; }
    if (/select last_request_started_at/.test(low)) return {rows:[{last_request_started_at:this.last===null?null:new Date(this.last)} as T],rowCount:1};
    if (/select count\(\*\)::text as count from public\.targeted_verifier_permits/.test(low)) { const cutoff=Date.parse(String(values?.[0])); return {rows:[{count:String([...this.permits.values()].filter(p=>p.expires>cutoff).length)} as T],rowCount:1}; }
    if (/insert into public\.targeted_verifier_permits/.test(low)) { const id=String(values?.[0]); this.permits.set(id,{expires:Date.parse(String(values?.[3]))}); return {rows:[],rowCount:1}; }
    if (/update public\.targeted_verifier_throttle_state/.test(low)) { this.last=Date.parse(String(values?.[1])); return {rows:[],rowCount:1}; }
    throw new Error(`UNSUPPORTED_SQL:${q}`);
  }
}

test("Postgres throttle uses database time and separate lock/count queries", async()=>{const db=new ThrottleDb();const store=new PostgresTargetedVerifierAttemptStore(db);const p=await store.acquirePermit("a",0,1,1000,5000);assert.ok(p);assert.ok(db.sql.some(x=>/transaction_timestamp\(\)/i.test(x)));assert.equal(db.sql.some(x=>/count\(\*\).*last_request_started_at/i.test(x)),false);assert.equal(db.sql.some(x=>/count\(\*\).*for update/i.test(x)),false);assert.equal(p.leaseExpiresAtMs,db.nowMs+5000);});
test("Postgres throttle enforces concurrency across stores", async()=>{const db=new ThrottleDb();const a=new PostgresTargetedVerifierAttemptStore(db),b=new PostgresTargetedVerifierAttemptStore(db);assert.ok(await a.acquirePermit("a",0,1,0,5000));assert.equal(await b.acquirePermit("b",999999,1,0,5000),null);});
test("Postgres spacing survives release", async()=>{const db=new ThrottleDb();const a=new PostgresTargetedVerifierAttemptStore(db),b=new PostgresTargetedVerifierAttemptStore(db);const p=await a.acquirePermit("a",0,1,1000,5000);assert.ok(p);await a.releasePermit(p.permitId);db.nowMs+=999;assert.equal(await b.acquirePermit("b",0,1,1000,5000),null);db.nowMs+=1;assert.ok(await b.acquirePermit("b",0,1,1000,5000));});
test("Postgres throttle cleans expired permits", async()=>{const db=new ThrottleDb();const a=new PostgresTargetedVerifierAttemptStore(db),b=new PostgresTargetedVerifierAttemptStore(db);const p=await a.acquirePermit("a",0,1,0,1000);assert.ok(p);db.nowMs+=1001;assert.ok(await b.acquirePermit("b",0,1,0,1000));});
