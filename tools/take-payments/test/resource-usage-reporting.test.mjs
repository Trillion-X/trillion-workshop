import test from 'node:test';
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import assert from 'node:assert/strict';
import { reportResourceUsage, readResourceUsageReport, reconcileResourceUsageReport, cancelPreparedResourceUsageReport, settlementCashPlan, usageReportingTypes as types } from '../do-work/resource-usage-reporting.mjs';
import { settleSharedResourceCost, correctResourceUsageSettlement } from '../do-work/resource-usage.mjs';
import { compareAmounts } from '../read-data/resource-usage.mjs';
const equal = (a,b) => assert.equal(compareAmounts(a,b),0);
const key = { supplier_pool:'pool',tariff_version:'tariff:1',cost_class:'source-transfer',invoice_period:'2026-10',currency:'usd',resource_id:'resource:source-bytes' };
const terms = {resource_id:key.resource_id,rule_ref:'default:v1',markup_bps:'3000'};
function memoryDoor() {
 const records=new Map(), keys=new Map(); let failFinish=false;
 const door={
 async read(type,id){const row=records.get(id);return row?.type===type?structuredClone(row.value):null;},
 async *list({type,prefix='',above,below,reverse=true}={}){assert.equal(reverse,true);for(const [id,row]of [...records].sort(([a],[b])=>b.localeCompare(a)))if(row.type===type&&id.startsWith(prefix)&&(!above||id>above)&&(!below||id<below))yield{id,...structuredClone(row)};},
 async write(rows,{key}={}){if(keys.has(key))return keys.get(key);for(const row of rows)if(Object.hasOwn(row,'expected'))assert.deepEqual(records.get(row.id)??null,row.expected,'atomic compare');if(failFinish&&String(key).endsWith(':finish')){failFinish=false;throw Error('local finish unavailable');}for(const row of rows)records.set(row.id,{type:row.type,value:structuredClone(row.value)});keys.set(key,{changed:true});return{changed:true};}
 };return {door,records,failFinish(){failFinish=true;}};
}
function provider(){const objects=new Map(),requests=[],byKey=new Map();let unknown=false,bad=false,account='acct:seller',status='active';
 const send=async req=>{requests.push(req);const path=decodeURIComponent(new URL(req.url).pathname);
 if(path==='/v1/account')return{id:account};
 if(path==='/v1/subscriptions/sub:one')return{id:'sub:one',customer:'cus:one',currency:'usd',status};
 if(path==='/v1/invoiceitems'&&req.method==='POST'){
 const form=new URLSearchParams(req.body),idempotency=req.headers['Idempotency-Key'];assert.ok(idempotency);assert.equal(form.get('discountable'),'false');
 if(!byKey.has(idempotency)){const result={id:`ii:${objects.size+1}`,object:'invoiceitem',customer:form.get('customer'),subscription:form.get('subscription'),currency:form.get('currency'),amount:Number(form.get('amount')),metadata:{usage_report_id:form.get('metadata[usage_report_id]')}};byKey.set(idempotency,result);objects.set(result.id,result);}
 if(unknown){unknown=false;throw Error('reply lost after side effect');}return bad?{}:structuredClone(byKey.get(idempotency));
 }
 if(path.startsWith('/v1/invoiceitems/'))return structuredClone(objects.get(decodeURIComponent(path.split('/').at(-1))));
 throw Error(`unexpected provider request ${path}`);
 };return{send,requests,objects,posts:()=>requests.filter(r=>r.method==='POST'),unknown(){unknown=true;},bad(){bad=true;},account(value){account=value;},status(value){status=value;}};
}
async function setup(){const db=memoryDoor(),p=provider();let time=Date.parse('2026-10-31T12:00:00Z');
 const agreement={state:'confirmed',agreement_id:'agreement:one',payer_id:'payer',provider_account_id:'acct:seller',provider_customer_id:'cus:one',provider_subscription_id:'sub:one',currency:'usd',currency_exponent:2,usage_terms:[terms],source_ref:'purchase:receipt',authority_ref:'budget:receipt',bill_usage:true,collection:'settled_invoice_item',collection_authorized_total:'100'};
 const context={door:db.door,send:p.send,now:()=>time,agreementOf:async()=>agreement};
 async function source(id='settlement:one',amount='1'){return settleSharedResourceCost({settlement_id:id,request_key:`new:${id}`,settlement_key:key,invoice:{status:'confirmed',amount,evidence_ref:`invoice:${id}`},payers:[{payer_id:'payer',kind:'customer',excess_units:'1',max_unit_cost:'100',authorized_total:'100',terms}]},context);}
 async function correct(id,amount,version=1){return correctResourceUsageSettlement({settlement_id:id,request_key:`correct:${id}:${version}`,expected_version:version,reason:'supplier revision',settlement_key:key,payers:[{payer_id:'payer',kind:'customer',excess_units:'1',max_unit_cost:'100',authorized_total:'100',terms}],invoice:{status:'confirmed',amount,evidence_ref:`correction:${version}`}},context);}
 const input=(id='settlement:one',version=1)=>({settlement_id:id,settlement_version:version,payer_id:'payer',agreement_ref:'purchase:one'});
 return{...db,p,context,agreement,source,correct,input,time(value){time=value;}};
}

test('settlement markup is sent exactly once and source replay does not duplicate cash',async()=>{
 const s=await setup();await s.source();const out=await reportResourceUsage(s.input(),s.context);assert.equal(out.state,'provider_accepted');equal(out.exact_delta,'1.3');equal(out.cash_amount,'1.3');assert.equal(s.p.posts()[0].body.includes('amount=130'),true);assert.equal(out.payment_state,'not_proved_collected');
 assert.deepEqual(await reportResourceUsage(s.input(),s.context),out);assert.equal(s.p.posts().length,1);assert.deepEqual((await readResourceUsageReport({report_id:out.report_id},s.context)).report,out);
});
test('two subcent sources accrue exact durable carry without touching provider on zero cash',async()=>{
 const t=await setup();await t.source('a',{n:'3',d:'650'});let out=await reportResourceUsage(t.input('a'),t.context);equal(out.cash_amount,'0');equal(out.carry_after,'0.006');assert.equal(t.p.requests.length,0);
 await t.source('b',{n:'3',d:'650'});out=await reportResourceUsage(t.input('b'),t.context);equal(out.cash_amount,'0.01');equal(out.carry_after,'0.002');assert.equal(t.p.posts().length,1);
});
test('corrections use cumulative deltas, including skipped source versions',async()=>{
 const s=await setup();await s.source();await s.correct('settlement:one','0.5');let out=await reportResourceUsage(s.input('settlement:one',2),s.context);equal(out.cash_amount,'0.65');
 await s.correct('settlement:one','0.25',2);out=await reportResourceUsage(s.input('settlement:one',3),s.context);equal(out.cash_amount,'-0.32');equal(out.carry_after,'-0.005');assert.equal(s.p.posts().length,2);assert.equal(out.provider_receipt.status,'provider_accepted_invoice_item_not_paid');
 await assert.rejects(reportResourceUsage(s.input(),s.context),/superseded/);
});
test('unknown provider side effect retries same frozen idempotency key and cannot cancel',async()=>{
 const s=await setup();await s.source();s.p.unknown();const unknown=await reportResourceUsage(s.input(),s.context);assert.equal(unknown.state,'outcome_unknown');assert.equal(unknown.carry_after,null);await assert.rejects(cancelPreparedResourceUsageReport({report_id:unknown.report_id},s.context),/may have reached/);
 const out=await reportResourceUsage(s.input(),s.context);assert.equal(out.state,'provider_accepted');assert.equal(s.p.objects.size,1);assert.equal(s.p.posts()[0].headers['Idempotency-Key'],s.p.posts()[1].headers['Idempotency-Key']);
});
test('local failure after acceptance retains pending source and recovers without duplicate provider objects',async()=>{
 const s=await setup();await s.source();s.failFinish();assert.equal((await reportResourceUsage(s.input(),s.context)).state,'outcome_unknown');assert.equal((await reportResourceUsage(s.input(),s.context)).state,'provider_accepted');assert.equal(s.p.objects.size,1);
});
test('expired or backwards retry window requires provider read and never re-POSTs',async()=>{
 for(const offset of [24*3600000,-1]){const s=await setup();await s.source();s.p.unknown();const unknown=await reportResourceUsage(s.input(),s.context);s.time(Date.parse('2026-10-31T12:00:00Z')+offset);const waiting=await reportResourceUsage(s.input(),s.context);assert.equal(waiting.state,'reconciliation_required');assert.equal(s.p.posts().length,1);s.time(Date.parse('2026-10-31T12:01:00Z'));assert.equal((await reportResourceUsage(s.input(),s.context)).state,'reconciliation_required');const out=await reconcileResourceUsageReport({report_id:unknown.report_id,provider_invoice_item_id:'ii:1'},s.context);assert.equal(out.state,'provider_accepted');assert.equal(s.p.posts().length,1);}
});
test('identity, currency, terms and trial authority mismatches send no usage charge',async()=>{
 for(const change of [s=>s.p.account('acct:other'),s=>s.agreement.provider_customer_id='cus:other',s=>s.agreement.currency='eur',s=>s.agreement.usage_terms=[{...terms,markup_bps:'9000'}],s=>s.p.status('trialing')]){const s=await setup();await s.source();change(s);await assert.rejects(reportResourceUsage(s.input(),s.context));assert.equal(s.p.posts().length,0);}
 const s=await setup();await s.source();s.p.status('trialing');s.agreement.usage_billed_during_trial=true;assert.equal((await reportResourceUsage(s.input(),s.context)).state,'provider_accepted');
});
test('pending cash checkpoint fences another source and cancellation only releases an unsent prepare',async()=>{
 const s=await setup();await s.source('a');await s.source('b');s.p.account('wrong');await assert.rejects(reportResourceUsage(s.input('a'),s.context));await assert.rejects(reportResourceUsage(s.input('b'),s.context),/holds/);
 const row=[...s.records.values()].find(r=>r.type===types.report).value;assert.equal((await cancelPreparedResourceUsageReport({report_id:row.id},s.context)).state,'cancelled_before_dispatch');s.p.account('acct:seller');assert.equal((await reportResourceUsage(s.input('b'),s.context)).state,'provider_accepted');await assert.rejects(reportResourceUsage(s.input('a'),s.context),/cancelled/);
});
test('current collection authority callback refuses before provider POST',async()=>{
 const s=await setup();await s.source();s.context.assertCollectionAuthority=async()=>{throw Error('current spending authority revoked');};await assert.rejects(reportResourceUsage(s.input(),s.context),/revoked/);assert.equal(s.p.posts().length,0);
});
test('cash plan refuses unsafe precision or authorization and truncates credits toward zero',()=>{
 equal(settlementCashPlan({delta:'-0.009',currency_exponent:2,authorized_total:'1'}).carry,'-0.009');assert.throws(()=>settlementCashPlan({delta:'2',currency_exponent:2,authorized_total:'1'}),/authorization/);assert.throws(()=>settlementCashPlan({delta:'1',currency_exponent:7,authorized_total:'1'}),/precision|exponent/);
});

test('retry observes a lowered current collection ceiling without changing its frozen key',async()=>{
 const s=await setup();await s.source();s.p.unknown();await reportResourceUsage(s.input(),s.context);s.agreement.collection_authorized_total='0.5';await assert.rejects(reportResourceUsage(s.input(),s.context),/current collection authorization/);assert.equal(s.p.posts().length,1);
});
test('a removed payer gets a negative invoice credit through original purchased terms',async()=>{
 const s=await setup();await s.source();await reportResourceUsage(s.input(),s.context);
 await correctResourceUsageSettlement({settlement_id:'settlement:one',request_key:'remove',expected_version:1,reason:'allocation removed by corrected supplier evidence',settlement_key:key,payers:[],invoice:{status:'confirmed',amount:'0',evidence_ref:'corrected:empty'}},s.context);
 const out=await reportResourceUsage(s.input('settlement:one',2),s.context);equal(out.cash_amount,'-1.3');assert.equal(out.payment_state,'not_proved_collected');assert.equal(s.p.posts().length,2);
});
test('malformed provider success remains unknown and unrelated receipt cannot settle it',async()=>{
 const s=await setup();await s.source();s.p.bad();const out=await reportResourceUsage(s.input(),s.context);assert.equal(out.state,'outcome_unknown');s.p.objects.set('ii:wrong',{...s.p.objects.get('ii:1'),id:'ii:wrong',subscription:'sub:other'});await assert.rejects(reconcileResourceUsageReport({report_id:out.report_id,provider_invoice_item_id:'ii:wrong'},s.context),/exact frozen/);assert.equal((await readResourceUsageReport({report_id:out.report_id},s.context)).report.state,'outcome_unknown');
});

function throughRunner(name, input, descriptor) {
 return new Promise((resolve,reject)=>{const fd=openSync(descriptor,'r');const child=spawn(process.execPath,[new URL('../../records-door/do-work/run-an-export.mjs',import.meta.url).pathname,new URL('../do-work/take-payments.mjs',import.meta.url).pathname,name],{stdio:['pipe','pipe','pipe',fd]});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>{closeSync(fd);try{resolve({code,answer:JSON.parse(stdout.trim().split('\n').at(-1)),stderr});}catch(error){reject(error);}});child.stdin.end(JSON.stringify(input));});
}
test('actual Marketplace export reads mounted agreement and accrues with declared rights; denied cash writes refuse',async()=>{
 const s=await setup();await s.source('a',{n:'3',d:'650'});
 const records=[...s.records].map(([id,row])=>({id,...row}));records.push({id:'purchase:one',type:types.agreement,value:s.agreement});
 const rows=JSON.parse(readFileSync(new URL('../tool-rows.json',import.meta.url),'utf8')).records;const rights=rows.find(r=>r.payload.id==='tool:report-resource-usage').payload.invoke.records.rights;
 const server=await startFakeDoor({rights,records,unknownFirst:1,eventStream:true,pageCut:1});
 try{const out=await throughRunner('reportResourceUsage',s.input('a'),server.descriptor);assert.equal(out.code,0,out.answer.error);assert.equal(out.answer.result.state,'accrued_no_cash_report');equal(out.answer.result.carry_after,'0.006');const replay=await throughRunner('reportResourceUsage',s.input('a'),server.descriptor);assert.deepEqual(replay.answer,out.answer);assert.ok(server.calls.some(c=>c.method==='records:write'&&server.calls.filter(o=>o.key===c.key).length>1));}finally{await server.close();}
 const readOnly=await startFakeDoor({rights:rights.map(r=>({...r,operations:r.operations.filter(x=>x!=='records:write')})),records});
 try{const refused=await throughRunner('reportResourceUsage',s.input('a'),readOnly.descriptor);assert.equal(refused.code,1);assert.match(refused.answer.error,/may not reach/);assert.equal(readOnly.kept.size,records.length);}finally{await readOnly.close();}
});
