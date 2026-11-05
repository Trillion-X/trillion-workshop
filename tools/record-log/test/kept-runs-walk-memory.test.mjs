import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const source = process.env.KEPT_WALK_SOURCE ?? new URL(import.meta.resolve('../do-work/kept-runs.mjs')).href;
const probe = `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const { keptRuns } = await import(${JSON.stringify(source)});
const db = new DatabaseSync(':memory:');
let measuring = false, baseline = 0, peak = 0, bodyReads = 0, openBodies = 0;
const measure = () => { if (measuring) { global.gc(); const usage=process.memoryUsage();
  peak=Math.max(peak,usage.heapUsed+usage.external-baseline); } };
const sql = { exec(query,...params) {
  const body = /SELECT.*(?:body|sought).*FROM cursor_run_/s.test(query);
  if (body) { measure(); if (measuring) bodyReads++; }
  const statement=db.prepare(query);
  const iterator=statement.columns().length?statement.iterate(...params):(statement.run(...params),[][Symbol.iterator]());
  const tracked=/SELECT page, body FROM cursor_run_/s.test(query);
  let closed=false; if(tracked)openBodies++;
  const close=()=>{if(!closed){closed=true;if(tracked)openBodies--;}};
  const wrapped={ next(){if(body)measure();const row=iterator.next();if(row.done)close();return row;},
    return(){try{return iterator.return?.()??{done:true};}finally{close();}},[Symbol.iterator](){return this;} };
  return {toArray:()=>Array.from(wrapped),[Symbol.iterator]:()=>wrapped};
} };
const options = { prefix:'cursor',page_bytes:128*1024,big_bytes:1024*1024,
  memtable_bytes:2*1024*1024,cache_bytes:0,filter_bytes:0,max_runs:1000 };
let space=keptRuns(sql,options);
const runs=Number(process.argv[1]), mode=process.argv[2];
for(let run=0;run<runs;run++) {
  space.put('a',{answer:run});
  space.put('m',{unused:(String(run).padStart(5,'0')+'-').repeat(8500)});
  space.put('n',{unused:(String(run).padStart(5,'0')+'+').repeat(8500)});
  space.put('z',{answer:run});space.flush();
}
space=keptRuns(sql,options);
global.gc();const initial=process.memoryUsage();baseline=initial.heapUsed+initial.external;measuring=true;
const iterator=mode==='keys'?space.walkKeys('a','zz'):space.walk('a','zz');
const first=iterator.next();measure();iterator.return();measuring=false;
assert.deepEqual(first,{value:mode==='keys'?'a':['a',{answer:runs-1}],done:false});
assert.equal(openBodies,0,'early return closes every retained SQL body cursor');
console.log(JSON.stringify({runs,mode,peak,bodyReads,answer:first.value,cacheBytes:space.held().cache_bytes,openBodies}));
db.close();
`;
function measured(runs, mode) {
  const child=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',probe,String(runs),mode],
    {encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
  assert.equal(child.status,0,child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}
for (const mode of ['values','keys']) {
  test(`one tiny ${mode} walk does not pin all overlapping decoded source pages`, {timeout:180000},()=>{
    const small=measured(16,mode),large=measured(64,mode);
    console.log('Node actual SQLite suspended streaming-walk heap plus external after GC',JSON.stringify({mode,small,large}));
    assert.equal(small.cacheBytes,0);assert.equal(large.cacheBytes,0);
    assert.ok(large.bodyReads>=64,'all overlapping sources were contacted');
    assert.ok(large.peak-small.peak<2*1024*1024,
      '48 extra overlapping 102KiB pages retained '+(large.peak-small.peak)+' extra heap bytes');
  });
}
