// Source-only candidate regression; root owns execution and qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { openRecords, RECORD_MODEL, RECORD_INDEXES } from '../src/record-engine.mjs';
import indexData from '../src/record-indexes.json' with { type: 'json' };
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { handoffProjection, projectHandoff } from '../../shared-code/src/handoff-projection.mjs';
const projection = { fields: ['finished_at'], presence: [['result', 'withdrawn_by']] };
const at = n => new Date(Date.UTC(2026, 9, 10) + n * 1000).toISOString();
const job = (n, extra = {}) => ({ handoff_id: 'h'+String(n).padStart(4,'0'), state:'finished', handed_at:at(n), finished_at:at(n),
  from_agent:'asker', taken_by:'holder', job:'Do the work', ...extra });
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(shared = false, indexes = indexData.indexes) {
  const host = sqliteHost(':memory:');
  const options = { transaction:host.transaction, indexes, runs:{cache_bytes:0,filter_bytes:0}, slot_bytes:4096,
    ...(shared ? { contentId:(type,value)=>'shared:'+hash(type+JSON.stringify(value)) } : {}) };
  const records = recordLogStore(host.sql,options), store = agentRecordStore({records,transaction:host.transaction});
  store.putCard({agent_id:'asker',name:'Asker'}); store.putCard({agent_id:'holder',name:'Claude Code'});
  return {host,options,records,store,owner:makeAgents({store})};
}
const projected = f => f.owner.recentWork({limit:200,states:['finished'],projection});
for (const shared of [false,true]) test(`time payload preserves absent/null and shared withdrawal presence; shared=${shared}`, () => {
  const f=fixture(shared);
  try {
    const markers=[null,false,0,'',{},[],{body:'WITHDRAWAL_BODY_SENTINEL'.repeat(1000)}];
    markers.forEach((withdrawn_by,n)=>f.store.putHandoff(job(n,{result:{withdrawn_by,response:{body:'UNREQUESTED_RESULT_SENTINEL'.repeat(2000)}}})));
    f.store.putHandoff(job(8,{result:null,to_agent:null})); f.store.putHandoff(job(9,{result:{ordinary:true}}));
    f.records.checkpoint(); f.records.forgetCached();
    const full=f.owner.recentWork({limit:200,states:['finished']});
    const expected={work:full.work.map(row=>projectHandoff(row,handoffProjection(projection))),agents:full.agents};
    const projectOf=f.records.fields.projectOf;
    f.records.fields.projectOf=()=>{throw Error('Covered time entries must not read raw roots');};
    assert.deepEqual(projected(f),expected);
    assert.equal(projected(f).work.filter(row=>row.field_presence[0]).length,markers.length);
    const rows=f.records.scan('agent-handoff','time',{equal:[0],limit:200,carried:true});
    assert.equal(rows.find(row=>row.id.endsWith('h0009')).carried_defined.to_agent,false);
    assert.equal(rows.find(row=>row.id.endsWith('h0008')).carried_defined.to_agent,true);
    assert.equal(rows.find(row=>row.id.endsWith('h0008')).carried.to_agent,null);
    assert.ok(rows.every(row=>!JSON.stringify(row).includes('WITHDRAWAL_BODY_SENTINEL')&&!JSON.stringify(row).includes('UNREQUESTED_RESULT_SENTINEL')));
    const changed=projected(f); changed.work[0].state='tampered'; assert.deepEqual(projected(f),expected,'callers cannot change stored metadata');
    f.records.fields.projectOf=projectOf;
    const requested={fields:['result'],presence:[['result','ordinary']]};
    assert.deepEqual(f.owner.recentWork({states:['finished'],projection:requested}).work,
      full.work.map(row=>projectHandoff(row,handoffProjection(requested))),'unsupported object/presence requests retain full field projection');
  } finally {f.host.db.close();}
});

test('time carry keeps newest200 before exclusion and exact timestamp/id pagination', () => {
  const f=fixture();
  try {
    for(let n=0;n<205;n++)f.store.putHandoff(job(n,{handed_at:at(0),from_agent:n>=5?'trillion-workshop':'asker'}));
    assert.deepEqual(projected(f).work,[],'the page is selected before internal-origin exclusion');
    f.store.putHandoff(job(205,{handed_at:at(0)})); f.store.putHandoff(job(206,{handed_at:at(0)}));
    assert.deepEqual(f.owner.recentWork({limit:1,states:['finished'],projection}).work.map(row=>row.handoff_id),['h0206']);
    assert.deepEqual(f.store.finishedHandoffs({before:'h0206',limit:1,projection}).map(row=>row.handoff_id),['h0205']);
    assert.deepEqual(f.store.finishedHandoffs({before:'missing',limit:1,projection}),[]);
  } finally {f.host.db.close();}
});

test('same-key edits, removal, recreation, state transitions and rollback never retain old attestation', () => {
  const f=fixture(true),id='agent-handoff:h0001';
  try {
    f.store.putHandoff(job(1,{result:{withdrawn_by:null}})); assert.equal(projected(f).work[0].field_presence[0],true);
    f.store.putHandoff(job(1,{result:{ordinary:true}})); assert.equal(projected(f).work[0].field_presence[0],false);
    f.store.putHandoff(job(1,{state:'open'})); assert.deepEqual(projected(f).work,[]);
    f.store.putHandoff(job(1)); f.records.write([{id,value:null}]); assert.deepEqual(projected(f).work,[]);
    f.store.putHandoff(job(1,{result:{withdrawn_by:[]}})); assert.equal(projected(f).work[0].field_presence[0],true);
    f.records.checkpoint();
    assert.throws(()=>f.host.transaction(()=>{f.store.putHandoff(job(1,{result:{ordinary:true}}));throw Error('rollback witness');}),/rollback witness/);
    f.records.forgetCached(); assert.equal(projected(f).work[0].field_presence[0],true);
    f.store.putCard({agent_id:'holder',name:'New name'}); assert.equal(projected(f).agents.find(row=>row.agent_id==='holder').name,'New name');
    const fresh=recordLogStore(f.host.sql,f.options),store=agentRecordStore({records:fresh,transaction:f.host.transaction});
    assert.equal(store.finishedHandoffs({limit:1,projection})[0].field_presence[0],true);
  } finally {f.host.db.close();}
});

test('a non-scalar correction overwrites a prior scalar payload and falls back rather than lying',()=>{
  const f=fixture();
  try{
    f.store.putHandoff(job(1,{to_agent:'named'})); assert.equal(projected(f).work[0].to_agent,'named');
    f.store.putHandoff(job(1,{to_agent:{unexpected:'complete value'}}));
    const entry=f.records.scan('agent-handoff','time',{equal:[0],limit:1,carried:true})[0];
    assert.equal(entry.carried_defined,undefined);
    assert.deepEqual(projected(f).work[0].to_agent,{unexpected:'complete value'});
  }finally{f.host.db.close();}
});

test('legacy payloads and partial backfill hydrate only uncovered entries, with zero foreground writes',()=>{
  const old=indexData.indexes.map(index=>index.name==='time'&&index.type==='agent-handoff'
    ? (({carry,carry_presence,backfill,...base})=>base)(index):index);
  const f=fixture(true,old);
  try{
    for(let n=0;n<96;n++)f.store.putHandoff(job(n,{result:n%2?{withdrawn_by:null}:{ordinary:true}}));
    f.records.checkpoint();
    const records=recordLogStore(f.host.sql,{...f.options,indexes:indexData.indexes}),store=agentRecordStore({records,transaction:f.host.transaction});
    const owner=makeAgents({store}),read=()=>owner.recentWork({limit:200,states:['finished'],projection});
    assert.equal(records.indexReady('agent-handoff','time'),false);
    const before=read(); let hydrated=[]; const projectOf=records.fields.projectOf;
    records.fields.projectOf=(type,ids,request)=>{hydrated.push(...ids);return projectOf(type,ids,request);};
    store.putHandoff(job(1000,{result:{withdrawn_by:null}})); const logEnd=records.lastLogId();
    assert.equal(read().work.length,97); assert.equal(hydrated.length,96); assert.ok(!hydrated.includes('agent-handoff:h1000'));
    assert.equal(records.lastLogId(),logEnd,'foreground reads do not backfill');
    for(let n=0;n<300&&!records.indexReady('agent-handoff','time');n++)records.maintain();
    assert.equal(records.indexReady('agent-handoff','time'),true); hydrated=[];
    assert.deepEqual(read().work.slice(1),before.work); assert.deepEqual(hydrated,[]);
  }finally{f.host.db.close();}
});

test('a completed index build cannot certify changed carry order or presence paths',()=>{
  const host=sqliteHost(':memory:');
  const one={type:'note',name:'at',paths:[['at']],carry:[['a'],['b']],carry_presence:[['nested','value']],backfill:'carried-v1'};
  const options={transaction:host.transaction,indexes:[one]};
  try{
    let records=recordLogStore(host.sql,options);records.write([{id:'note:1',type:'note',value:{at:1,a:'A',b:null,nested:{value:false}}}]);records.checkpoint();
    assert.equal(records.indexReady('note','at'),true);
    const changed={...one,carry:[['b'],['a'],['missing']],carry_presence:[['nested','absent']]};
    records=recordLogStore(host.sql,{...options,indexes:[changed]});
    assert.equal(records.indexReady('note','at'),false);
    assert.equal(records.scan('note','at',{limit:1,carried:true})[0].carried_defined,undefined,'old entry payload rejected independently of saved readiness');
    for(let n=0;n<100&&!records.indexReady('note','at');n++)records.maintain();
    const entry=records.scan('note','at',{limit:1,carried:true})[0];
    assert.equal(records.indexReady('note','at'),true);
    assert.deepEqual(entry.carried_defined,{b:true,a:true,missing:false});assert.deepEqual(entry.carried_presence,{'["nested","absent"]':false});
    assert.equal(entry.carried.a,'A');assert.equal(entry.carried.b,null);
  }finally{host.db.close();}
});

test('carried erasable scalars stay sealed and leave their index on erase',()=>{
  const host=sqliteHost(':memory:'),words='CARRY_ERASURE_PRIVATE_SENTINEL';
  const index={type:'message',name:'carried-erasure',paths:[['at']],carry:[['text']],carry_presence:[['text']],backfill:'carried-erasure-v1'};
  try{
    const records=recordLogStore(host.sql,{transaction:host.transaction,model:RECORD_MODEL,indexes:[...RECORD_INDEXES,index]});
    records.write([{id:'message:erase',type:'message',value:{app:'Fixture',speaker:'person',at:at(0),text:words}}]);records.checkpoint();
    assert.equal(records.scan('message','carried-erasure',{limit:1,carried:true})[0].carried.text,words);
    const tables=host.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray();
    const plain=()=>tables.some(({name})=>host.sql.exec(`SELECT * FROM "${name}"`).toArray().some(row=>Object.values(row).some(value=>
      (typeof value==='string'?value:value instanceof Uint8Array?new TextDecoder().decode(value):'').includes(words))));
    assert.equal(plain(),false,'index payload, pages and log contain no plaintext carried words');
    assert.equal(records.erase('message:erase').erased,'message:erase');
    assert.deepEqual(records.scan('message','carried-erasure',{limit:1,carried:true}),[]);
    assert.equal(records.read('message:erase'),null);assert.equal(plain(),false);
  }finally{host.db.close();}
});


test('time SQL failure is not an empty answer, and unsupported projection failure is not partial success',()=>{
  const f=fixture();
  try{
    f.store.putHandoff(job(1,{result:{ordinary:true}}));
    const scan=f.records.scan;
    f.records.scan=(type,name,options)=>{if(type==='agent-handoff'&&name==='time')throw Error('injected time SQL failure');return scan(type,name,options);};
    assert.throws(()=>projected(f),/injected time SQL failure/);
    f.records.scan=scan;
    const projectOf=f.records.fields.projectOf;
    f.records.fields.projectOf=()=>{throw Error('injected fallback SQL failure');};
    assert.throws(()=>f.owner.recentWork({states:['finished'],projection:{fields:['result']}}),/injected fallback SQL failure/);
    f.records.fields.projectOf=projectOf;
    assert.equal(projected(f).work.length,1,'a fresh retry returns the real row');
  }finally{f.host.db.close();}
});


test('carried scalar metadata adds bounded retained bytes for complete large handoffs', t => {
  const measurements=[];
  for(const carried of [false,true]) {
    const indexes=indexData.indexes.map(index=>{
      if(carried || index.type!=='agent-handoff' || index.name!=='time')return index;
      const {carry,carry_presence,backfill,...legacy}=index;return legacy;
    });
    const f=fixture(false,indexes);
    try {
      for(let n=0;n<128;n++){
        f.store.putHandoff(job(n,{result:{body:'UNREQUESTED_BODY'.repeat(4400)},input:{body:'UNREQUESTED_INPUT'.repeat(4000)}}));
        if(n%8===7)f.records.checkpoint();
      }
      const bytes=f.host.db.prepare('SELECT SUM(pgsize-unused) AS bytes FROM dbstat').get().bytes;
      const full=f.owner.recentWork({limit:200,states:['finished']});
      measurements.push({carried,bytes,hash:hash(JSON.stringify(full))});
    } finally {f.host.db.close();}
  }
  assert.equal(measurements[0].hash,measurements[1].hash,'stored full-result behavior unchanged');
  const extra=measurements[1].bytes-measurements[0].bytes;
  t.diagnostic(JSON.stringify({retained_metadata:measurements,extra_bytes:extra,extra_bytes_per_handoff:extra/128}));
  assert.ok(extra<=128*1024,'fixed scalar metadata must add at most 1KiB per handoff');
});


test('a writer lacking the carried declaration cannot leave a trusted stale checkpoint', () => {
  const f=fixture();
  try {
    f.store.putHandoff(job(1,{result:{withdrawn_by:null}}));f.records.checkpoint();
    assert.equal(projected(f).work[0].field_presence[0],true);
    const legacy=indexData.indexes.map(index=>index.type==='agent-handoff' && index.name==='time'
      ? (({carry,carry_presence,backfill,...old})=>old)(index):index);
    const prior=recordLogStore(f.host.sql,{...f.options,indexes:legacy});
    const oldStore=agentRecordStore({records:prior,transaction:f.host.transaction});
    oldStore.putHandoff(job(1,{finished_at:at(2),to_agent:'new-holder',result:{ordinary:true}}));prior.checkpoint();
    const records=recordLogStore(f.host.sql,f.options);
    const store=agentRecordStore({records,transaction:f.host.transaction}),owner=makeAgents({store});
    assert.equal(records.indexReady('agent-handoff','time'),false);
    assert.equal(records.scan('agent-handoff','time',{limit:1,carried:true})[0].carried_defined,undefined);
    const expected=owner.recentWork({states:['finished']}).work.map(row=>projectHandoff(row,handoffProjection(projection)));
    assert.deepEqual(owner.recentWork({states:['finished'],projection}).work,expected);
    for(let n=0;n<200&&!records.indexReady('agent-handoff','time');n++)records.maintain();
    assert.equal(records.indexReady('agent-handoff','time'),true);
    records.fields.projectOf=()=>{throw Error('rebuilt metadata should answer the projection');};
    assert.deepEqual(owner.recentWork({states:['finished'],projection}).work,expected);
    const reopened=recordLogStore(f.host.sql,f.options);
    assert.equal(reopened.indexReady('agent-handoff','time'),true,'supported checkpoint preserves epoch on reopen');
  } finally {f.host.db.close();}
});
