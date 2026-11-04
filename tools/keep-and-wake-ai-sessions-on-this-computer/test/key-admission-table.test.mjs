import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { erasableKeys } from '../parts/record-log/do-work/erasable.mjs';
import { erasableKeys as before } from './fixtures/erasable-before-key-admission.mjs';
const material=Buffer.alloc(32,9).toString('base64');
const seeded=(host,owner,options={})=>{const keys=owner(host.sql,options);keys.take(Object.fromEntries(Array.from({length:130},(_,n)=>['key:'+n,material])));keys.take({'gone':{erased:['text']}});keys.forgetCached();return keys;};
test('generic key-table groups preserve keys, tombstones, duplicates, absences, exact64 admission and warm hits',()=>{
 const a=sqliteHost(':memory:'),b=sqliteHost(':memory:');try{
  const left=seeded(a,before),right=seeded(b,erasableKeys);const ids=[...Array.from({length:130},(_,n)=>'key:'+n),'gone','missing','key:0'];
  const exec=b.sql.exec.bind(b.sql);let queries=0,max=0;b.sql.exec=(query,...params)=>{if(query.includes('FROM record_erasable_keys')&&query.includes('SELECT')){queries++;if(query.includes(' IN ('))max=Math.max(max,params.length-1);}return exec(query,...params);};
  assert.deepEqual(right.keysFor(ids),left.keysFor(ids));assert.equal(queries,3);assert.equal(max,64);queries=0;
  assert.deepEqual(right.keysFor(ids),left.keysFor(ids));assert.equal(queries,0,'cached true absence and tombstones require no SQL');
  right.forgetCached();left.forgetCached();assert.deepEqual(right.keysFor(['key:0']),left.keysFor(['key:0']));
 }finally{a.db.close();b.db.close();}
});
test('current-log owner batch precedence and bounded callback preserve standalone row-owner behavior',()=>{
 const a=sqliteHost(':memory:'),b=sqliteHost(':memory:');try{
  const logged=new Map([['log-only',{key:material,at:7}],['gone',{key:material,at:8}]]);const groups=[];
  const left=seeded(a,before,{inLog:id=>logged.get(id)??null});
  const right=seeded(b,erasableKeys,{inLog:id=>logged.get(id)??null,inLogMany:ids=>{groups.push(ids.length);return new Map(ids.map(id=>[id,logged.get(id)??null]));}});
  const ids=[...Array.from({length:130},(_,n)=>'key:'+n),'gone','missing','log-only'];
  assert.deepEqual(right.keysFor(ids),left.keysFor(ids));assert.ok(groups.every(n=>n<=64));assert.equal(right.keysFor(['gone']).gone,material,'same logged-key precedence as original rowOf');
  assert.equal(right.rowOf('gone'),8);right.forgetCached();groups.length=0;assert.deepEqual(right.keysFor(['log-only']),left.keysFor(['log-only']));assert.deepEqual(groups,[],'singleton retains point owner');
 }finally{a.db.close();b.db.close();}
});
test('table failure creates no false absent cache and rollback invalidates batched keys and erasures',()=>{
 const host=sqliteHost(':memory:');try{
  const keys=seeded(host,erasableKeys);const exec=host.sql.exec.bind(host.sql);let refuse=true;
  host.sql.exec=(query,...params)=>{if(refuse&&query.includes('SELECT record_id, key'))throw Error('table read refused');return exec(query,...params);};
  assert.throws(()=>keys.keysFor(['key:1','key:2','missing']),/table read refused/);refuse=false;
  assert.deepEqual(keys.keysFor(['key:1','key:2','missing']),{'key:1':material,'key:2':material});
  assert.throws(()=>host.transaction(()=>{keys.take({'key:1':{erased:['text']}});assert.deepEqual(keys.keysFor(['key:1','key:2'])['key:1'],{erased:['text']});throw Error('rollback');}),/rollback/);
  keys.forgetCached();assert.equal(keys.keysFor(['key:1','key:2'])['key:1'],material);
 }finally{host.db.close();}
});
