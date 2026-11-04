import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
const runs = { page_bytes:512, memtable_bytes:1<<20, big_bytes:8192, cache_bytes:8192, max_runs:4, fan_in:2, tail_rows:Infinity };
const indexes = [{ type:'note', name:'at', paths:[['at']], backfill:'at-v1' }];
const key = 'index-build:note:at-v1';
const row = n => ({ id:'note:'+String(n).padStart(5,'0'), type:'note', value:{ at:String(n), words:'w'.repeat(120) } });
const meta = (host,name) => { const found=host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?',name).toArray()[0];return found?JSON.parse(found.value):null; };
function fixture({ transaction }={}) {
 const host=sqliteHost(':memory:'), atomically=transaction?.(host)??host.transaction;
 let store=recordLogStore(host.sql,{transaction:atomically,runs});
 for(let group=0;group<8;group++){store.write(Array.from({length:32},(_,offset)=>row(group*32+offset)));store.checkpoint();}
 return { host, reopen:()=>recordLogStore(host.sql,{transaction:atomically,runs,indexes}) };
}
test('bounded projections finish across cold wakes during a merge, preserving concurrent current heads',()=>{
 const{host,reopen}=fixture();try{
  let store=reopen(),previous=null;
  for(let wake=0;wake<8;wake++){
   const step=store.maintain({max_pages:1});
   assert.equal(step.diagnostics.pages,1,'existing merge page allowance');assert.ok(store.held().keys.merge,'merge is still active');
   const state=meta(host,key);assert.ok(state&&state.after!==previous,'merge cannot prevent bounded index progress');
   assert.equal(state.through,row(255).id,'later arrivals never extend old frontier');previous=state.after;
   if(wake===1){store.write([{...row(1),value:{at:'changed',words:'edited behind build cursor'}},{id:row(2).id,value:null},row(300)]);store.checkpoint();}
   store=reopen();
  }
  assert.equal(store.indexReady('note','at'),true);const selected=store.scan('note','at',{all:true});
  assert.equal(selected.length,256);assert.ok(selected.some(e=>e.id===row(1).id&&e.values[0]==='changed'));
  assert.ok(!selected.some(e=>e.id===row(2).id));assert.ok(selected.some(e=>e.id===row(300).id));assert.equal(store.read(row(1).id).words,'edited behind build cursor');
 }finally{host.db.close();}
});
test('merge deadline gives the next cold admission to projections; expired admission writes no progress',()=>{
 const{host,reopen}=fixture();try{
  let expired=false;const exec=host.sql.exec.bind(host.sql);host.sql.exec=(query,...params)=>{const result=exec(query,...params);if(/^INSERT INTO record_keys_run_\d+ \(page,/.test(query))expired=true;return result;};
  let store=reopen();const first=store.maintain({max_pages:1,left:()=>expired?0:1});
  assert.equal(first.diagnostics.pages,1);assert.equal(meta(host,key),null);assert.equal(meta(host,'maintenance_phase_next'),'projections');
  store=reopen();expired=false;const second=store.maintain({max_pages:1,left:()=>expired?0:1});
  assert.ok(meta(host,key)?.after,'index starts before another merge exhausts deadline');assert.equal(second.diagnostics.steps,0);assert.equal(meta(host,'maintenance_phase_next'),'merge');
  const state=meta(host,key),none=store.maintain({max_pages:1,left:()=>0});assert.equal(none.diagnostics.steps,0);assert.equal(none.diagnostics.pages,0);assert.deepEqual(meta(host,key),state);assert.equal(meta(host,'maintenance_phase_next'),'merge');
 }finally{host.db.close();}
});
test('failed index transaction retains phase admission but rolls back its keys and cursor',()=>{
 let armed=false,wroteBuild=false;
 const{host,reopen}=fixture({transaction:host=>fn=>host.transaction(()=>{wroteBuild=false;const result=fn();if(armed&&wroteBuild)throw Error('index commit refused');return result;})});
 try{
  const exec=host.sql.exec.bind(host.sql);host.sql.exec=(query,...params)=>{if(params[0]===key&&/^INSERT INTO record_keys_meta/.test(query))wroteBuild=true;return exec(query,...params);};
  const store=reopen();armed=true;assert.throws(()=>store.maintain({max_pages:1}),/index commit refused/);assert.equal(meta(host,key),null);assert.equal(meta(host,'maintenance_phase_next'),'merge');
  armed=false;assert.equal(store.indexReady('note','at'),false);assert.deepEqual(store.scan('note','at',{all:true}),[]);
  store.maintain({max_pages:1});assert.ok(meta(host,key)?.after);assert.equal(reopen().scan('note','at',{all:true}).length,32);
 }finally{host.db.close();}
});
