import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const { keptRuns } = await import(process.env.KEPT_WALK_SOURCE ?? new URL(import.meta.resolve('../do-work/kept-runs.mjs')).href);

function fixture(prefix) {
  const db=new DatabaseSync(':memory:');let openBodies=0,parsed=[],failKey=null;
  const sql={exec(query,...params){
    const statement=db.prepare(query);
  const iterator=statement.columns().length?statement.iterate(...params):(statement.run(...params),[][Symbol.iterator]());
    const tracked=query.startsWith('SELECT page, body FROM '+prefix+'_run_');
    let closed=false;if(tracked)openBodies++;
    const close=()=>{if(!closed){closed=true;if(tracked)openBodies--;}};
    const wrapped={next(){const row=iterator.next();if(row.done)close();return row;},
      return(){try{return iterator.return?.()??{done:true};}finally{close();}},[Symbol.iterator](){return this;}};
    return {toArray:()=>Array.from(wrapped),[Symbol.iterator]:()=>wrapped};
  }};
  const options={prefix,page_bytes:512,big_bytes:256,cache_bytes:0,filter_bytes:0,max_runs:1000,
    parseJson(text,context){parsed.push(context);if(context?.key===failKey)throw new Error('value parse interrupted');return JSON.parse(text);}};
  const open=()=>keptRuns(sql,options);
  return {db,open,active:()=>openBodies,reset(){parsed=[];},parsed:()=>parsed,fail(key){failKey=key;}};
}
function seed(f) {
  let space=f.open();const oracle=new Map();
  for(let run=0;run<4;run++){
    for(let n=0;n<100;n++){
      const key='k:'+String(n).padStart(3,'0');
      const value={run,n,text:(n%17?'value':'spill').repeat(n%17?20:2000)};
      if(run>0&&n%7===run){space.remove(key);oracle.delete(key);}else{space.put(key,value);oracle.set(key,value);}
    }
    space.flush();
  }
  space=f.open();space.put('k:010',{memory:true});oracle.set('k:010',{memory:true});
  space.remove('k:011');oracle.delete('k:011');
  return {space,expected:[...oracle].sort(([a],[b])=>a<b?-1:a>b?1:0)};
}
test('streamed walks preserve collisions, tombstones, spill values and value-free keys',()=>{
  const f=fixture('walk_semantics');try{
    const {space,expected}=seed(f);
    assert.deepEqual([...space.walk('k:','l:')],expected);assert.equal(f.active(),0);
    f.reset();assert.deepEqual([...space.walkKeys('k:','l:')],expected.map(([key])=>key));
    assert.equal(f.active(),0);assert.equal(f.parsed().filter(p=>p.kind==='value'||p.kind==='big').length,0);
    f.reset();assert.deepEqual([...space.walk('k:','l:',{readValue:()=>false})],expected.map(([key])=>[key,undefined]));
    assert.equal(f.active(),0);assert.equal(f.parsed().filter(p=>p.kind==='value'||p.kind==='big').length,0);
    assert.deepEqual([...space.walk('k:040','k:060')],expected.filter(([key])=>key>='k:040'&&key<'k:060'));
    assert.equal(f.active(),0);
  }finally{f.db.close();}
});
for(const mode of ['values','keys'])test(`early ${mode} stop returns all SQLite cursors`,()=>{
  const f=fixture('walk_return_'+mode);try{
    const {space,expected}=seed(f);const cursor=mode==='keys'?space.walkKeys('k:','l:'):space.walk('k:','l:');
    assert.deepEqual(cursor.next().value,mode==='keys'?expected[0][0]:expected[0]);
    assert.ok(f.active()>0,'multi-page sources keep streaming cursors before return');
    cursor.return();assert.equal(f.active(),0);assert.deepEqual(cursor.next(),{value:undefined,done:true});
  }finally{f.db.close();}
});
test('value selection and parsing exceptions close all streaming sources',()=>{
  const f=fixture('walk_throw');try{
    const {space,expected}=seed(f);
    assert.throws(()=>[...space.walk('k:','l:',{readValue(){throw new Error('selection interrupted');}})],/selection interrupted/);
    assert.equal(f.active(),0);
    // The first non-spilled winning value is parsed only after all heads are opened.
    f.fail(expected.find(([,value])=>value.n%17)[0]);
    assert.throws(()=>[...space.walk('k:','l:')],/value parse interrupted/);assert.equal(f.active(),0);
    const keys=space.walkKeys('k:','l:');keys.next();assert.throws(()=>keys.throw(new Error('consumer interrupted')),/consumer interrupted/);
    assert.equal(f.active(),0);
  }finally{f.db.close();}
});
