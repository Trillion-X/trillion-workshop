// Ported from old trillion test/handoff-result-source-workerd.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The same Durable Object probe runs in workerd (miniflare, a dependency of this
// repository), bundled from where each owner lives now: openRecords and setRecordEngine from keep-and-wake's
// src/record-engine.mjs, identityOf from tools/shared-code/src/record-identity.mjs (old src/decision-store.mjs exported
// it), agentRecordStore from tools/hand-work-to-ais/agent-records.mjs, makeAgents and handleAgentsRequest from this tool's
// src/agents.mjs and readHandoffResultSource from this tool's src/handoff-result-source.mjs.
// Changed harness: the old bundle also installed the compiled Namespace identity module (src/namespace-identity-module.mjs
// through test/compiled-namespace-identity-fixture.mjs, whose built bytes this repository does not hold); without it
// identityOf answers with the JavaScript BLAKE3, the same identity (record-identity.mjs says so). Every assertion is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = new URL('../..', import.meta.url).pathname;
// Register sequential tests; root runs this file in its sole test lane.
const RESULT_SIZES = [1_538_693, 2_097_152];
async function inspector(runtime) {
  const address = new URL(await runtime.getInspectorURL()); address.protocol = 'http:';
  const listed = await fetch(new URL('/json/list', address));
  assert.equal(listed.status, 200, 'inspector HTTP endpoint must serve actual Workerd targets');
  const targets = await listed.json();
  const target = targets.find(t => t.webSocketDebuggerUrl && /result-source-witness/.test(JSON.stringify(t)));
  assert.ok(target?.webSocketDebuggerUrl, 'actual Workerd isolate inspector required; never substitute Node heap');
  const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let seq = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => { const row = JSON.parse(String(event.data)); if (!row.id) return; const waiter = pending.get(row.id); pending.delete(row.id); row.error ? waiter?.reject(Error(JSON.stringify(row.error))) : waiter?.resolve(row.result); });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  await call('Runtime.enable');
  return { heap: () => call('Runtime.getHeapUsage'), close: () => ws.close() };
}

for (const RESULT_BYTES of RESULT_SIZES) test(`actual Workerd ${RESULT_BYTES}-byte result finish/repeat/runtime-restart preserves original with measured physical bounds`, { timeout: 180000 }, async () => {
  const bundled = await build({ stdin: { sourcefile: 'result-source-entry.mjs', resolveDir: root, contents: `
export {openRecords,setRecordEngine} from './keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
export {identityOf} from './shared-code/src/record-identity.mjs';
export {agentRecordStore} from './hand-work-to-ais/agent-records.mjs';
export {makeAgents,handleAgentsRequest} from './shared-code/src/agents.mjs';
export {readHandoffResultSource} from './shared-code/src/handoff-result-source.mjs';` }, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error' });
  const worker = `import {DurableObject} from 'cloudflare:workers';
import {openRecords,setRecordEngine,identityOf,agentRecordStore,makeAgents,handleAgentsRequest,readHandoffResultSource} from './bundle.mjs';
const zero=()=>({statements:0,rows_read:0,rows_written:0,sql_bytes:0});
export class Probe extends DurableObject {
 async fetch(request) {
  const raw=this.ctx.storage.sql,u=new URL(request.url);let cost=zero();
  const sql={exec(query,...values){const cursor=raw.exec(query,...values);cost.statements++;let r=0,w=0;
   const charge=()=>{cost.rows_read+=cursor.rowsRead-r;cost.rows_written+=cursor.rowsWritten-w;r=cursor.rowsRead;w=cursor.rowsWritten;};charge();
   const it=cursor[Symbol.iterator](),wrapped={next(){const next=it.next();if(!next.done)for(const v of Object.values(next.value))cost.sql_bytes+=typeof v==='string'?new TextEncoder().encode(v).byteLength:v?.byteLength??8;charge();return next;},return(){const next=it.return?.()??{done:true};charge();return next;},[Symbol.iterator](){return this;}};
   return{toArray:()=>Array.from(wrapped),[Symbol.iterator]:()=>wrapped};}};
  const transaction=fn=>this.ctx.storage.transactionSync(fn);if(u.pathname==='/seed')setRecordEngine(sql,'record-log');
  const storageBefore=raw.databaseSize;if(!Number.isSafeInteger(storageBefore))throw Error('Actual Workerd SqlStorage.databaseSize is required');
  const records=openRecords(sql,{transaction,hash:identityOf,contentId:(_type,value)=>identityOf(JSON.stringify(value)),runs:{cache_bytes:0,filter_bytes:0,page_bytes:4096,max_runs:1000}});
  if(records.engine()!=='record-log')throw Error('explicit record-log engine required');
  const owner=agentRecordStore({records,transaction}),openedCost={...cost},agents=makeAgents({store:owner,now:()=>new Date('2026-10-11T12:00:00.000Z')});
  if(u.pathname==='/seed'){
   agents.publish({agent_id:'computer-tools',name:'Synthetic',description:'Synthetic',takes_work:true});
   const handoff=agents.handOff({job:'Synthetic full transcript',to_agent:'computer-tools',request_key:'large-result'}).handoff;
   const taken=agents.take({handoff_id:handoff.handoff_id,agent_id:'computer-tools'});records.checkpoint();
   return Response.json({engine:records.engine(),handoff_id:handoff.handoff_id,generation:taken.generation,storage_bytes:raw.databaseSize,cost});
  }
  if(u.pathname==='/read'){
   cost=zero();const kept=agents.read({handoff_id:u.searchParams.get('id')}).handoff;
   const value=JSON.stringify(kept.result);
   return Response.json({engine:records.engine(),constructor:openedCost,cost,storage_before:storageBefore,storage_bytes:raw.databaseSize,bytes:new TextEncoder().encode(value).length,identity:identityOf(value),result:kept.result});
  }
  const input=await request.json(),source=input.result_source;
  // Synthetic immutable source bytes; admission and finish use production owners. Namespace transport is separately qualified.
  let emitted=0,cancelled=0,sourceOpens=0,accessChecks=0;cost=zero();
  const response=await handleAgentsRequest(agents,new Request('https://fixture.test/handoffs/finish',{method:'POST',body:JSON.stringify(input)}),{
   checkResultSourceAccess:async(source,admit)=>{admit();accessChecks++;},
   resolveResultSource:(source,admit)=>readHandoffResultSource(source,{privateReach:true,admit,open:async identity=>{sourceOpens++;
    const original={text:'',segments:[{text:'whole',start:0}],language:'en',heard_whole:true,produced_by:'fixture'};
    original.text='x'.repeat(${RESULT_BYTES}-new TextEncoder().encode(JSON.stringify(original)).length);
    const bytes=new TextEncoder().encode(JSON.stringify(original));if(bytes.length!==${RESULT_BYTES})throw Error('fixture bytes drifted');
    return {byte_length:bytes.length,stream:()=>new ReadableStream({pull(controller){if(emitted===bytes.length)return controller.close();const next=bytes.subarray(emitted,Math.min(bytes.length,emitted+65536));emitted+=next.length;controller.enqueue(next);},cancel(){cancelled++;}})};}})});
  const finishCost={...cost},answer=await response.json();if(finishCost.rows_written)records.checkpoint();
  return Response.json({engine:records.engine(),constructor:openedCost,status:response.status,repeated:answer.repeated??false,cost:finishCost,checkpoint:cost,storage_before:storageBefore,storage_bytes:raw.databaseSize,emitted,cancelled,source_opens:sourceOpens,access_checks:accessChecks,receipt_bytes:new TextEncoder().encode(JSON.stringify(answer)).length,result_identity:answer.result_source?.identity??null,completion_receipt:answer.completion_receipt===true});
 }
}
export default {fetch(request,env){return env.PROBE.get(env.PROBE.idFromName('fixture')).fetch(request);}};`;
  const persistence=mkdtempSync(join(tmpdir(),'trillion-result-owner-witness-'));
  const options={ resourcePersistencePath:persistence, telemetry: { enabled: false }, inspectorPort: 0, workers: [{ config: {
    name: 'result-source-witness', compatibilityDate: '2026-09-01',
    manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: worker }, 'bundle.mjs': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    env: { PROBE: { type: 'durable-object', worker: 'result-source-witness', exportName: 'Probe' } }, exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] };
  let runtime=new Miniflare(options),cdp;
  try {
    const seed = await runtime.dispatchFetch('http://localhost/seed'); assert.equal(seed.status, 200, await seed.clone().text()); const lease = await seed.json(); assert.equal(lease.engine, 'record-log');
    cdp = await inspector(runtime); const baseline = await cdp.heap(), heaps = [baseline];
    const { identityOf } = await import('../src/record-identity.mjs');
    const result = { text: '', segments: [{ text: 'whole', start: 0 }], language: 'en', heard_whole: true, produced_by: 'fixture' };
    result.text='x'.repeat(RESULT_BYTES-new TextEncoder().encode(JSON.stringify(result)).length);
    const resultJson=JSON.stringify(result), identity=identityOf(resultJson);assert.ok(/^1f:/.test(identity),'must match namespace byte identity');
    const wire={handoff_id:lease.handoff_id,agent_id:'computer-tools',generation:lease.generation,result_source:{identity,byte_length:RESULT_BYTES,format:'application/json'}};
    const reports=[];
    for(let run=0;run<2;run++){
      let completed=false;const pending=runtime.dispatchFetch('http://localhost/finish',{method:'POST',body:JSON.stringify(wire)}).finally(()=>{completed=true;});
      for(let sample=0;sample<32&&!completed;sample++)heaps.push(await cdp.heap());
      const response=await pending;assert.equal(response.status,200,await response.clone().text());const report=await response.json();reports.push(report);
      assert.equal(report.engine,'record-log');assert.equal(report.status,200);assert.equal(report.result_identity,identity);assert.equal(report.emitted,run===0?RESULT_BYTES:0);assert.equal(report.source_opens,run===0?1:0);assert.equal(report.access_checks,run===0?0:1);assert.ok(report.receipt_bytes<2048);assert.equal(report.completion_receipt,true);assert.equal(report.cancelled,0);assert.equal(report.repeated,run===1);
      assert.ok(report.cost.statements<2000,JSON.stringify(report.cost));assert.ok(report.cost.rows_read<2000,JSON.stringify(report.cost));assert.ok(report.cost.rows_written<500,JSON.stringify(report.cost));
      if(run===1){assert.equal(report.cost.rows_written,0,'identical acknowledged result cannot write a new completion');assert.equal(report.checkpoint.rows_written,0,'repeat checkpoint cannot write');assert.equal(report.storage_bytes,report.storage_before,'repeat cannot grow the actual database');}
      assert.ok(report.storage_bytes<16*1024*1024,'physical database for one complete answer must stay below 16MiB');
      heaps.push(await cdp.heap());
    }
    cdp.close();cdp=null;await runtime.dispose();runtime=new Miniflare(options);
    // A new Workerd runtime reopens the same persisted SQLite; no cached JS owner can carry the answer.
    const replay=await runtime.dispatchFetch('http://localhost/finish',{method:'POST',body:JSON.stringify(wire)});
    assert.equal(replay.status,200,await replay.clone().text());const restarted=await replay.json();
    assert.equal(restarted.status,200);assert.equal(restarted.repeated,true);assert.equal(restarted.result_identity,identity);assert.equal(restarted.source_opens,0);assert.equal(restarted.emitted,0);assert.equal(restarted.access_checks,1);assert.ok(restarted.receipt_bytes<2048);
    assert.equal(restarted.cost.rows_written,0);assert.equal(restarted.checkpoint.rows_written,0);
    assert.equal(restarted.storage_bytes,restarted.storage_before);reports.push({...restarted,runtime_restarted:true});
    cdp=await inspector(runtime);
    const cold=await runtime.dispatchFetch('http://localhost/read?id='+lease.handoff_id);assert.equal(cold.status,200,await cold.clone().text());const read=await cold.json();assert.equal(read.engine,'record-log');assert.equal(read.bytes,RESULT_BYTES);assert.equal(read.identity,identity);assert.deepEqual(read.result,result);
    heaps.push(await cdp.heap()); const sampledPeak=Math.max(...heaps.map(h=>h.usedSize));
    assert.ok(sampledPeak-baseline.usedSize<48*1024*1024,JSON.stringify({baseline,sampledPeak,heaps}));
    console.log('actual Workerd result source report',JSON.stringify({lease,reports,cold:{bytes:read.bytes,identity:read.identity,constructor:read.constructor,cost:read.cost,storage_before:read.storage_before,storage_bytes:read.storage_bytes},memory:{provider:'actual Workerd inspector Runtime.getHeapUsage',baseline,sampledPeak,samples:heaps.length,peak_is_sampled:true}}));
  } finally { cdp?.close(); await runtime.dispose();rmSync(persistence,{recursive:true,force:true}); }
});

