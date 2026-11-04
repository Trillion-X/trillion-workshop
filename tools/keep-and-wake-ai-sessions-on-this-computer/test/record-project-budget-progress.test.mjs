import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';
const id=n=>'note:'+String(n).padStart(3,'0');
const options=host=>({transaction:host.transaction,slot_bytes:4096,runs:{page_bytes:4096,cache_bytes:0,filter_bytes:0,max_runs:1000}});
const markers=[null,false,0,'',{},[],{large:'x'.repeat(1000)}];
const value=n=>({n,body:'raw-wide-body'.repeat(10000),result:n%8===7?{}:{withdrawn_by:markers[n%8]},extra:{unread:{body:'other'}}});
function expected(ids,model){return new Map([...new Set(ids)].filter(key=>model.has(key)).map(key=>{const item=model.get(key);return[key,{fields:{id:key,n:item.n},presence:[item.result?.withdrawn_by!==undefined]}];}));}
for(const legacy of [false,true])test(`grouped wide projection preserves incomplete-budget roots, mixed legacy=${legacy}`,()=>{
 const host=sqliteHost(':memory:'),opts=options(host),writer=recordLogStore(host.sql,opts),model=new Map();
 try{
  for(let n=0;n<32;n++){const item=value(n);writer.write([{id:id(n),type:'note',value:item}]);model.set(id(n),item);if(n%8===7)writer.checkpoint();}
  writer.write([{id:'wrong',type:'other',value:{n:100}},{id:id(3),value:null}]);model.delete(id(3));writer.checkpoint();
  if(legacy){
   // Exact historical two-key representation, same truth and durable log position.
   // This is a synthetic representation witness, not a product migration write.
   const keys=keptRuns(host.sql,{transaction:host.transaction,prefix:'record_keys',...opts.runs});
   for(let n=8;n<24;n++){const key='i\u0000'+id(n),at=keys.get(key);keys.put('r\u0000'+at[0]+'\u0000'+at[1]+'\u0000'+id(n),at[2]);keys.put(key,at.slice(0,2));}keys.flush();
  }
  const ids=[...Array.from({length:32},(_,n)=>id(31-n)),'missing',id(0),'wrong'];
  let reader=recordLogStore(host.sql,opts);
  assert.deepEqual(reader.fields.projectOf('note',ids,{fields:['n'],presence:[['result','withdrawn_by']]}),expected(ids,model));
  // Ordinary full-value reads retain their existing default representation.
  assert.deepEqual(reader.read(id(0)),model.get(id(0)));
  reader.write([{id:id(4),type:'note',value:{n:4,result:{}}}]);model.set(id(4),{n:4,result:{}});
  reader.write([{id:id(3),type:'note',value:{n:3,result:{withdrawn_by:[]}}}]);model.set(id(3),{n:3,result:{withdrawn_by:[]}});
  reader.checkpoint();reader=recordLogStore(host.sql,opts);
  assert.deepEqual(reader.fields.projectOf('note',ids,{fields:['n'],presence:[['result','withdrawn_by']]}),expected(ids,model));
  assert.throws(()=>host.transaction(()=>{reader.write([{id:id(0),type:'note',value:{n:999}}]);throw Error('rollback');}),/rollback/);reader.forgetCached();
  assert.deepEqual(reader.fields.projectOf('note',ids,{fields:['n'],presence:[['result','withdrawn_by']]}),expected(ids,model));
 }finally{host.db.close();}
});
test('shared-path presence, wrong types, requested objects and shared cycles retain admission',()=>{
 const host=sqliteHost(':memory:'),opts={...options(host),contentId:(type,item)=>'shared:'+createHash('sha256').update(type+JSON.stringify(item)).digest('hex')};
 try{
  const writer=recordLogStore(host.sql,opts);
  const records=Array.from({length:20},(_,n)=>({id:id(n),type:'note',value:{n,result:{withdrawn_by:markers[n%markers.length],unrelated:{body:'x'.repeat(100000)}}}}));
  writer.write(records);writer.checkpoint();const reader=recordLogStore(host.sql,opts);
  const found=reader.fields.projectOf('note',records.map(row=>row.id),{fields:['n'],presence:[['result','withdrawn_by']]});
  assert.ok([...found.values()].every(row=>row.presence[0]===true));
  assert.deepEqual(reader.fields.projectOf('wrong-type',records.map(row=>row.id),{fields:['n']}),new Map());
  assert.deepEqual(reader.fields.projectOf('note',[id(0)],{fields:['result']}).get(id(0)).fields.result,records[0].value.result);
  // Corrupt cycles are refused, never expanded into an unbounded traversal.
  const keys=keptRuns(host.sql,{transaction:host.transaction,prefix:'record_keys',...opts.runs});
  keys.put('i\u0000cycle-root',['note','synthetic',{result:{'\u0000shared':'cycle-node'}}]);
  keys.put('i\u0000cycle-node',['note/result','synthetic',{'\u0000shared':'cycle-node'}]);keys.flush();
  const cyclic=recordLogStore(host.sql,options(host));
  assert.throws(()=>cyclic.fields.projectOf('note',['cycle-root'],{presence:[['result','withdrawn_by']]}),/contains itself/);
 }finally{host.db.close();}
});
test('a selected erasable field is answered opened, as a read answers it, and an erased record answers nothing',()=>{
 const host=sqliteHost(':memory:'),model={kinds:[{type:'note',properties:{title:'text',input:'object'},erasable:['title',['input','said']]}]};
 try{
  const writer=recordLogStore(host.sql,{...options(host),model});
  writer.write([{id:id(1),type:'note',value:{n:1,title:'Kept words',input:{said:'Nested words',other:'plain'}}}]);writer.checkpoint();
  const reader=recordLogStore(host.sql,{...options(host),model});
  assert.deepEqual(reader.fields.projectOf('note',[id(1)],{fields:['title','input']}).get(id(1)).fields,{id:id(1),title:'Kept words',input:{said:'Nested words',other:'plain'}});
  assert.equal(reader.read(id(1)).title,'Kept words');
  reader.erase(id(1));
  assert.equal(reader.read(id(1)),null);
  assert.deepEqual(reader.fields.projectOf('note',[id(1)],{fields:['title','input']}),new Map());
 }finally{host.db.close();}
});
