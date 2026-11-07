import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { identityOf } from '../src/decision-store.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { makeAgents, handleAgentsRequest } from '../../shared-code/src/agents.mjs';
import { readHandoffResultSource } from '../../shared-code/src/handoff-result-source.mjs';
const ACTOR={actor:{by:'synthetic-proof'}};
const original=()=>({text:'Synthetic complete original',segments:Array.from({length:2000},(_,n)=>({start:n,end:n+1,text:`segment ${n}`,words:Array.from({length:3},(_,at)=>({word:`word ${n}:${at}`,start:n+at/10,end:n+(at+1)/10,speaker:1,confidence:.9}))})),heard_whole:true});
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
const descriptor=bytes=>({identity:identityOf(new TextDecoder().decode(bytes)),byte_length:bytes.length,format:'application/json'});
function fixture(t,{engine='record-log',large=true,seed=true}={}){
 const host=sqliteHost(':memory:');t.after(()=>host.db.close());setRecordEngine(host.sql,engine);
 const records=openRecords(host.sql,{transaction:host.transaction,hash:identityOf});
 const store=agentRecordStore({records,transaction:host.transaction});let effects=0;
 const agents=makeAgents({store,now:()=>new Date('2026-10-11T12:00:00Z'),onFinished:()=>{effects++;}});
 agents.publish({agent_id:'worker',name:'Synthetic',description:'Synthetic',takes_work:true});
 const h=agents.handOff({job:'Synthetic legacy result',to_agent:'worker',request_key:'synthetic-legacy-recovery'}).handoff;
 const lease=agents.take({handoff_id:h.handoff_id,agent_id:'worker'}),input={handoff_id:h.handoff_id,agent_id:'worker',generation:lease.generation};
 const result=large?original():{text:'Synthetic small whole answer'};
 if(seed){agents.finish({...input,result});records.checkpoint?.();records.forgetCached();effects=0;}
 return{host,records,store,agents,input,result,key:'agent-handoff:'+h.handoff_id,payload:'agent-handoff-result:'+h.handoff_id,get effects(){return effects;}};
}
function sourceOf(result,json=JSON.stringify(result)){
 const bytes=new TextEncoder().encode(json);let opens=0,accesses=0,deny=false;
 const access=()=>{accesses++;if(deny)throw Object.assign(Error('Synthetic plan refusal'),{status:402,result_source_refusal:true,withheld:{error:'Synthetic plan refusal'}});};
 return{wire:descriptor(bytes),get opens(){return opens;},get accesses(){return accesses;},set deny(value){deny=value;},
  checkResultSourceAccess:async(_source,admit)=>{admit();access();},
  resolveResultSource:(source,admit)=>readHandoffResultSource(source,{privateReach:true,admit,open:async()=>{access();opens++;return{byte_length:bytes.length,stream:()=>new Blob([bytes]).stream()};}})};
}
const post=(f,source,extra={},options=source)=>handleAgentsRequest(f.agents,new Request('https://fixture.test/handoffs/finish',{method:'POST',body:JSON.stringify({...f.input,result_source:source.wire,...extra})}),options);
const meta=f=>f.records.readOwn(f.key,['result','corrections']);
// Preserve omitted owner fields in place: readOwn metadata includes sealed values and must never be resubmitted as logical data.
const change=(f,patch)=>f.records.writeOwn(f.key,'agent-handoff',patch,[...new Set([...Object.keys(meta(f)),'result','corrections'])].filter(name=>!Object.hasOwn(patch,name)),ACTOR);

test('packed owner recovers genuine accepted oversized inline root, seals exact payload, preserves metadata and never replays finish effects',async t=>{
 const f=fixture(t),before=meta(f),source=sourceOf(f.result);assert.ok(f.records.sizeOf(f.key).rows>30000);assert.throws(()=>f.store.handoff(f.input.handoff_id),error=>error.code==='record_too_large');
 assert.ok(f.agents.resultSourceCapabilities(f.input).legacy_result_recovery?.version);
 const response=await post(f,source);assert.equal(response.status,200,await response.clone().text());const reply=await response.json();
 assert.equal(reply.repeated,true);assert.equal(reply.completion_receipt,true);assert.equal(Object.hasOwn(reply.handoff,'result'),false);assert.equal(f.effects,0);assert.equal(source.opens,1);
 const after=meta(f);assert.equal(f.records.ownFieldPresent(f.key,'result'),false);assert.equal(after.result_record,f.payload);
 const {result_record,result_source_receipt,...unchanged}=after;const {result_record:_oldPointer,result_source_receipt:_oldReceipt,...expectedUnchanged}=before;assert.equal(_oldReceipt,null);assert.deepEqual(unchanged,expectedUnchanged);assert.deepEqual(result_source_receipt,{...source.wire,generation:f.input.generation,agent_id:'worker'});
 assert.deepEqual(f.store.handoff(f.input.handoff_id).result,f.result);assert.equal(f.agents.resultSourceCapabilities(f.input).legacy_result_recovery,undefined);
 f.records.checkpoint?.();f.records.forgetCached();assert.deepEqual(f.agents.read({handoff_id:f.input.handoff_id}).handoff.result,f.result);
 assert.equal((await post(f,source)).status,200);assert.equal(source.opens,1);assert.equal(f.effects,0);
 source.deny=true;assert.equal((await post(f,source)).status,402);assert.equal(source.opens,1);
 source.deny=false;f.agents.reopenIncorrectFinish({handoff_id:f.input.handoff_id,evidence:'Synthetic correction'});assert.equal(f.records.read(f.payload),null);assert.equal(f.store.handoff(f.input.handoff_id).result,null);
});

test('legacy recovery keeps the verified formatted source while comparing its logical original and reopening it whole',async t=>{
 const f=fixture(t),source=sourceOf(f.result,JSON.stringify(f.result,null,2));
 const response=await post(f,source);assert.equal(response.status,200,await response.clone().text());
 const reply=await response.json();assert.equal(reply.repeated,true);assert.equal(reply.completion_receipt,true);
 assert.deepEqual(meta(f).result_source_receipt,{...source.wire,generation:f.input.generation,agent_id:'worker'});
 f.records.checkpoint?.();f.records.forgetCached();assert.deepEqual(f.agents.read({handoff_id:f.input.handoff_id}).handoff.result,f.result);
 assert.equal((await post(f,source)).status,200);assert.equal(source.opens,1);assert.equal(f.effects,0);
});

test('wrong original equality at first/middle/last rolls back payload and leaves legacy root and source receipt unchanged',async t=>{
 const f=fixture(t),before=meta(f);
 for(const n of [0,999,1999]){
  const wrong=structuredClone(f.result);wrong.segments[n].words[1].word='different';const source=sourceOf(wrong),response=await post(f,source);
  assert.equal(response.status,400);assert.match((await response.json()).error,/differs/);assert.deepEqual(meta(f),before);assert.equal(f.records.read(f.payload),null);assert.equal(f.effects,0);
  assert.equal(f.records.matchesOwnField(f.key,'agent-handoff','result',f.result),true);
 }
});

test('wrong holder, generation and unresolved effects refuse before opening source, including forged caller receipt fields',async t=>{
 const f=fixture(t),source=sourceOf(f.result),before=meta(f);
 for(const extra of [{agent_id:'wrong'},{generation:f.input.generation+1}])assert.equal((await post(f,source,extra)).status,400);
 change(f,{effects:{e:{effect_id:'e',state:'unknown'}}});assert.equal((await post(f,source,{result_source_receipt:{...source.wire,generation:f.input.generation,agent_id:'worker'}})).status,400);
 assert.equal(source.opens,0);assert.equal(f.records.read(f.payload),null);assert.equal(f.effects,0);change(f,{effects:before.effects??{}});
 source.deny=true;assert.equal((await post(f,source)).status,402);assert.equal(f.records.read(f.payload),null);
});

test('source decode yield cannot bypass a changed generation or newly unsettled effect inside transaction',async t=>{
 for(const patch of [{generation:99},{effects:{e:{effect_id:'e',state:'starting'}}}]){
  const f=fixture(t),source=sourceOf(f.result),options={...source,resolveResultSource:async(...args)=>{const result=await source.resolveResultSource(...args);change(f,patch);return result;}};
  assert.equal((await post(f,source,{},options)).status,400);assert.equal(source.opens,1);assert.equal(f.records.read(f.payload),null);assert.equal(meta(f).result_source_receipt,null);assert.equal(f.effects,0);
 }
});

test('failure after actual field rewrite rolls back root, payload, receipt and pending owner cache',async t=>{
 const f=fixture(t),before=meta(f),source=sourceOf(f.result),rewrite=f.records.rewriteOwnFieldJsonIfEqual;
 f.records.rewriteOwnFieldJsonIfEqual=(...args)=>{assert.equal(rewrite(...args),true);throw Error('Synthetic failure after rewrite');};
 // A backend failure is not a refused request: the handler keeps its cause for the host's failure owner (handleAgentsRequest).
 await assert.rejects(post(f,source),/Synthetic failure after rewrite/);assert.deepEqual(meta(f),before);assert.equal(f.records.read(f.payload),null);assert.equal(f.records.matchesOwnField(f.key,'agent-handoff','result',f.result),true);assert.equal(f.effects,0);
 f.records.rewriteOwnFieldJsonIfEqual=rewrite;assert.equal((await post(f,source)).status,200);assert.equal(source.opens,2);
});

test('recovered handoff erasure reaches sealed separate payload',async t=>{
 const f=fixture(t),source=sourceOf(f.result);assert.equal((await post(f,source)).status,200);
 const erased=f.records.erase(f.key,ACTOR);assert.ok(erased.also.includes(f.payload));assert.equal(f.records.read(f.payload),null);
});

test('taken roots and unsupported decomposed owners expose no legacy recovery marker; small legacy fallback remains authoritative',async t=>{
 const taken=fixture(t,{seed:false});assert.equal(taken.agents.resultSourceCapabilities(taken.input).legacy_result_recovery,undefined);
 const f=fixture(t,{engine:'eeaf',large:false}),source=sourceOf(f.result);assert.equal(f.records.ownFieldRecoveryVersion(),null);assert.equal(f.agents.resultSourceCapabilities(f.input).legacy_result_recovery,undefined);
 assert.equal((await post(f,source)).status,200);assert.deepEqual(f.store.handoff(f.input.handoff_id).result,f.result);assert.equal(f.effects,0);
 const large=fixture(t,{engine:'eeaf'}),largeSource=sourceOf(large.result);assert.equal(large.agents.resultSourceCapabilities(large.input).legacy_result_recovery,undefined);
 const response=await post(large,largeSource);assert.equal(response.status,400);assert.equal((await response.json()).result_transport_code,'record_read_too_large');assert.equal(large.records.read(large.payload),null);
});

function seedInlineHistory(f) {
 const corrections=[{corrected_at:'2026-10-10T23:00:00Z',evidence:'Synthetic complete correction evidence',prior_finished_at:'2026-10-10T22:00:00Z',prior_result:original(),prior_summary:'Synthetic prior summary'}];
 change(f,{result:null,corrections});
 f.records.checkpoint?.();f.records.forgetCached();return corrections;
}

test('taken oversized correction history is normalized losslessly before source finish, remains private in projections and survives restart and erasure',async t=>{
 const f=fixture(t,{seed:false}),corrections=seedInlineHistory(f),source=sourceOf(f.result),history=f.payload+':corrections';
 assert.throws(()=>f.store.handoff(f.input.handoff_id),e=>e.code==='record_too_large');
 const capability=f.agents.resultSourceCapabilities(f.input);assert.ok(capability.inline_history_recovery?.version);assert.equal(capability.legacy_result_recovery,undefined);
 assert.equal((await post(f,source)).status,200);assert.equal(f.effects,1);assert.equal(f.records.ownFieldPresent(f.key,'corrections'),false);assert.equal(meta(f).corrections_record,history);
 const kept=f.store.handoff(f.input.handoff_id);assert.deepEqual(kept.corrections,corrections);assert.deepEqual(kept.result,f.result);assert.equal(Object.hasOwn(kept,'corrections_record'),false);
 const selected=f.store.handoff(f.input.handoff_id,{projection:{fields:['state','corrections'],presence:[['corrections','0','prior_result','heard_whole']]}});
 assert.deepEqual(selected.corrections,corrections);assert.deepEqual(selected.field_presence,[true]);assert.equal(Object.hasOwn(selected,'corrections_record'),false);
 f.records.checkpoint?.();f.records.forgetCached();assert.deepEqual(f.store.handoff(f.input.handoff_id).corrections,corrections);
 assert.equal((await post(f,source)).status,200);assert.equal(f.effects,1);assert.equal(source.opens,1);
 const erased=f.records.erase(f.key,ACTOR);assert.ok(erased.also.includes(history));assert.ok(erased.also.includes(f.payload));assert.equal(f.records.read(history),null);assert.equal(f.records.read(f.payload),null);
});

test('history normalization rollback removes the sealed history and preserves original current history after an owner failure',async t=>{
 const f=fixture(t,{seed:false}),corrections=seedInlineHistory(f),before=meta(f),source=sourceOf(f.result),rewrite=f.records.rewriteOwnFieldJsonIfEqual;
 f.records.rewriteOwnFieldJsonIfEqual=(...args)=>{assert.equal(rewrite(...args),true);throw Error('Synthetic post-history rewrite failure');};
 await assert.rejects(post(f,source),/Synthetic post-history rewrite failure/);assert.deepEqual(meta(f),before);assert.equal(f.records.read(f.payload+':corrections'),null);assert.equal(f.records.read(f.payload),null);assert.equal(f.effects,0);
 assert.equal(f.records.matchesOwnField(f.key,'agent-handoff','corrections',corrections),true);
 f.records.rewriteOwnFieldJsonIfEqual=rewrite;assert.equal((await post(f,source)).status,200);assert.equal(f.effects,1);
});

test('taken-history admission refuses wrong holder, generation and unsettled effects before source access and decode-yield changes before repair',async t=>{
 for(const patch of [{generation:99},{taken_by:'other'},{effects:{e:{state:'starting',effect_id:'e'}}}]){
  const f=fixture(t,{seed:false});seedInlineHistory(f);const source=sourceOf(f.result),options={...source,resolveResultSource:async(...args)=>{const result=await source.resolveResultSource(...args);change(f,patch);return result;}};
  assert.equal((await post(f,source,{},options)).status,400);assert.equal(f.records.read(f.payload+':corrections'),null);assert.equal(f.records.read(f.payload),null);assert.equal(f.effects,0);
 }
 const f=fixture(t,{seed:false});seedInlineHistory(f);const source=sourceOf(f.result);
 for(const extra of [{agent_id:'other'},{generation:99}])assert.equal((await post(f,source,extra)).status,400);
 change(f,{effects:{e:{state:'unknown',effect_id:'e'}}});assert.equal((await post(f,source)).status,400);assert.equal(source.opens,0);
});

test('normal corrections use shared sealed owner on both engines and expose logical original history after reopening',async t=>{
 for(const engine of ['record-log','eeaf']){
  const f=fixture(t,{engine,large:false}),source=sourceOf(f.result);assert.equal((await post(f,source)).status,200);
  const corrected=f.agents.reopenIncorrectFinish({handoff_id:f.input.handoff_id,evidence:'Synthetic lossless reopen'}).handoff;
  assert.deepEqual(corrected.corrections[0].prior_result,f.result);assert.equal(f.records.ownFieldPresent(f.key,'corrections'),false);
  f.records.checkpoint?.();f.records.forgetCached();assert.deepEqual(f.store.handoff(f.input.handoff_id).corrections,corrected.corrections);
  const history=f.payload+':corrections';assert.equal(meta(f).corrections_record,history);
  if(engine==='record-log'){assert.ok(f.records.erase(f.key,ACTOR).also.includes(history));assert.equal(f.records.read(history),null);}
  else assert.throws(()=>f.records.erase(f.key,ACTOR),/eeaf records do not answer erase/,'EEAF erasure is not an available owner operation; do not claim it');
 }
});

test('transport predecessor marker binds authentic byte bound to exact current lease and settled effects; unsupported owner stays fenced',t=>{
 const bytes=2797536,f=fixture(t,{seed:false});const input={...f.input,result_byte_length:bytes};
 assert.deepEqual(f.agents.resultSourceCapabilities(input).transport_limit_recovery,{version:'record-log-complete-source-admission/v2',prior_max_bytes:2097152,max_bytes:4194304,result_byte_length:bytes});
 for(const n of [2097152,4194305,NaN,'2797536'])assert.equal(f.agents.resultSourceCapabilities({...f.input,result_byte_length:n}).transport_limit_recovery,undefined);
 for(const extra of [{generation:99},{agent_id:'wrong'}])assert.throws(()=>f.agents.resultSourceCapabilities({...input,...extra}));
 change(f,{effects:{e:{state:'unknown',effect_id:'e'}}});assert.throws(()=>f.agents.resultSourceCapabilities(input));
 const eeaf=fixture(t,{engine:'eeaf',seed:false});assert.equal(eeaf.agents.resultSourceCapabilities({...eeaf.input,result_byte_length:bytes}).transport_limit_recovery,undefined);
});
