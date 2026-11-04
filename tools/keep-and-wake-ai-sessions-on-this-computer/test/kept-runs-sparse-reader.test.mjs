import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteHost} from '../src/local-store.mjs';
import {keptRuns} from '../parts/record-log/do-work/kept-runs.mjs';
import fixture from './fixtures/kept-runs-sparse-v1.json' with {type:'json'};
// These actual persisted rows come from the qualified synthetic codec writer.
// A reader test imports no historical implementation or writer-admission callback.
const options=host=>({...fixture.options,transaction:host.transaction,prefix:fixture.prefix});
const value=(n,big=false)=>({n,text:(big?'BIG':'v').repeat(big?400:45)});
const expected=[['b-public',value(2)],['d-big-public',value(4,true)],['e-public',value(5)]];
const quote=name=>'"'+name.replaceAll('"','""')+'"';
function load(host){for(const table of fixture.tables){host.sql.exec(table.sql);for(const row of table.rows)host.sql.exec(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(',')}) VALUES (${row.map(()=>'?').join(',')})`,...row);}}
const snapshot=host=>host.sql.exec("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").toArray().map(row=>({...row,rows:host.sql.exec(`SELECT * FROM ${quote(row.name)}`).toArray()}));
function observe(host){const execute=host.sql.exec,effects=[];host.sql.exec=(query,...args)=>{if(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(query))effects.push(query);return execute(query,...args);};return{effects,restore(){host.sql.exec=execute;}};}
test('persisted sparse first marker/interior hole/BIG remain readable under genuine SQLite query_only',t=>{
 const host=sqliteHost(':memory:');t.after(()=>host.db.close());load(host);const before=snapshot(host);host.sql.exec('PRAGMA query_only=ON');const trace=observe(host);
 try{
  const reader=keptRuns(host.sql,{...options(host),readOnly:true});
  assert.deepEqual(reader.range('','z'),expected);assert.deepEqual(reader.range('','z',{reverse:true}),[...expected].reverse());
  assert.deepEqual(reader.ranges([{lo:'',hi:'z'}]),expected);assert.deepEqual(reader.ranges([{lo:'',hi:'z'}],{limit_per_range:10,keys_only:true}),expected.map(([key])=>[key,undefined]));
  assert.deepEqual([...reader.walk('','z')],expected);assert.deepEqual([...reader.walkKeys('','z')],expected.map(([key])=>key));
  for(const [key,item] of expected){assert.deepEqual(reader.get(key),item);assert.deepEqual(reader.versions(key),[item]);}
  assert.equal(reader.get('a-private'),undefined);assert.equal(reader.get('c-private'),undefined);
  const cursor=reader.rangeReader();try{assert.deepEqual(cursor.ranges([{lo:'',hi:'z'}],{limit_per_range:10}),expected);}finally{cursor.close();}
  reader.reloadCatalog();assert.deepEqual(reader.range('','z'),expected);
  for(const mutate of [()=>reader.put('new',{}),()=>reader.remove('b-public'),()=>reader.dropKey('b-public'),()=>reader.rewriteKey('b-public',item=>item),()=>reader.flush(),()=>reader.step(),()=>reader.fillFilters(),()=>reader.meta.set('new',1)])assert.throws(mutate,error=>error.code==='kept_runs_read_only');
  assert.deepEqual(trace.effects,[]);
 }finally{trace.restore();}
 assert.deepEqual(snapshot(host),before);
});
test('an unsupported sparse format refuses a normal writable open before any constructor effects',t=>{
 const host=sqliteHost(':memory:');t.after(()=>host.db.close());load(host);host.sql.exec('UPDATE cold_sparse_runs SET page_format=2');const before=snapshot(host),trace=observe(host);
 try{assert.throws(()=>keptRuns(host.sql,options(host)),error=>error.message==='Unsupported kept page format.');assert.deepEqual(trace.effects,[]);}finally{trace.restore();}
 assert.deepEqual(snapshot(host),before);
});
test('ordinary compatible writes actually fold sparse inputs to dense output after rollback and disk reopen',t=>{
 const directory=mkdtempSync(join(tmpdir(),'sparse-reader-baseline-')),file=join(directory,'state.sqlite');let host=null;
 const close=()=>{if(host){host.db.close();host=null;}};const open=()=>{host=sqliteHost(file);host.claimExclusive();return keptRuns(host.sql,options(host));};
 t.after(()=>{try{close();}finally{rmSync(directory,{recursive:true,force:true});}});
 host=sqliteHost(file);host.claimExclusive();load(host);close();let reader=open();assert.deepEqual(reader.range('','z'),expected);
 reader.put('b-public',value(22),undefined,10000);reader.remove('e-public');reader.put('f-new',value(6));reader.flush();assert.equal(reader.mergeDue(),true);
 const before=snapshot(host),trace=observe(host),failure=Error('rollback actual sparse-input merge');
 try{assert.throws(()=>host.transaction(()=>{reader.step({max_pages:1});throw failure;}),error=>error===failure);assert.ok(trace.effects.length>0);}finally{trace.restore();}
 assert.deepEqual(snapshot(host),before);close();
 let wakes=0;for(;;){reader=open();if(!reader.mergeDue())break;assert.ok(wakes<100);reader.step({max_pages:1});wakes++;close();}
 assert.ok(wakes>0);assert.deepEqual(reader.range('','z'),[['b-public',value(22)],['d-big-public',value(4,true)],['f-new',value(6)]]);
 assert.equal(reader.get('a-private'),undefined);assert.equal(reader.get('c-private'),undefined);assert.equal(reader.get('e-public'),undefined);
 assert.equal(host.sql.exec('SELECT count(*) AS n FROM cold_sparse_runs WHERE page_format=1').one().n,0);
});
