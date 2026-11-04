import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents, handleAgentsRequest } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import holds from '../../shared-code/src/work-holds.json' with { type: 'json' };
const START=Date.parse('2026-10-10T14:00:00Z'), MINUTE=60000;
function fixture(){let at=START;const store=agentStoreForTests(),agents=makeAgents({store,now:()=>new Date(at)});for(const agent_id of ['worker','other'])agents.publish({agent_id,name:agent_id,description:'Takes work',takes_work:true});return {store,agents,advance:m=>at+=m*MINUTE,now:()=>at};}
const hand=(f,key,extra={})=>f.agents.handOff({request_key:key,job:key,to_agent:'worker',...extra}).handoff;
const take=(f,input)=>{const due=[];return {answer:f.agents.take(input,{onReviewDue:at=>due.push(at)}),due};};
const finished=(f,job)=>f.store.putHandoff({...f.store.handoff(job.handoff_id),state:'finished',finished_at:new Date(f.now()).toISOString(),result:'done',review_at:null});

test('take and renewals report the hold including the maximum attempt cap',()=>{
 const f=fixture(),job=hand(f,'hold',{hold_minutes:2});
 const first=take(f,{agent_id:'worker',handoff_id:job.handoff_id});assert.deepEqual(first.due,[START+2*MINUTE]);
 const cap=START+2*holds.longest_hold_times*MINUTE;
 for(let i=1;i<2*holds.longest_hold_times;i++) {f.advance(1);const next=take(f,{agent_id:'worker',handoff_id:job.handoff_id,generation:1});assert.equal(next.answer.renewed,true);assert.deepEqual(next.due,[Math.min(f.now()+2*MINUTE,cap)]);}
 assert.equal(f.store.handoff(job.handoff_id).attempts.length,1);
});
test('a taken hold still expires after its prerequisite reopens',()=>{
 const f=fixture(),p=hand(f,'prerequisite',{to_agent:'other'});finished(f,p);
 const job=hand(f,'dependent',{depends_on:[p.handoff_id],hold_minutes:2});take(f,{agent_id:'worker',handoff_id:job.handoff_id});
 f.store.putHandoff({...f.store.handoff(p.handoff_id),state:'open',finished_at:null,result:null});f.advance(1);
 const next=take(f,{agent_id:'worker',handoff_id:job.handoff_id,generation:1});assert.equal(f.store.handoff(job.handoff_id).waits_open,1);assert.deepEqual(next.due,[Date.parse(next.answer.hold_until)]);
});
test('empty takes report immediately released dependents for another agent',()=>{
 const f=fixture(),a=hand(f,'lapse-a',{take_within_seconds:1}),b=hand(f,'lapse-b',{take_within_seconds:1});
 const dep=hand(f,'dependent',{to_agent:'other',depends_on:[a.handoff_id,b.handoff_id]});
 for(let n=0;!f.store.takeable.ready();n++){assert.ok(n<100);f.store.takeable.step();}f.advance(1);
 const next=take(f,{agent_id:'worker',only_mine:true});assert.equal(next.answer.handoff,null);assert.deepEqual(next.due,[f.now()]);
 for(const job of [a,b]){const kept=f.store.handoff(job.handoff_id);assert.equal(kept.state,'finished');assert.ok(kept.result.not_taken_by);}
 assert.equal(f.store.handoff(dep.handoff_id).waits_open,undefined);
 assert.equal(take(f,{agent_id:'other',handoff_id:dep.handoff_id}).answer.handoff.handoff_id,dep.handoff_id);
});
test('memory take and renewal create no durable reviews or deliveries',()=>{
 const f=fixture();let writes=0;for(const name of ['putHandoff','putDelivery']){const put=f.store[name];f.store[name]=item=>{writes++;return put(item);};}
 const job=hand(f,'memory',{in_memory:true,from_agent:'trillion-workshop',hold_minutes:2});
 const first=take(f,{agent_id:'worker',handoff_id:job.handoff_id});assert.equal(first.answer.handoff.state,'taken');assert.deepEqual(first.due,[]);f.advance(1);
 const next=take(f,{agent_id:'worker',handoff_id:job.handoff_id,generation:1});assert.equal(next.answer.renewed,true);assert.deepEqual(next.due,[]);assert.equal(writes,0);
});
test('a response error after a persisted take retains its reported review',async()=>{
 const f=fixture(),p=hand(f,'prerequisite',{to_agent:'other'});finished(f,p);const job=hand(f,'dependent',{depends_on:[p.handoff_id],hold_minutes:2});
 const put=f.store.putHandoff,read=f.store.handoff;let persisted=false;
 f.store.putHandoff=item=>{const answer=put(item);if(item.handoff_id===job.handoff_id&&item.state==='taken')persisted=true;return answer;};
 const failure=Error('response read failed after persisted take');
 f.store.handoff=id=>{if(persisted&&id===p.handoff_id)throw failure;return read(id);};
 const due=[];const pending=handleAgentsRequest(f.agents,new Request('https://person/handoffs/take',{method:'POST',body:JSON.stringify({agent_id:'worker',handoff_id:job.handoff_id})}),{onReviewDue:at=>due.push(at)});
 await assert.rejects(pending,cause=>cause===failure);assert.equal(read(job.handoff_id).state,'taken');assert.deepEqual(due,[Date.parse(read(job.handoff_id).hold_until)]);
});
