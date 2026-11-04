import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { RECORD_MODEL } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { recordLogStore as before } from './fixtures/record-log-store-before-page-key-metadata.mjs';
import { bucketOf } from '../do-work/record-digest.mjs';
const material = Buffer.alloc(32, 13).toString('base64');
function seed(source) {
 const host=sqliteHost(':memory:');const options={transaction:host.transaction,model:RECORD_MODEL,slot_bytes:0,
  runs:{page_bytes:4096,cache_bytes:0,filter_bytes:0,memtable_bytes:1<<20,tail_rows:Infinity}};
 let store=source(host.sql,options);store.takeErasureKeys({'message:root-proof':material,'message:side-proof':material});
 store.write([{id:'message:root-proof',type:'message',value:{conversation_id:'test-conversation',speaker:'person',text:'own words'}},
 {id:'message:side-proof',type:'message',value:{conversation_id:'test-conversation',speaker:'person',text:'side words'}},
 {id:'arrival:side-proof',type:'arrival',value:{message_id:'message:side-proof',route:'chat',job:'side words',at:'2026-10-12T12:00:00Z'}}]);
 store.checkpoint();store=source(host.sql,options);return{host,store,options};
}
function keyedPage(store,buckets=Array.from({length:256},(_,i)=>i)){
 const page=store.recordsInBucketsPage(buckets,{key_owners:true});const ids=page.records.map(record=>record.id);
 return{page,ids,keys:()=>store.erasureKeys(ids,{from_page:page.records})};
}
test('page root metadata preserves key-holder precedence over a conflicting legacy key table across reopen',()=>{
 const a=seed(before),b=seed(recordLogStore);
 try{
  // Both key-holder and inline root remain authentic current keys; a conflicting legacy table cannot override them.
  for(const f of [a,b])f.host.sql.exec("UPDATE record_erasable_keys SET key=NULL, erased_at=?, erased_fields=? WHERE record_id=?",'2026-10-12T12:00:00Z','[\"text\"]','message:root-proof');
  const left=keyedPage(a.store),right=keyedPage(b.store);
  // Independent writes receive different stamps; compare their authentic stored values and exact key reply.
  assert.deepEqual(right.page.records.map(({meta,...record})=>record),left.page.records.map(({meta,...record})=>record));
  assert.deepEqual(right.keys(),left.keys());
  assert.equal(b.store.erasureKeys(['message:root-proof'])['message:root-proof'],material);
 }finally{a.host.db.close();b.host.db.close();}
});
test('page metadata retains external owner lookup and falls back after erasure or rolled-back key admission',()=>{
 const f=seed(recordLogStore);
 try{
  const page=keyedPage(f.store,[bucketOf('arrival:side-proof')]);assert.equal(page.keys()['message:side-proof'],material);
  const stale=keyedPage(f.store);f.store.takeErasureKeys({'message:side-proof':{erased:['text']}});
  assert.deepEqual(stale.keys(),f.store.erasureKeys(stale.ids));
  const rollback=keyedPage(f.store);assert.throws(()=>f.host.transaction(()=>{f.store.takeErasureKeys({'message:root-proof':{erased:['text']}});throw Error('rollback');}),/rollback/);
  f.store.forgetCached();assert.deepEqual(rollback.keys(),f.store.erasureKeys(rollback.ids));
 }finally{f.host.db.close();}
});
