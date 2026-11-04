import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

const smallValue = at => ({at,text: 's'.repeat(25)});

// A full fold admitted below max_runs must not pin every later small write-out
// behind its whole output. Original inputs remain authoritative while it waits.
function fixture() {
  const host = sqliteHost(':memory:');
  const settings = { prefix: 'flight', page_bytes: 128, big_bytes: 96, memtable_bytes: 1 << 30,
    fan_in: 4, max_runs: 8, compaction_debt_min_bytes: 1, compaction_debt_ratio: 0.01 };
  let size = 0, fail = 0, depth = 0;
  const sql = { exec: (...args) => host.sql.exec(...args), get databaseSize() { return size; } };
  const transaction = fn => {
    if (depth) return fn();
    depth++;
    try { return host.transaction(() => { const answer=fn(); if(fail && --fail===0)throw Error('injected commit failure');return answer; }); }
    finally { depth--; }
  };
  const open = () => keptRuns(sql, { transaction, ...settings });
  let space = open();
  for (let v = 0; v < 2; v++) {
    for (let at = 0; at < 300; at++) space.put(`k${String(at).padStart(4,'0')}`, { at, v, text:'x'.repeat(100) }, undefined, v ? 100 : 0);
    space.flush();
  }
  space.step({ max_pages: 1 });
  const original = space.meta.get('merge');
  assert.ok(original && original.after !== null, 'a full fold has durable partial output');
  for (let at = 0; at < 24; at++) { space.put(`z${String(at).padStart(3,'0')}`, smallValue(at)); space.flush(); }
  return {host, open, space, original, failAfter: n => {fail=n;}, size: n => {size=n;}};
}

test('small runs drain around an unfinished full fold across cold restarts without retiring reachable values', () => {
  const f = fixture(); let space = f.space;
  let sawDraining = false;
  for (let turns = 0; turns < 35 && space.held().runs.length > space.settings.max_runs; turns++) {
    space = f.open(); space.step({max_pages:1});
    const stillOriginal = space.meta.get('merge')?.output === f.original.output
      || space.meta.get('merge_paused')?.output === f.original.output;
    if (space.held().runs.length < 26 && stillOriginal) sawDraining = true;
    for (let at = 0; at < 300; at += 31) assert.deepEqual(space.get(`k${String(at).padStart(4,'0')}`), {at,v:1,text:'x'.repeat(100)});
  }
  assert.ok(sawDraining, 'the small backlog drains before the original fold finishes');
  assert.ok(space.held().runs.length <= space.settings.max_runs, 'the backlog cannot wait for hundreds of original output pages');
  for (let at=0;at<24;at++) assert.deepEqual(space.get(`z${String(at).padStart(3,'0')}`),smallValue(at));
  for (let turns=0;space.mergeDue();turns++) {assert.ok(turns<1000,'both merges and retirement finish');space=f.open();space.step({max_pages:16});}
  assert.equal(space.meta.get('merge_paused'),undefined);
  for(let at=0;at<300;at++)assert.deepEqual(space.get(`k${String(at).padStart(4,'0')}`),{at,v:1,text:'x'.repeat(100)});
  assert.equal([...f.host.sql.exec('SELECT COUNT(DISTINCT ref) AS n FROM flight_big')][0].n,300,'only newer large values survive retirement');
});


test('pause and secondary output transactions roll back without losing either cursor', () => {
  for(const commit of [1,2]) {
    const f=fixture();f.failAfter(commit);
    assert.throws(()=>f.space.step({max_pages:1}),/injected commit failure/);
    f.space.reloadCatalog();
    assert.equal(f.space.get('k0000').v,1,'same-instance rollback recovery');
    let space=f.open();
    const paused=space.meta.get('merge_paused');
    assert.equal(paused?.output ?? space.meta.get('merge').output,f.original.output);
    if(commit===1)assert.equal(paused,undefined,'pause itself rolled back');
    else assert.equal(space.meta.get('merge').pages,0,'secondary output rolled back');
    for(let n=0;space.mergeDue();n++){assert.ok(n<1000);space=f.open();space.step({max_pages:16});}
    for(let at=0;at<24;at++)assert.deepEqual(space.get(`z${String(at).padStart(3,'0')}`),smallValue(at));
  }
});

test('later tombstones and overwrites win while both folds are suspended and resumed', () => {
  const f=fixture();let space=f.space;
  space.remove('k0000');space.put('k0001',{newest:true});space.flush();
  space.step({max_pages:1});
  assert.ok(space.meta.get('merge_paused'));
  const owned=space.tables();
  for(const state of [space.meta.get('merge'),space.meta.get('merge_paused')])assert.ok(owned.includes(`flight_run_${state.output}`));
  assert.equal(space.fillDue(),false);
  for(let n=0;space.mergeDue();n++){assert.ok(n<1000);space=f.open();space.step({max_pages:16});assert.equal(space.get('k0000'),undefined);assert.deepEqual(space.get('k0001'),{newest:true});}
  assert.equal(space.held().merge,null);assert.equal(space.held().merge_paused,null);
});

test('secondary admission reserves the unfinished output instead of spending its room', () => {
  const f=fixture(),space=f.space;
  const inputs=new Set(f.original.inputs);
  const reserve=space.held().runs.filter(r=>inputs.has(r.run)).reduce((sum,r)=>sum+r.bytes,0)*space.settings.space_factor-f.original.bytes;
  const small=space.held().runs.filter(r=>!inputs.has(r.run)).sort((a,b)=>a.age-b.age).slice(0,4).reduce((sum,r)=>sum+r.bytes,0)*space.settings.space_factor;
  f.size(space.settings.database_limit_bytes*space.settings.space_share-(reserve+small/2));
  assert.ok(small<reserve+small/2,'small group fits the unreserved room');
  space.step({max_pages:1});
  assert.equal(space.meta.get('merge_paused'),undefined,'unfinished output reservation blocks the secondary');
  assert.equal(space.meta.get('merge').output,f.original.output);
  assert.ok(space.meta.get('merge').bytes>f.original.bytes,'original still progresses');
  f.size(0);space.step({max_pages:1});assert.ok(space.meta.get('merge_paused'),'secondary proceeds when sufficient room returns');
});

test('steady arrivals still grant the original fold progress between backlog groups', () => {
  const f=fixture();let space=f.space,previous=f.original.bytes,advances=0;
  for(let n=0;n<40;n++) {
    space=f.open();space.put(`zz${n}`,{n});space.flush();space.step({max_pages:1});
    const original=space.meta.get('merge_paused') ?? space.meta.get('merge');
    assert.equal(original.output,f.original.output);
    if(original.bytes>previous)advances++;
    previous=original.bytes;
  }
  assert.ok(advances>=5,'backlog priority cannot starve the original cursor');
});


test('paused references use the older owner safe mode and an orphaned paused cursor can resume', () => {
  const f=fixture();let space=f.space;space.step({max_pages:1});
  const original=space.meta.get('merge_paused');assert.ok(original);
  assert.equal(space.meta.get('big_drop_mode'),'forget','older serving cleanup must not retire original input refs');
  // Model the durable boundary after older code finishes its secondary and
  // clears its own marker without knowing merge_paused. Current code must
  // retain and resume the original instead of starting another complete fold.
  space.meta.remove('merge');
  space=f.open();space.step({max_pages:1});
  assert.equal(space.meta.get('merge').output,original.output);
  assert.equal(space.meta.get('merge_paused'),undefined);
  assert.equal(space.get('k0000').v,1);
});
