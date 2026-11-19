import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { reportResourceUsage, readResourceUsageReport, reconcileResourceUsageReport, cancelPreparedResourceUsageReport, settlementCashPlan, usageReportingTypes as types } from '../do-work/resource-usage-reporting.mjs';
import { settleSharedResourceCost, correctResourceUsageSettlement } from '../do-work/resource-usage.mjs';
import { compareAmounts } from '../read-data/resource-usage.mjs';
const equal = (a,b) => assert.equal(compareAmounts(a,b),0);
const key = { supplier_pool:'pool',tariff_version:'tariff:1',cost_class:'source-transfer',invoice_period:'2026-10',currency:'usd',resource_id:'resource:source-bytes' };
const terms = {resource_id:key.resource_id,rule_ref:'default:v1',markup_bps:'3000'};
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

// A reporting run reads no rows: the agreement, the settlement answer and the last cash/applied state come in the request.
function setup(){const p=provider();let time=Date.parse('2026-10-31T12:00:00Z');
 const agreement={state:'confirmed',agreement_id:'agreement:one',payer_id:'payer',provider_account_id:'acct:seller',provider_customer_id:'cus:one',provider_subscription_id:'sub:one',currency:'usd',currency_exponent:2,usage_terms:[terms],source_ref:'purchase:receipt',authority_ref:'budget:receipt',bill_usage:true,collection:'settled_invoice_item',collection_authorized_total:'100'};
 const context={send:p.send,now:()=>time};
 const payers=[{payer_id:'payer',kind:'customer',excess_units:'1',max_unit_cost:'100',authorized_total:'100',terms}];
 const source=(id='settlement:one',amount='1')=>settleSharedResourceCost({settlement_id:id,settlement_key:key,invoice:{status:'confirmed',amount,evidence_ref:`invoice:${id}`},payers});
 const correct=(previous,amount,payersOf=payers)=>correctResourceUsageSettlement({settlement_id:previous.settlement.id,previous,reason:'supplier revision',settlement_key:key,payers:payersOf,invoice:{status:'confirmed',amount,evidence_ref:`correction:${previous.settlement.version}`}});
 const input=(settlement,extra={})=>({settlement,payer_id:'payer',agreement:s.agreement,seller_connection:'service_connection:stripe:sample',...extra});
 const s={p,context,agreement,source,correct,input,time(value){time=value;}};return s;
}

test('settlement markup is sent exactly once and a replay of the committed answer does not duplicate cash',async()=>{
 const s=setup();const out=await reportResourceUsage(s.input(s.source()),s.context);assert.equal(out.state,'provider_accepted');equal(out.exact_delta,'1.3');equal(out.cash_amount,'1.3');assert.equal(s.p.posts()[0].body.includes('amount=130'),true);assert.equal(out.payment_state,'not_proved_collected');
 assert.deepEqual(out.cash.carry,{n:'0',d:'1'});assert.equal(out.applied.settlement_version,1);assert.equal(out.report.provider_receipt.status,'provider_accepted_invoice_item_not_paid');
 const replay=await reportResourceUsage(s.input(s.source(),{prior_report:out.report}),s.context);assert.deepEqual(replay,out);assert.equal(s.p.posts().length,1);
 await assert.rejects(reportResourceUsage(s.input(s.source(),{applied:out.applied,cash:out.cash}),s.context),/already applied/);
});
test('two subcent sources accrue exact carry in the answer without touching the provider on zero cash',async()=>{
 const t=setup();let out=await reportResourceUsage(t.input(t.source('a',{n:'3',d:'650'})),t.context);equal(out.cash_amount,'0');equal(out.carry_after,'0.006');assert.equal(out.state,'accrued_no_cash_report');assert.equal(t.p.requests.length,0);
 out=await reportResourceUsage(t.input(t.source('b',{n:'3',d:'650'}),{cash:out.cash}),t.context);equal(out.cash_amount,'0.01');equal(out.carry_after,'0.002');assert.equal(t.p.posts().length,1);equal(out.cash.carry,'0.002');
});
test('corrections use cumulative deltas, including skipped source versions',async()=>{
 const s=setup();const v1=s.source();const v2=s.correct(v1,'0.5');let out=await reportResourceUsage(s.input(v2),s.context);equal(out.cash_amount,'0.65');
 const v3=s.correct(v2,'0.25');out=await reportResourceUsage(s.input(v3,{cash:out.cash,applied:out.applied}),s.context);equal(out.cash_amount,'-0.32');equal(out.carry_after,'-0.005');assert.equal(s.p.posts().length,2);assert.equal(out.report.provider_receipt.status,'provider_accepted_invoice_item_not_paid');
 await assert.rejects(reportResourceUsage(s.input(v1,{cash:out.cash,applied:out.applied}),s.context),/superseded/);
});
test('an unknown provider side effect retries the same frozen idempotency key from the frozen report',async()=>{
 const s=setup();const source=s.source();s.p.unknown();const unknown=await reportResourceUsage(s.input(source),s.context);assert.equal(unknown.state,'outcome_unknown');assert.equal(unknown.carry_after,null);assert.equal(unknown.cash,null);assert.equal(unknown.applied,null);
 const out=await reportResourceUsage(s.input(source,{prior_report:unknown.report}),s.context);assert.equal(out.state,'provider_accepted');assert.equal(s.p.objects.size,1);assert.equal(s.p.posts()[0].headers['Idempotency-Key'],s.p.posts()[1].headers['Idempotency-Key']);
 await assert.rejects(reportResourceUsage(s.input(s.source('other'),{prior_report:unknown.report}),s.context),/another source version/);
});
test('expired or backwards retry window requires provider read and never re-POSTs',async()=>{
 for(const offset of [24*3600000,-1]){const s=setup();const source=s.source();s.p.unknown();const unknown=await reportResourceUsage(s.input(source),s.context);s.time(Date.parse('2026-10-31T12:00:00Z')+offset);const waiting=await reportResourceUsage(s.input(source,{prior_report:unknown.report}),s.context);assert.equal(waiting.state,'reconciliation_required');assert.equal(waiting.next_action,'reconcile-resource-usage-report');assert.equal(s.p.posts().length,1);s.time(Date.parse('2026-10-31T12:01:00Z'));assert.equal((await reportResourceUsage(s.input(source,{prior_report:waiting.report}),s.context)).state,'reconciliation_required');const out=await reconcileResourceUsageReport({report:waiting.report,provider_invoice_item_id:'ii:1'},s.context);assert.equal(out.state,'provider_accepted');equal(out.cash.carry,'0');assert.equal(out.applied.report_id,out.report_id);assert.equal(s.p.posts().length,1);}
});
test('identity, currency, terms and trial authority mismatches send no usage charge',async()=>{
 for(const change of [s=>s.p.account('acct:other'),s=>s.agreement.provider_customer_id='cus:other',s=>s.agreement.currency='eur',s=>s.agreement.usage_terms=[{...terms,markup_bps:'9000'}],s=>s.p.status('trialing')]){const s=setup();const source=s.source();change(s);await assert.rejects(reportResourceUsage(s.input(source),s.context));assert.equal(s.p.posts().length,0);}
 const s=setup();const source=s.source();s.p.status('trialing');s.agreement.usage_billed_during_trial=true;assert.equal((await reportResourceUsage(s.input(source),s.context)).state,'provider_accepted');
 const u=setup();await assert.rejects(reportResourceUsage({...u.input(u.source()),agreement:{...u.agreement,state:'proposed'}},u.context),/confirmed purchased billing agreement/);
 await assert.rejects(reportResourceUsage({...u.input(u.source()),settlement:undefined},u.context),/settlement and allocations/);
});
test('the cash and applied state handed in must be the state the frozen report was prepared from',async()=>{
 const s=setup();const first=await reportResourceUsage(s.input(s.source('a')),s.context);const source=s.source('b');s.p.unknown();const unknown=await reportResourceUsage(s.input(source,{cash:{...first.cash}}),s.context);assert.equal(unknown.state,'outcome_unknown');
 await assert.rejects(reportResourceUsage(s.input(source,{prior_report:unknown.report}),s.context),/checkpoint/);
 await assert.rejects(reconcileResourceUsageReport({report:unknown.report,provider_invoice_item_id:'ii:1',cash:{...first.cash,carry:{n:'1',d:'1'}}},s.context),/checkpoint/);
 await assert.rejects(reportResourceUsage(s.input(source,{cash:{...first.cash,agreement_id:'agreement:other'}}),s.context),/another agreement/);
});
test('current collection authority callback refuses before provider POST',async()=>{
 const s=setup();const source=s.source();s.context.assertCollectionAuthority=async()=>{throw Error('current spending authority revoked');};await assert.rejects(reportResourceUsage(s.input(source),s.context),/revoked/);assert.equal(s.p.posts().length,0);
});
test('cash plan refuses unsafe precision or authorization and truncates credits toward zero',()=>{
 equal(settlementCashPlan({delta:'-0.009',currency_exponent:2,authorized_total:'1'}).carry,'-0.009');assert.throws(()=>settlementCashPlan({delta:'2',currency_exponent:2,authorized_total:'1'}),/authorization/);assert.throws(()=>settlementCashPlan({delta:'1',currency_exponent:7,authorized_total:'1'}),/precision|exponent/);
});

test('retry observes a lowered current collection ceiling without changing its frozen key',async()=>{
 const s=setup();const source=s.source();s.p.unknown();const unknown=await reportResourceUsage(s.input(source),s.context);s.agreement.collection_authorized_total='0.5';await assert.rejects(reportResourceUsage(s.input(source,{prior_report:unknown.report}),s.context),/current collection authorization/);assert.equal(s.p.posts().length,1);
});
test('a removed payer gets a negative invoice credit through original purchased terms',async()=>{
 const s=setup();const v1=s.source();const first=await reportResourceUsage(s.input(v1),s.context);
 const v2=s.correct(v1,'0',[]);
 const out=await reportResourceUsage(s.input(v2,{cash:first.cash,applied:first.applied}),s.context);equal(out.cash_amount,'-1.3');assert.equal(out.payment_state,'not_proved_collected');assert.equal(s.p.posts().length,2);equal(out.cash.net_reported,'0');
});
test('malformed provider success remains unknown and unrelated receipt cannot settle it',async()=>{
 const s=setup();const source=s.source();s.p.bad();const out=await reportResourceUsage(s.input(source),s.context);assert.equal(out.state,'outcome_unknown');s.p.objects.set('ii:wrong',{id:'ii:wrong',object:'invoiceitem',customer:'cus:one',currency:'usd',amount:130,subscription:'sub:other',metadata:{usage_report_id:out.report_id}});await assert.rejects(reconcileResourceUsageReport({report:out.report,provider_invoice_item_id:'ii:wrong'},s.context),/exact frozen/);
});

function throughRunner(name, input) {
 return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL('../../workflows/do-work/run-a-function.mjs',import.meta.url).pathname,new URL('../do-work/take-payments.mjs',import.meta.url).pathname,name],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',reject);child.on('close',code=>{try{resolve({code,answer:JSON.parse(stdout.trim().split('\n').at(-1)),stderr});}catch(error){reject(error);}});child.stdin.end(JSON.stringify(input));});
}
test('the export runner accrues a subcent source with no records door and answers the checkpoint to keep',async()=>{
 const s=setup();const out=await throughRunner('reportResourceUsage',s.input(s.source('a',{n:'3',d:'650'})));
 assert.equal(out.code,0,out.answer.error);assert.equal(out.answer.result.state,'accrued_no_cash_report');equal(out.answer.result.carry_after,'0.006');equal(out.answer.result.cash.carry,'0.006');assert.equal(out.answer.result.applied.settlement_version,1);
});

// readResourceUsageReport and cancelPreparedResourceUsageReport act on the report and cash rows the caller hands in.
function heldReport(state){const report={id:'report:held',state,cash_id:'cash:held',payer_id:'payer',agreement:{currency:'usd'},settlement_ref:'ref',exact_delta:'1',cash:{amount:'1',carry:'0'}};
 return {report,cash:{version:1,pending_report:report.id}};}
test('read and cancel act on the report and cash rows the caller hands in; a possibly dispatched report is never cancelled',()=>{
 assert.throws(()=>readResourceUsageReport({report_id:'report:held'}),/Give report/);
 const held=heldReport('prepared');
 assert.equal(readResourceUsageReport({report_id:'report:held',report:held.report}).report.state,'prepared');
 const cancelled=cancelPreparedResourceUsageReport({report_id:'report:held',report:held.report,cash:held.cash});
 assert.equal(cancelled.state,'cancelled_before_dispatch');
 const [reportRow,cashRow]=cancelled.keep; assert.equal(reportRow.value.state,'cancelled_before_dispatch'); assert.equal(cashRow.id,'cash:held'); assert.equal(cashRow.value.pending_report,null); assert.equal(cashRow.value.version,2);
 const unknown=heldReport('outcome_unknown');
 assert.throws(()=>cancelPreparedResourceUsageReport({report_id:'report:held',report:unknown.report,cash:unknown.cash}),/may have reached/);
});
