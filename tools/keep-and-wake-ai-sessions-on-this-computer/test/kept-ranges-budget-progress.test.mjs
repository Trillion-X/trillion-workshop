import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns, KeptRangeBudgetExceeded, KEPT_RANGE_PROGRESS } from '../parts/record-log/do-work/kept-runs.mjs';
const exact = lo => ({ lo, hi: `${lo}\u0000` });
function fixture() {
  const host=sqliteHost(':memory:'),opts={transaction:host.transaction,prefix:'progress',page_bytes:256,cache_bytes:0,filter_bytes:0,max_runs:1000};
  const keys=keptRuns(host.sql,opts);
  for(const [key,value] of [['a','older-a'],['b','older-b'],['c','not-visited-yet'],['e','older-e']])keys.put(key,value);
  keys.flush();keys.put('a','new');keys.remove('b');keys.put('e','SECRET_UNREAD_BODY'.repeat(500));keys.flush();
  return{host,open:()=>keptRuns(host.sql,opts)};
}
test('opted-in exact budget failure retains accepted winners and tombstones, never unvisited absence',()=>{
 const f=fixture();try{
  let failure;try{f.open().ranges(['a','b','c','e','missing'].map(exact),{value_budget:{remaining:JSON.stringify('new').length},preserve_exact_progress:true});}catch(error){failure=error;}
  assert.ok(failure instanceof KeptRangeBudgetExceeded);const progress=failure[KEPT_RANGE_PROGRESS];assert.ok(progress);
  assert.equal(progress.accepted.get('a'),'new');assert.equal(progress.completed.has('a'),true);
  assert.equal(progress.completed.has('b'),true);assert.equal(progress.accepted.has('b'),false,'newer tombstone wins over old body');
  assert.equal(progress.completed.has('c'),false,'not-yet-visited older winner is unresolved');
  assert.equal(progress.completed.has('missing'),false,'absence is not proven by interrupted traversal');
  const retry=['a','b','c','e','missing'].filter(key=>!progress.completed.has(key));
  const combined=new Map([...progress.accepted,...f.open().ranges(retry.map(exact))]);
  assert.deepEqual([...combined].sort(),f.open().ranges(['a','b','c','e','missing'].map(exact)));
  assert.equal(Object.getOwnPropertyDescriptor(failure,KEPT_RANGE_PROGRESS).enumerable,false);
  assert.deepEqual(Object.keys(failure),['code']);assert.equal(JSON.stringify(failure).includes('SECRET_UNREAD_BODY'),false);
  assert.equal(JSON.stringify(failure).includes('accepted'),false);
 }finally{f.host.db.close();}
});
test('default, nonexact and limited-range failures retain original error shape',()=>{
 const f=fixture();try{
  for(const [bounds,options] of [[['a','e'].map(exact),{}],[[{lo:'a',hi:'z'}],{preserve_exact_progress:true}],[['a','e'].map(exact),{preserve_exact_progress:true,limit_per_range:1}]]){
   let failure;try{f.open().ranges(bounds,{...options,value_budget:{remaining:0}});}catch(error){failure=error;}
   assert.ok(failure instanceof KeptRangeBudgetExceeded);assert.equal(failure[KEPT_RANGE_PROGRESS],undefined);
  }
  assert.deepEqual(f.open().ranges(['a','b'].map(exact),{preserve_exact_progress:true}),[['a','new']]);
 }finally{f.host.db.close();}
});
test('entry and page caps still stop admission with no invented completed keys',()=>{
 const f=fixture();try{
  for(const option of [{entry_budget:{remaining:0}},{page_budget:{remaining:0}}]){
   let failure;try{f.open().ranges(['a','b','c'].map(exact),{...option,preserve_exact_progress:true});}catch(error){failure=error;}
   assert.ok(failure instanceof KeptRangeBudgetExceeded);assert.equal(failure[KEPT_RANGE_PROGRESS].completed.size,0);
  }
 }finally{f.host.db.close();}
});

test('ordinary SQL failures carry no progress and remain retryable',()=>{
 const f=fixture();try{
  const space=f.open(),exec=f.host.sql.exec.bind(f.host.sql),failure=Error('injected body failure');
  f.host.sql.exec=(query,...params)=>{if(query.includes('SELECT page, body'))throw failure;return exec(query,...params);};
  assert.throws(()=>space.ranges(['a','b','c'].map(exact),{preserve_exact_progress:true}),error=>error===failure);
  assert.equal(failure[KEPT_RANGE_PROGRESS],undefined);
  f.host.sql.exec=exec;assert.deepEqual(space.ranges(['a','b'].map(exact)),[['a','new']]);
 }finally{f.host.db.close();}
});
