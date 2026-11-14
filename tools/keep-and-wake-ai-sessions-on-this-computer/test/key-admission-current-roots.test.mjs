import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { RECORD_MODEL } from '../src/record-engine.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { recordLogStore as before } from './fixtures/record-log-store-before-key-admission.mjs';
const material = Buffer.alloc(32,7).toString('base64');
const config = host => ({ transaction:host.transaction, model:RECORD_MODEL, slot_bytes:0, runs:{page_bytes:4096,cache_bytes:0,filter_bytes:0,memtable_bytes:1<<20,tail_rows:Infinity} });
function seed(host,source) {
  const options=config(host);let records=source(host.sql,options);
  records.takeErasureKeys({'message:owner':material,'side-only':material});
  records.write([{id:'message:owner',type:'message',value:{conversation_id:'conversation-marker',speaker:'person',text:'retained words'}},
    {id:'arrival:uses-owner',type:'arrival',value:{message_id:'message:owner',route:'chat',job:'retained words',at:'2026-10-12T10:00:00.000Z'}}]);
  for(let i=0;i<140;i++)records.write([{id:'message:'+i,type:'message',value:{conversation_id:'conversation-marker',speaker:'person',text:'text '+i}}]);
  records.checkpoint();return{records:source(host.sql,options),options};
}
test('current roots preserve owner keys, side-tree keys, duplicate/absent inputs and erasure tombstones across reopen and rollback',()=>{
  const a=sqliteHost(':memory:'),b=sqliteHost(':memory:');
  try {
    const left=seed(a,before),right=seed(b,recordLogStore);
    const ids=['arrival:uses-owner','side-only','missing','arrival:uses-owner'];
    const expected=left.records.erasureKeys(ids);assert.deepEqual(right.records.erasureKeys(ids),expected);
    assert.equal(expected['message:owner'],material);assert.equal(expected['side-only'],material);assert.equal('missing' in expected,false);
    // A tombstone taken from another copy names the fields it was sent with; the current store also erases the other erasable
    // fields of the record's kind (the model's erasable and erase_fields), as erase() does, so its tombstone names them too.
    const kindFields=['text','conversation_id','source_ref','origin','evidence','attachments'];
    for(const [host,source,item,erased] of [[a,before,left,['text']],[b,recordLogStore,right,kindFields]]) {
      item.records.takeErasureKeys({'message:owner':{erased:['text']}});item.records.checkpoint();item.records=source(host.sql,item.options);
      assert.deepEqual(item.records.erasureKeys(['message:owner'])['message:owner'],{erased});
      assert.throws(()=>host.transaction(()=>{item.records.takeErasureKeys({'side-only':{erased:[]}});throw new Error('deliberate rollback');}),/deliberate rollback/);item.records.forgetCached();
      assert.equal(item.records.erasureKeys(['side-only'])['side-only'],material);
    }
    // Everything but the erased owner answers alike; the owner's tombstones differ only in the fields they name (above).
    const {'message:owner':ownerAfter,...othersRight}=right.records.erasureKeys(ids),{'message:owner':ownerBefore,...othersLeft}=left.records.erasureKeys(ids);
    assert.deepEqual(othersRight,othersLeft);assert.deepEqual([ownerBefore,ownerAfter],[{erased:['text']},{erased:kindFields}]);
    // Each independently written message has a distinct generated key. Test logical output size/coverage without falsely equating key bytes.
    const wide=Array.from({length:140},(_,i)=>'message:'+i);
    for(const item of [left,right]) {
      const found=item.records.erasureKeys([...wide,'missing',...wide]);assert.deepEqual(Object.keys(found).sort(),wide.slice().sort());
      assert.ok(Object.values(found).every(value=>typeof value==='string'));
    }
  } finally {a.db.close();b.db.close();}
});
test('generic grouped discovery preserves singleton fallback for accepted heads above its 2-MiB group budget',()=>{
  const a=sqliteHost(':memory:'),b=sqliteHost(':memory:');
  try {
    const options=host=>({transaction:host.transaction,slot_bytes:0,runs:{cache_bytes:0,filter_bytes:0,tail_rows:Infinity}});
    const stores=[[a,before],[b,recordLogStore]].map(([host,source])=>{
      let records=source(host.sql,options(host));records.load([{id:'large',type:'unmodeled',seq:'001',value:{text:'x'.repeat(2*1024*1024+1024)}},
        {id:'small',type:'unmodeled',seq:'002',value:{text:'small'}}],{});records.loadDone({});return source(host.sql,options(host));
    });
    assert.deepEqual(stores[1].erasureKeys(['large','small','missing']),stores[0].erasureKeys(['large','small','missing']));
  } finally {a.db.close();b.db.close();}
});
