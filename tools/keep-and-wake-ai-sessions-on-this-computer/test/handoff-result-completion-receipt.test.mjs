import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { identityOf } from '../src/decision-store.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { makeAgents, handleAgentsRequest } from '../../shared-code/src/agents.mjs';
import { readHandoffResultSource } from '../../shared-code/src/handoff-result-source.mjs';
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const descriptor = bytes => ({ identity: identityOf(new TextDecoder().decode(bytes)), byte_length: bytes.length, format: 'application/json' });
function fixture(t, { fallback = false, engine = 'record-log' } = {}) {
  const host=sqliteHost(':memory:'); t.after(()=>host.db.close()); setRecordEngine(host.sql,engine);
  const records=openRecords(host.sql,{transaction:host.transaction,hash:identityOf,contentId:(_type,value)=>identityOf(JSON.stringify(value))});
  assert.equal(records.engine(),engine);
  const store=agentRecordStore({records:fallback?{...records,fields:{...records.fields,projectOf:undefined}}:records,transaction:host.transaction});
  const agents=makeAgents({store,now:()=>new Date('2026-10-11T12:00:00Z')});
  agents.publish({agent_id:'worker',name:'Worker',description:'Synthetic work',takes_work:true});
  const h=agents.handOff({job:'Synthetic completed result',to_agent:'worker',request_key:'synthetic-completion'}).handoff;
  const lease=agents.take({handoff_id:h.handoff_id,agent_id:'worker'});
  return {host,records,store,agents,input:{handoff_id:h.handoff_id,agent_id:'worker',generation:lease.generation}};
}
function sourceOf(bytes) {
  let opens=0,accesses=0,refuse=false;
  return {
    get opens(){return opens;},get accesses(){return accesses;},set refuse(value){refuse=value;},
    resolveResultSource:(source,admit)=>readHandoffResultSource(source,{privateReach:true,admit,open:async()=>{opens++;return{byte_length:bytes.length,stream:()=>new Blob([bytes]).stream()};}}),
    checkResultSourceAccess:async(source,admit)=>{admit();accesses++;if(refuse)throw Object.assign(Error('Files withheld'),{status:402,result_source_refusal:true,withheld:{error:'Files withheld',upgrade_needed:true}});},
  };
}
const post=(agents,input,options)=>handleAgentsRequest(agents,new Request('https://fixture.test/handoffs/finish',{method:'POST',body:JSON.stringify(input)}),options);

test('real record owner persists source receipt atomically and repeats via projection without source bytes or result hydration',async t=>{
  const f=fixture(t),result={text:'x'.repeat(1_050_000),segments:[{text:'whole'}],heard_whole:true},bytes=encode(result),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
  const first=await post(f.agents,wire,source),answer=await first.json();assert.equal(first.status,200,JSON.stringify(answer));assert.ok(JSON.stringify(answer).length<2048);assert.equal(answer.completion_receipt,true);assert.equal(Object.hasOwn(answer.handoff,'result'),false);
  assert.deepEqual(f.agents.read({handoff_id:f.input.handoff_id}).handoff.result,result);
  const kept=f.store.handoff(f.input.handoff_id);assert.deepEqual(kept.result_source_receipt,{...descriptor(bytes),generation:f.input.generation,agent_id:'worker'});
  const read=f.store.handoff;let projected=0;
  f.store.handoff=(id,options)=>{assert.ok(options?.projection,'exact accepted retry cannot hydrate complete handoff');assert.ok(!options.projection.fields.includes('result'));projected++;return read(id,options);};
  const repeated=await post(f.agents,wire,source);assert.equal(repeated.status,200);assert.equal((await repeated.json()).repeated,true);
  assert.ok(projected>=2);assert.equal(source.opens,1);assert.equal(source.accesses,1);
  f.store.handoff=read;assert.deepEqual(f.agents.read({handoff_id:f.input.handoff_id}).handoff.result,result);
});

test('repeat retains current private Namespace access and ignores caller-owned receipt metadata',async t=>{
  const f=fixture(t),bytes=encode({text:'whole'}),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
  assert.equal((await post(f.agents,wire,source)).status,200);
  source.refuse=true;const refused=await post(f.agents,{...wire,result_source_receipt:{...descriptor(bytes),generation:f.input.generation,agent_id:'worker'}},source);
  assert.equal(refused.status,402);assert.deepEqual(await refused.json(),{error:'Files withheld',upgrade_needed:true});assert.equal(source.opens,1);
  source.refuse=false;
  for(const bad of [{...wire,agent_id:'other'},{...wire,generation:f.input.generation+1},{...wire,result_source:{...wire.result_source,identity:'1f:'+'0'.repeat(64)}},{...wire,result_source:{...wire.result_source,byte_length:bytes.length+1}}])
    assert.equal((await post(f.agents,bad,source)).status,400);
  assert.equal(source.opens,1,'conflicts and stale actor never reopen source');
  assert.equal((await post(f.agents,wire,source)).status,200);
});

test('an unsettled effect or lease change during access refuses the compact receipt',async t=>{
  const f=fixture(t),bytes=encode({text:'whole'}),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};await post(f.agents,wire,source);
  const current=f.store.handoff(f.input.handoff_id);f.store.putHandoff({...current,effects:{e:{effect_id:'e',state:'unknown',generation:f.input.generation}}});
  assert.equal((await post(f.agents,wire,source)).status,400);assert.equal(source.opens,1);
  f.store.putHandoff(current);
  const changed={...source,checkResultSourceAccess:async(_source,admit)=>{admit();f.agents.reopenIncorrectFinish({handoff_id:f.input.handoff_id,evidence:'Synthetic reopen for race'});}};
  assert.equal((await post(f.agents,wire,changed)).status,400);
  const taken=f.agents.take({handoff_id:f.input.handoff_id,agent_id:'worker'});
  assert.notEqual(taken.generation,f.input.generation);assert.equal(f.store.handoff(f.input.handoff_id).result_source_receipt,null);
  assert.equal((await post(f.agents,{...wire,generation:taken.generation},source)).status,200);assert.equal(source.opens,2,'newly taken generation must verify bytes again');
});

test('legacy result verifies fully once before receipt backfill; unsupported projection preserves authoritative fallback',async t=>{
  for(const fallback of [false,true]){
    const f=fixture(t,{fallback}),result={text:'legacy whole'},bytes=encode(result),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
    f.agents.finish({...f.input,result,acceptedResultSource:descriptor(bytes),result_source_receipt:{...descriptor(bytes),generation:f.input.generation,agent_id:'worker'}});
    assert.equal(f.store.handoff(f.input.handoff_id).result_source_receipt,null,'caller body fields cannot establish receipt');
    const legacy=await post(f.agents,wire,source);assert.equal(legacy.status,200);assert.equal((await legacy.json()).repeated,true);assert.equal(source.opens,1);
    assert.equal((await post(f.agents,wire,source)).status,200);assert.equal(source.opens,1);
    assert.deepEqual(f.agents.read({handoff_id:f.input.handoff_id}).handoff.result,result);
  }
});

test('source finish rollback publishes neither result nor receipt; retry still decodes and commits once',async t=>{
  const f=fixture(t),bytes=encode({text:'whole'}),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
  const put=f.store.putHandoff;let fail=true;
  const failure = Error('Synthetic finish transaction failure');
  f.store.putHandoff=item=>{put(item);if(fail&&item.state==='finished')throw failure;};
  await assert.rejects(post(f.agents,wire,source), cause => cause === failure);
  const kept=f.store.handoff(f.input.handoff_id);assert.equal(kept.state,'taken');assert.ok(kept.result==null);assert.ok(kept.result_source_receipt==null);
  fail=false;assert.equal((await post(f.agents,wire,source)).status,200);assert.equal(source.opens,2);
  assert.equal((await post(f.agents,wire,source)).status,200);assert.equal(source.opens,2);
});

test('missing explicit access callback keeps verified legacy resolution instead of silently skipping Namespace access',async t=>{
  const f=fixture(t),bytes=encode({text:'whole'}),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
  assert.equal((await post(f.agents,wire,source)).status,200);
  const options={resolveResultSource:source.resolveResultSource};
  assert.equal((await post(f.agents,wire,options)).status,200);
  assert.equal(source.opens,2,'compatibility route must still resolve through its authenticated reader');
});

for(const engine of ['record-log','eeaf']) test(`${engine} payload preserves projections, rolls back with finish and retires on reopen`,async t=>{
  const f=fixture(t,{engine}),result={text:'Synthetic complete answer',segments:[{words:[{word:'whole'}]}]},bytes=encode(result),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
  assert.equal((await post(f.agents,wire,source)).status,200);
  const key='agent-handoff:'+f.input.handoff_id,payloadKey='agent-handoff-result:'+f.input.handoff_id;
  const physical=f.records.read(key);assert.equal(physical.result,null);assert.equal(physical.result_record,payloadKey);
  assert.deepEqual(f.store.handoff(f.input.handoff_id,{projection:{fields:['result'],presence:[['result','segments']]}}).result,result);
  const write=f.records.write;f.records.write=(...args)=>{write(...args);throw Error('Synthetic reopen rollback');};
  assert.throws(()=>f.agents.reopenIncorrectFinish({handoff_id:f.input.handoff_id,evidence:'Synthetic reopen proof'}));
  f.records.write=write;assert.deepEqual(f.store.handoff(f.input.handoff_id).result,result);assert.ok(f.records.read(payloadKey));
  f.agents.reopenIncorrectFinish({handoff_id:f.input.handoff_id,evidence:'Synthetic reopen proof'});
  assert.equal(f.records.read(payloadKey),null);assert.equal(f.store.handoff(f.input.handoff_id).result,null);
});

test('handoff erasure erases its sealed payload and its history',async t=>{
  const f=fixture(t),bytes=encode({text:'Synthetic private erase marker'}),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
  assert.equal((await post(f.agents,wire,source)).status,200);
  const key='agent-handoff:'+f.input.handoff_id,payloadKey='agent-handoff-result:'+f.input.handoff_id;
  assert.ok(f.records.read(payloadKey));
  const erased=f.records.erase(key,{actor:{by:'synthetic-proof'}});assert.ok(erased.also.includes(payloadKey));
  assert.equal(f.records.read(payloadKey),null);
  assert.ok(!JSON.stringify(f.records.recordAt(payloadKey,{known:new Date().toISOString()})).includes('Synthetic private erase marker'));
});

test('verified source finish preserves opaque history and owner metadata, clears explicitly, and refuses a corrupt history pointer',async t=>{
  const f=fixture(t),history=[{corrected_at:'2026-10-11T11:00:00.000Z',evidence:'Synthetic correction',prior_result:{text:'Earlier answer'}}];
  const current=f.store.handoff(f.input.handoff_id);
  f.store.putHandoff({...current,attempts:[...current.attempts,{generation:77,ended:'synthetic',owner_extension:{kept:true}}],target:{kept:'source-finish'},corrections:history});
  const bytes=encode({text:'Verified complete answer'}),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
  assert.equal((await post(f.agents,wire,source)).status,200);
  const finished=f.store.handoff(f.input.handoff_id),historyKey=`agent-handoff-result:${f.input.handoff_id}:corrections`;
  assert.equal(finished.target.kept,'source-finish');
  assert.deepEqual(finished.attempts.at(-1),{generation:77,ended:'synthetic',owner_extension:{kept:true}});
  assert.deepEqual(finished.corrections,history);
  assert.equal(f.records.read(`agent-handoff:${f.input.handoff_id}`).corrections_record,historyKey);
  f.store.putHandoff({...finished,corrections:[]});
  assert.equal(f.records.read(historyKey),null,'ordinary explicit clearing still retires the history payload');

  const corrupt=fixture(t),corruptCurrent=corrupt.store.handoff(corrupt.input.handoff_id);
  corrupt.store.putHandoff({...corruptCurrent,corrections:history});
  const rootKey=`agent-handoff:${corrupt.input.handoff_id}`,own=corrupt.records.readOwn(rootKey,['result','corrections'],{openErasable:true});
  corrupt.records.write([{id:rootKey,type:'agent-handoff',value:{...own,corrections_record:`agent-handoff-result:${corrupt.input.handoff_id}:wrong`}}],{actor:{by:'synthetic-proof'}});
  const corruptBytes=encode({text:'Verified complete answer'}),corruptSource=sourceOf(corruptBytes);
  await assert.rejects(post(corrupt.agents,{...corrupt.input,result_source:descriptor(corruptBytes)},corruptSource), /Saved handoff content is unavailable/);
  assert.equal(corrupt.records.readOwn(rootKey,['result','corrections']).state,'taken');
});

for(const engine of ['record-log','eeaf'])test(`${engine} finished-window projection resolves complete source result and exact logical presence`,async t=>{
 const f=fixture(t,{engine}),result={text:'Synthetic whole answer',withdrawn_by:null},bytes=encode(result),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
 assert.equal((await post(f.agents,wire,source)).status,200);f.records.checkpoint?.();f.records.forgetCached();
 const full=f.store.finishedHandoffs({limit:1,projection:{fields:['result'],presence:[['result','text'],['result','withdrawn_by']]}});
 assert.deepEqual(full[0].result,result);assert.deepEqual(full[0].field_presence,[true,true]);assert.equal(Object.hasOwn(full[0],'result_record'),false);
 const compact=f.store.finishedHandoffs({limit:1,projection:{fields:['finished_at'],presence:[['result','withdrawn_by']]}});
 assert.deepEqual(compact[0].field_presence,[true]);assert.equal(Object.hasOwn(compact[0],'result'),false);
});

for(const engine of ['record-log','eeaf'])test(`${engine} pending metadata and pagination do not hydrate source answers`,async t=>{
 const f=fixture(t,{engine}),result={text:'Synthetic original',withdrawn_by:null},bytes=encode(result),source=sourceOf(bytes),wire={...f.input,result_source:descriptor(bytes)};
 assert.equal((await post(f.agents,wire,source)).status,200);
 const current=f.store.handoff(f.input.handoff_id),read=f.records.read;
 f.records.read=id=>{assert.ok(!id.startsWith('agent-handoff-result:'),'metadata cannot open a payload');return read(id);};
 f.store.transaction(()=>{
  f.store.putHandoff({...current,generation:99,effects:{a:{state:'unknown'}}});
  const kept=f.store.handoff(f.input.handoff_id,{projection:{fields:['generation','effects']}});
  assert.equal(kept.generation,99);assert.deepEqual(kept.effects,{a:{state:'unknown'}});
 });
 assert.deepEqual(f.store.finishedHandoffs({before:f.input.handoff_id,limit:1,projection:{fields:['finished_at']}}),[]);
 f.records.read=read;
});

for(const engine of ['record-log','eeaf']) test(`${engine} source finish opens retained erasable metadata without opening omitted history`, async t => {
  const f=fixture(t,{engine}), current=f.store.handoff(f.input.handoff_id);
  f.store.putHandoff({...current,said:'Synthetic private words',input:{said:'Synthetic nested words',owner_extension:{kept:true}},corrections:[{prior_result:{text:'Synthetic history'}}]});
  const key=`agent-handoff:${f.input.handoff_id}`;
  const own=f.records.readOwn(key,['result','corrections'],{openErasable:true});
  assert.equal(own.job,current.job);assert.equal(own.said,'Synthetic private words');assert.equal(own.input.said,'Synthetic nested words');
  assert.equal(Object.hasOwn(own,'corrections'),false);assert.equal(Object.hasOwn(own,'result'),false);
  const bytes=encode({text:'Synthetic complete answer'}),source=sourceOf(bytes);
  const response=await post(f.agents,{...f.input,result_source:descriptor(bytes)},source);
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  const finished=f.store.handoff(f.input.handoff_id);
  assert.equal(finished.job,current.job);assert.equal(finished.said,'Synthetic private words');assert.equal(finished.input.said,'Synthetic nested words');
  assert.deepEqual(finished.input.owner_extension,{kept:true});assert.deepEqual(finished.corrections,[{prior_result:{text:'Synthetic history'}}]);
  if(engine==='record-log')assert.equal(typeof f.records.readOwn(key,['result','corrections']).job,'object','lossless raw recovery remains sealed by default');
});
