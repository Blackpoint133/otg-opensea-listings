import test from "node:test";
import assert from "node:assert/strict";
import { PostgresJournalFenceSnapshotReader } from "../src/reconciliation/verifier/journalFenceSnapshotReader.js";
import type { DbPool, QueryResult, TransactionClient } from "../src/db/types.js";

const ORDER = "0x" + "a".repeat(64), CONTRACT = "0x" + "b".repeat(40), OTHER = "0x" + "c".repeat(64);
type Row = { event_id: string; event_type: string; event_version: string | null; order_hash: string | null; chain: string | null; contract_address: string | null; token_id: string | null; received_at: string };
class Sim implements DbPool {
  rows: Row[] = []; private snap: Row[] | null = null;
  async connect(): Promise<TransactionClient> { const self=this; return { release(){}, query: async <T>(sql:string, values?:readonly unknown[]) => self.queryTx<T>(sql, values) }; }
  async end() {}
  private async queryTx<T>(sql:string, values?:readonly unknown[]): Promise<QueryResult<T>> {
    if (/^BEGIN/.test(sql)) { this.snap=this.rows.map(r=>({...r})); return {rows:[],rowCount:0}; }
    if (/SET TRANSACTION/.test(sql)) return {rows:[],rowCount:0};
    if (/ROLLBACK/.test(sql)) { this.snap=null; return {rows:[],rowCount:0}; }
    if (/COMMIT/.test(sql)) { this.snap=null; return {rows:[],rowCount:0}; }
    const data=this.snap ?? this.rows;
    if (/transaction_timestamp/.test(sql)) return {rows:[{now:"2026-01-01T00:00:00.000Z"} as T],rowCount:1};
    if (/ORDER BY event_id DESC/.test(sql)) { const r=[...data].sort((a,b)=>BigInt(a.event_id)<BigInt(b.event_id)?1:BigInt(a.event_id)>BigInt(b.event_id)?-1:0)[0]; return {rows:r?[{event_id:r.event_id,received_at:r.received_at} as T]:[],rowCount:r?1:0}; }
    if (/SELECT event_id::text AS event_id,event_type/.test(sql)) { const hi=String(values?.[0]); const [,ord,chain,contract,token]=values ?? []; const out=data.filter(r=>BigInt(r.event_id)<=BigInt(hi!) && (r.order_hash===ord || (r.chain===chain&&r.contract_address===contract&&r.token_id===token))).sort((a,b)=>BigInt(a.event_id)<BigInt(b.event_id)?-1:BigInt(a.event_id)>BigInt(b.event_id)?1:0); return {rows:out.map(r=>({...r}) as T),rowCount:out.length}; }
    throw new Error(`UNSUPPORTED_SIM_SQL:${sql}`);
  }
  async query<T>(sql:string, values?:readonly unknown[]):Promise<QueryResult<T>> { return this.queryTx<T>(sql,values); }
  insert(row:Row){this.rows.push(row);}
}
const id={orderHash:ORDER,chain:"gunzilla",contractAddress:CONTRACT,tokenId:"6394148"};
const row=(event_id:string, event_type:string, order_hash:string|null=ORDER, chain:string|null="gunzilla", contract_address:string|null=CONTRACT, token_id:string|null="6394148"):Row=>({event_id,event_type,event_version:"1",order_hash,chain,contract_address,token_id,received_at:"2026-01-01T00:00:00.000Z"});

test("reader uses coherent high-water and subsequent snapshot sees insertion", async()=>{const db=new Sim();db.insert(row("1","item_listed"));const reader=new PostgresJournalFenceSnapshotReader(db);const first=await reader.readSnapshot(id);db.insert(row("2","item_transferred",null));const second=await reader.readSnapshot(id);assert.deepEqual(first.relevantOrderFingerprint.eventIds,["1"]);assert.deepEqual(second.relevantOrderFingerprint.eventIds,["1","2"]);});
test("direct order and same-NFT events are relevant while unrelated rows are excluded", async()=>{const db=new Sim();db.insert(row("1","item_listed"));db.insert(row("2","item_sold",OTHER,"gunzilla",CONTRACT,"6394148"));db.insert(row("3","item_transferred",null,"gunzilla",CONTRACT,"6394148"));db.insert(row("4","item_sold",OTHER,"gunzilla",CONTRACT,"999"));db.insert(row("5","item_sold",OTHER,"other",CONTRACT,"6394148"));const s=await new PostgresJournalFenceSnapshotReader(db).readSnapshot(id);assert.deepEqual(s.relevantOrderFingerprint.eventIds,["1","2","3"]);assert.equal(s.relevantOrderFingerprint.orderingAmbiguous,false);});
test("empty journal returns deterministic valid snapshot", async()=>{const s=await new PostgresJournalFenceSnapshotReader(new Sim()).readSnapshot(id);assert.equal(s.watermark.eventId,"0");assert.equal(s.relevantOrderFingerprint.eventIds.length,0);assert.equal(s.relevantOrderFingerprint.orderingAmbiguous,false);});
test("malformed relevant row fails closed", async()=>{const db=new Sim();db.insert(row("1","unknown"));await assert.rejects(()=>new PostgresJournalFenceSnapshotReader(db).readSnapshot(id),/MALFORMED_JOURNAL_EVENT/);});
