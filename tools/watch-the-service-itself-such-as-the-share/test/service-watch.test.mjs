import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { serviceWatch, readSavedServiceWatches } from '../do-work/service-watch.mjs';
const type = 'service-watch', id = 'service-watch:usage';
const rights = [{kind:type,prefix:'service-watch:',operations:['records:read','records:list','records:write']}];
const input = {operation:'configure',watch_id:'usage',connection_id:'service_connection:cloudflare:one',since:'2026-02-01',until:'2026-02-28',every_minutes:5};
const task = (key='wake-one',started_at='2026-11-08T10:00:00.000Z') => ({request_key:key,started_at});
const invoke = (input, door, t=task()) => serviceWatch({input,task:t},{door});
async function fixture(records=[],reading={state:'unread',reason:'provider_unreadable'}) {
 const server=await startFakeDoor({rights,records,runs:['tool:read-service-usage'],toolRuns:{'tool:read-service-usage':()=>reading}});
 const door=openRecordsDoor({descriptor:server.descriptor});
 return {...server,door};
}
test('account-owned CAS configure -> declared nested producer -> saved consumer; cold readback keeps due time and unread',async()=>{
 let f=await fixture(); let records;
 try {
  assert.equal((await invoke(input,f.door,task('configure'))).state,'configured');
  const result=await invoke({operation:'wake'},f.door);
  assert.equal(result.state,'saved');assert.equal(result.watch.latest.reading.state,'unread');
  assert.equal(result.watch.next_due_at,'2026-11-08T10:05:00.000Z');
  assert.equal(f.runsStarted.length,1);
  assert.deepEqual(f.runsStarted[0].input,{connection_id:input.connection_id,since:input.since,until:input.until});
  assert.equal((await invoke({operation:'wake'},f.door,task('early','2026-11-08T10:04:00Z'))).state,'idle');
  records=[...f.kept.values()];
 } finally {await f.close();}
 f=await fixture(records);
 try {
  const read=await readSavedServiceWatches({watch_id:'usage'},{door:f.door});
  assert.equal(read.watches[0].latest.run_key,'wake-one');assert.equal(read.watches[0].latest.reading.state,'unread');
  assert.equal(f.runsStarted.length,0);
 }finally{await f.close();}
});
test('a cold candidate preserves the exact original final key/body and refuses a new-context write or provider read',async()=>{
 const f=await fixture();let original;let saved;
 try {
  await invoke(input,f.door,task('configure'));
  const underlying=f.door.write.bind(f.door);
  f.door.write=async(records,options)=>{if(options.key.endsWith(':finish')){original={records:structuredClone(records),key:options.key};throw Object.assign(new Error('unknown'),{outcome:'unknown'});}return underlying(records,options);};
  const unknown=await invoke({operation:'wake'},f.door);
  assert.equal(unknown.state,'unresolved');assert.equal(unknown.original.request_key,original.key);
  saved=[...f.kept.values()];assert.equal(saved[0].value.in_flight.phase,'candidate');
 }finally{await f.close();}
 const fresh=await fixture(saved);
 try{
  fresh.door.write=async()=>assert.fail('fresh context must not replay a final write');
  fresh.door.result=async(command)=>{assert.deepEqual(command,{request_key:original.key,operation:'records:write',input:{records:original.records}});throw Object.assign(new Error('original cause cannot be proved'),{outcome:'unknown'});};
  const answer=await invoke({operation:'wake'},fresh.door,task('later','2026-11-08T10:20:00Z'));
  assert.equal(answer.reason,'original_context_unavailable');assert.equal(answer.parent_request_key,'wake-one');assert.equal(fresh.runsStarted.length,0);
 }finally{await fresh.close();}
});
test('claim without candidate stays unresolved after cold restart; no new parent key is used to reread the provider',async()=>{
 const claimed={...input,enabled:true,revision:1,next_due_at:'2026-11-08T10:00:00Z',latest:null,in_flight:{phase:'claimed',run_key:'original-parent',at:'2026-11-08T10:00:00Z'}};
 const f=await fixture([{id,type,value:claimed}]);
 try{assert.equal((await invoke({operation:'wake'},f.door)).reason,'candidate_unresolved');assert.equal(f.runsStarted.length,0);assert.equal(f.calls.some(c=>c.method==='records:write'),false);}finally{await f.close();}
});
test('current rights refusal and stale configure do not create provider requests or overwrite retained state',async()=>{
 const f=await fixture();
 try{
  await invoke(input,f.door,task('first'));
  assert.equal((await invoke(input,f.door,task('stale'))).reason,'conflict');
  assert.equal(f.runsStarted.length,0);
 }finally{await f.close();}
 const denied=await startFakeDoor({rights:[]});
 try{await assert.rejects(()=>invoke({operation:'wake'},openRecordsDoor({descriptor:denied.descriptor})),{code:'current_workspace_rights_refused'});}finally{await denied.close();}
});
test('pausing preserves unresolved command; a disabled watch and a future due date never read provider',async()=>{
 const f=await fixture();
 try{
  const configured=await invoke(input,f.door,task('first'));
  const paused=await invoke({operation:'pause',watch_id:'usage',expected:{type,value:configured.watch}},f.door,task('pause'));
  assert.equal(paused.state,'paused');assert.equal((await invoke({operation:'wake'},f.door)).state,'idle');assert.equal(f.runsStarted.length,0);
 }finally{await f.close();}
});
test('the complete cohort uses the native repeat wake and a distinct retained consumer with read-only rights',()=>{
 const rows=JSON.parse(readFileSync(new URL('../tool-rows.json',import.meta.url))).records.map(r=>r.payload);
 assert.deepEqual(rows.map(r=>r.id),['tool:read-service-usage','tool:keep-service-usage-watches','tool:read-saved-service-watches']);
 assert.equal(rows[1].wakes[0].on.time.every_ms,300000);assert.deepEqual(rows[1].invoke.stdin.task,{fill:{from:'task'}});
 assert.deepEqual(rows[2].invoke.records.rights[0].operations,['records:list','records:read']);assert.equal(rows[2].invoke.records.runs,undefined);
 const model=rows[1].record_model.kinds[0];assert.equal(model.type,type);assert.equal(model.stays_on_this_device,false);
 assert.ok(model.erasable.includes('latest'));assert.ok(model.erasable.includes('in_flight'));assert.equal(model.properties.enabled,'boolean');
 assert.equal(rows[0].record_model,undefined);assert.equal(rows[2].record_model,undefined);
});

test('actual declared lifecycle and consumer commands execute from their isolated full manifest closure',async()=>{
 const {answerOf}=await import('../../../test-helpers/run-a-row.mjs');
 const rows=JSON.parse(readFileSync(new URL('../tool-rows.json',import.meta.url))).records.map(r=>r.payload);
 const configured=await answerOf(rows[1],input,{task:task('isolated-configure')});
 assert.equal(configured.status,0);assert.equal(configured.result.state,'configured');
 const records=[...configured.kept.values()];
 const woke=await answerOf(rows[1],{operation:'wake'},{task:task('isolated-wake'),records,tool_runs:{'tool:read-service-usage':()=>({state:'unread',reason:'provider_unreadable'})}});
 assert.equal(woke.status,0);assert.equal(woke.result.state,'saved');
 const shown=await answerOf(rows[2],{watch_id:'usage'},{records:[...woke.kept.values()]});
 assert.equal(shown.status,0);assert.equal(shown.result.watches[0].latest.run_key,'isolated-wake');
});

test('the oldest due watch runs first, so a short interval cannot starve another watch',async()=>{
 const state=(watch_id,next_due_at)=>({watch_id,connection_id:input.connection_id,since:input.since,until:input.until,every_minutes:5,enabled:true,revision:1,next_due_at,latest:null});
 const f=await fixture([{id:'service-watch:z-newer',type,value:state('z-newer','2026-11-08T09:59:00Z')},{id:'service-watch:a-older',type,value:state('a-older','2026-11-08T09:50:00Z')}]);
 try{const result=await invoke({operation:'wake'},f.door);assert.equal(result.state,'saved');assert.equal(result.watch.watch_id,'a-older');assert.equal(f.runsStarted.length,1);}finally{await f.close();}
});

test('a lost final write reply uses the protected original result and never substitutes a fresh write',async()=>{
 const f=await fixture();
 try{
  await invoke(input,f.door,task('configure'));
  const underlying=f.door.write.bind(f.door);let final;let resultReads=0;let finalWrites=0;
  f.door.write=async(records,options)=>{const receipt=await underlying(records,options);if(options.key.endsWith(':finish')){finalWrites++;final={request_key:options.key,operation:'records:write',input:{records:structuredClone(records)}};throw Object.assign(new Error('lost'),{outcome:'unknown'});}return receipt;};
  f.door.result=async(original,options)=>{resultReads++;assert.deepEqual(original,final);assert.equal(options.key,final.request_key+':result');return {changed:true,write_count:1};};
  const result=await invoke({operation:'wake'},f.door);
  assert.equal(result.state,'saved');assert.equal(finalWrites,1);assert.equal(resultReads,1);
 }finally{await f.close();}
});

test('an unknown nested read retains its exact original parent, producer key and input without another provider attempt',async()=>{
 const f=await fixture();
 try{
  await invoke(input,f.door,task('configure'));
  let attempts=0;f.door.run=async()=>{attempts++;throw Object.assign(new Error('unreadable result'),{outcome:'unknown'});};
  assert.equal((await invoke({operation:'wake'},f.door,task('original-parent'))).reason,'reading_unresolved');
  const claimed=await f.door.read(type,id);
  assert.deepEqual(claimed.in_flight.producer,{parent_request_key:'original-parent',tool:'tool:read-service-usage',input:{connection_id:input.connection_id,since:input.since,until:input.until},request_key:'original-parent:reading'});
  assert.equal((await invoke({operation:'wake'},f.door,task('later-parent'))).reason,'candidate_unresolved');assert.equal(attempts,1);
 }finally{await f.close();}
});

test('the real fresh producer composes current provider DATA and HTTP execution into stored watch and saved consumer',async()=>{
 const {readServiceUsage}=await import('../do-work/read-service-usage.mjs');
 const shape=JSON.parse(readFileSync(new URL('../read-data/usage-reading.json',import.meta.url)));
 const usage=Object.fromEntries(Object.entries(shape.datasets).map(([dataset,groups])=>[dataset,[Object.fromEntries(Object.entries(groups).map(([group,fields])=>[group,Object.fromEntries(fields.map(field=>[field,group==='dimensions'?'read':3]))]))]]));
 let sends=0;
 const server=await startFakeDoor({rights,runs:['tool:read-service-usage'],toolRuns:{'tool:read-service-usage':async scope=>readServiceUsage(scope,{readHeld:fd=>fd===4?'synthetic-held-token-never-returned':'a'.repeat(32),fetchImpl:async(url,init)=>{sends++;assert.equal(url,'https://api.cloudflare.com/client/v4/graphql');assert.equal(JSON.parse(new TextDecoder().decode(init.body)).variables.a,'a'.repeat(32));return new Response(JSON.stringify({data:{viewer:{accounts:[usage]}}}));}})}});
 const door=openRecordsDoor({descriptor:server.descriptor});
 try{
  await invoke(input,door,task('configure'));
  const result=await invoke({operation:'wake'},door,task('actual-producer'));
  assert.equal(result.state,'saved');assert.equal(result.watch.latest.reading.state,'read');assert.equal(sends,1);
  const consumed=await readSavedServiceWatches({watch_id:'usage'},{door});assert.deepEqual(consumed.watches[0].latest.reading.usage,usage);
  assert.equal(JSON.stringify(consumed).includes('synthetic-held-token-never-returned'),false);
 }finally{await server.close();}
});

test('first-wake CAS uses authoritative admitted roots when Native stamps each write with its wake cause',async()=>{
 const f=await fixture();
 try{
  const underlying=f.door.write.bind(f.door);
  f.door.write=(records,options)=>underlying(records.map(row=>({...row,value:{...row.value,_wake_cause:options.key.split(':')[0]}})),options);
  const configured=await invoke(input,f.door,task('configured-cause'));
  assert.equal(configured.watch._wake_cause,'configured-cause');
  const saved=await invoke({operation:'wake'},f.door,task('current-cause'));
  assert.equal(saved.state,'saved');assert.equal(saved.watch._wake_cause,'current-cause');
  assert.equal(saved.watch.latest.reading.state,'unread');
  const consumed=await readSavedServiceWatches({watch_id:'usage'},{door:f.door});
  assert.deepEqual(consumed.snapshots[0].expected,{type,value:saved.watch});
 }finally{await f.close();}
});

test('delete uses the exact current root, refuses stale edits and unresolved custody, and reads back absence',async()=>{
 const f=await fixture();
 try{
  const configured=await invoke(input,f.door,task('configure'));
  assert.equal((await invoke({operation:'delete',watch_id:'usage',expected:null},f.door,task('stale-delete'))).reason,'conflict');
  assert.equal((await invoke({operation:'delete',watch_id:'usage',expected:configured.expected},f.door,task('delete'))).state,'deleted');
  assert.deepEqual((await readSavedServiceWatches({watch_id:'usage'},{door:f.door})).watches,[]);assert.equal(f.runsStarted.length,0);
  const recreated=await invoke(input,f.door,task('recreate'));
  f.door.run=async()=>{throw Object.assign(new Error('unknown'),{outcome:'unknown'});};
  await invoke({operation:'wake'},f.door,task('unresolved-read'));
  const pending=await f.door.readRecord(type,id);
  const refused=await invoke({operation:'delete',watch_id:'usage',expected:pending},f.door,task('delete-pending'));
  assert.equal(refused.reason,'in_flight');assert.ok((await f.door.read(type,id)).in_flight);
 }finally{await f.close();}
});

test('configure edits and resumes the exact retained watch without a provider request or a second schedule',async()=>{
 const f=await fixture();
 try{
  const configured=await invoke(input,f.door,task('configure'));
  const paused=await invoke({operation:'pause',watch_id:'usage',expected:configured.expected},f.door,task('pause'));
  const edited=await invoke({...input,connection_id:'service_connection:cloudflare:two',every_minutes:10,expected:paused.expected},f.door,task('edit'));
  assert.equal(edited.state,'configured');assert.equal(edited.watch.enabled,true);assert.equal(edited.watch.revision,3);
  assert.equal(edited.watch.connection_id,'service_connection:cloudflare:two');assert.equal(edited.watch.every_minutes,10);assert.equal(f.kept.size,1);assert.equal(f.runsStarted.length,0);
 }finally{await f.close();}
});
