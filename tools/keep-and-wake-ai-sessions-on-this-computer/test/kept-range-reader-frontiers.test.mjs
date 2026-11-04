import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';
import { keptRuns as before } from './fixtures/kept-runs-before-directory-reader.mjs';
const key=n=>'i:'+String(n).padStart(6,'0');
const config=host=>({transaction:host.transaction,prefix:'probe',page_bytes:512,big_bytes:4096,memtable_bytes:1<<20,cache_bytes:0,filter_bytes:0});
function seed(host,source){let keys=source(host.sql,config(host));for(let i=0;i<512;i++)keys.put(key(i),{i,text:'x'.repeat(80)});keys.flush();keys.put(key(20),{edited:true});keys.remove(key(40));keys.flush();return source(host.sql,config(host));}
const read=(reader,lo,limit=32)=>reader.ranges([{lo,hi:'i;'}],{limit_per_range:limit});
test('bounded current range reader preserves ordered forward pages, newest winners, tombstones, rewind, overlapping ranges, empty selection and close',()=>{
 const a=sqliteHost(':memory:'),b=sqliteHost(':memory:');try{
  const left=seed(a,before),right=seed(b,keptRuns),reader=right.rangeReader();
  for(let lo=key(0),turn=0;turn<20;turn++){
   const got=read(reader,lo),expected=read(left,lo);assert.deepEqual(got,expected);const held=reader.held();
   assert.ok(held.entries<=64);assert.ok(held.bytes<=held.limit_bytes);assert.equal(right.held().cache_bytes,0);
   if(!got.length)break;lo=got.at(-1)[0]+'\0';
  }
  assert.deepEqual(read(reader,key(0)),read(left,key(0)),'backward lower bounds cannot reuse a higher frontier');
  const bounds=[{lo:key(10),hi:key(60)},{lo:key(30),hi:key(80)}];assert.deepEqual(reader.ranges(bounds,{limit_per_range:20}),left.ranges(bounds,{limit_per_range:20}));
  assert.deepEqual(reader.ranges([],{limit_per_range:32}),[]);assert.deepEqual(read(reader,key(9000)),[]);
  reader.reset();assert.equal(reader.held().bytes,0);reader.close();assert.equal(reader.held().entries,0);
  assert.throws(()=>read(reader,key(0)),error=>error.code==='range_reader_closed');
 }finally{a.db.close();b.db.close();}
});
test('range frontier failure cannot admit bodies before page budget and releases all saved progress',()=>{
 const host=sqliteHost(':memory:');try{
  const keys=seed(host,keptRuns),reader=keys.rangeReader();read(reader,key(300));let bodies=0;const exec=host.sql.exec.bind(host.sql);
  host.sql.exec=(query,...params)=>{if(query.includes('SELECT body')||query.includes('SELECT page, body'))bodies++;return exec(query,...params);};
  assert.throws(()=>reader.ranges([{lo:key(350),hi:'i;'}],{limit_per_range:32,page_budget:{remaining:0}}),error=>error.code==='kept_range_budget');assert.equal(bodies,0);assert.equal(reader.held().bytes,0);
  assert.throws(()=>reader.ranges([{lo:key(350),hi:'i;'}],{limit_per_range:32,value_budget:{remaining:0}}),error=>error.code==='kept_range_budget');assert.equal(reader.held().entries,0);
  assert.deepEqual(read(reader,key(350)),read(keys,key(350)));reader.close();
 }finally{host.db.close();}
});
test('new memtable winners, fence-changing drops, rewrites, catalog reload, rollback and reused run numbers invalidate old numeric frontiers',()=>{
 const host=sqliteHost(':memory:');try{
  const keys=seed(host,keptRuns),reader=keys.rangeReader();read(reader,key(300));
  keys.put(key(350),{newer:true});keys.remove(key(351));assert.deepEqual(read(reader,key(330)),read(keys,key(330)));
  keys.flush();keys.rewriteKey(key(360),()=>({rewritten:true}));keys.dropKey(key(361));assert.deepEqual(read(reader,key(340)),read(keys,key(340)));
  assert.throws(()=>host.transaction(()=>{keys.put('i:rollback',{temporary:true});keys.flush();read(reader,'i:rollback');throw Error('deliberate rollback');}),/deliberate rollback/);
  keys.reloadCatalog();keys.clearMemtable();keys.put('i:reuse',{retained:true});keys.flush();
  assert.deepEqual(read(reader,key(0)),read(keys,key(0)));assert.deepEqual(read(reader,'i:rollback'),read(keys,'i:rollback'));reader.close();
 }finally{host.db.close();}
});
test('frontier text and entries remain bounded across more than64 runs and oversized bounds are not retained',()=>{
 const host=sqliteHost(':memory:');try{
  const keys=keptRuns(host.sql,{...config(host),page_bytes:256});
  for(let run=0;run<80;run++){keys.put('a:'+run,{run});keys.put('z:'+run,{run});keys.flush();}
  const reader=keys.rangeReader();for(let n=0;n<5;n++)reader.ranges([{lo:'m:'+n,hi:'z;'}],{limit_per_range:1});
  assert.ok(reader.held().entries<=64);assert.ok(reader.held().bytes<=256);
  reader.reset();reader.ranges([{lo:'m'+'x'.repeat(4096),hi:'z;'}],{limit_per_range:1});assert.equal(reader.held().bytes,0);reader.close();
 }finally{host.db.close();}
});
test('Unicode lower frontiers retain JavaScript fence order through scattered and co-located windows',()=>{
 const host=sqliteHost(':memory:');try{
  const keys=keptRuns(host.sql,{...config(host),page_bytes:128});const ids=['a','a\u0001','aa','z','𐐀','🙂','\ue000',...Array.from({length:20},(_,i)=>'y:'+i)];
  ids.forEach((id,i)=>keys.put(id,{i,text:'u'.repeat(80)}));keys.flush();const reader=keys.rangeReader();
  for(const lo of ids.slice().sort()){const bounds=[{lo,hi:'\uffff'}];assert.deepEqual(reader.ranges(bounds,{limit_per_range:8}),keys.ranges(bounds,{limit_per_range:8}));}
  const bounds=ids.map(lo=>({lo,hi:lo+'\0'}));assert.deepEqual(reader.ranges(bounds,{limit_per_range:1}),keys.ranges(bounds,{limit_per_range:1}));reader.close();
 }finally{host.db.close();}
});

test('reader entry cap binds independently of byte cap and delegated unbounded failures clear progress',()=>{
 const host=sqliteHost(':memory:');try{
  const keys=keptRuns(host.sql,{...config(host),page_bytes:16384});
  for(let run=0;run<80;run++){keys.put('a:'+run,{run});keys.put('z:'+run,{run});keys.flush();}
  const reader=keys.rangeReader();reader.ranges([{lo:'m',hi:'z;'}],{limit_per_range:1});
  assert.equal(reader.held().entries,64);assert.ok(reader.held().bytes<=reader.held().limit_bytes);
  assert.throws(()=>reader.ranges([{lo:'m',hi:'z;'}],{value_budget:{remaining:0}}),error=>error.code==='kept_range_budget');
  assert.equal(reader.held().bytes,0);reader.close();
 }finally{host.db.close();}
});

test('a before-first scan start is not saved as a lower bracket and certified same-page ranges remain complete',()=>{
 const host=sqliteHost(':memory:');try{
  const keys=keptRuns(host.sql,{...config(host),page_bytes:4096});
  for(let n=0;n<50;n++)keys.put(key(n),{n});keys.flush();const reader=keys.rangeReader();
  const bounds=lo=>[{lo,hi:'i;'}];
  assert.deepEqual(reader.ranges(bounds('a'),{limit_per_range:3}),keys.ranges(bounds('a'),{limit_per_range:3}));
  assert.equal(reader.held().entries,0,'a scan start clamped from -1 is not authenticated');
  for(const lo of [key(0),key(0)+'\0',key(1),key(1)+'\0',key(2),key(15)])
   assert.deepEqual(reader.ranges(bounds(lo),{limit_per_range:3}),keys.ranges(bounds(lo),{limit_per_range:3}));
  const many=Array.from({length:16},(_,n)=>({lo:key(n+16),hi:key(n+18)}));
  assert.deepEqual(reader.ranges(many,{limit_per_range:1}),keys.ranges(many,{limit_per_range:1}));reader.close();
 }finally{host.db.close();}
});
