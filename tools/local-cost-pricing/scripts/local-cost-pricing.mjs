import pricing from './local-cost-pricing.json' with {type:'json'};
import spendData from '../../shared-code/src/spend-meter.json' with {type:'json'};
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const amount=(value,name)=>{if(!Number.isFinite(value)||value<0)throw new TypeError(`${name} must be a finite nonnegative number.`);return value;};
const sourceLines=new Map(spendData.lines.map(line=>[line.id,line]));
const metrics=Object.fromEntries(Object.entries(pricing.meter_line_ids).map(([metric,id])=>{const line=sourceLines.get(id);if(!line||!Number.isFinite(line.price?.dollars_per_million)||!Number.isFinite(line.price?.included_per_month))throw new Error(`Spend meter line ${id} cannot price ${metric}.`);return [metric,{included_monthly:line.price.included_per_month,dollars_per_unit:line.price.dollars_per_million/1e6,source_read_on:line.source?.read_on,source:line.source?.from}];}));
export function priceLocalCost(input,{alreadyUsed=null,repetitions=1}={}){
 amount(repetitions,'repetitions');input=input?.report??input;
 if(!input||typeof input!=='object')throw new TypeError('A local report with physical units is required.');
 const reports=input.workers??[input];if(!reports.length)throw new TypeError('At least one local report is required.');
 const observed={},unknown=new Set();let alarmSets=0,storageCalls=0,otherAlarms=0;
 for(const report of reports){if(!report.units||!Array.isArray(report.rows))throw new TypeError('Each report needs physical units and operation rows.');
  for(const key of ['rows_read','rows_written','kv_reads','kv_writes','kv_deletes','kv_lists'])observed[key]=(observed[key]??0)+amount(report.units[key]??0,key);
  for(const row of report.rows){if(row.kind==='alarm-storage'&&row.detail==='setAlarm')alarmSets+=amount(row.calls,'alarm calls');if(row.kind==='alarm-storage'&&row.detail!=='setAlarm')otherAlarms+=amount(row.calls,'alarm calls');if(row.kind==='do-storage')storageCalls+=amount(row.calls,'DO storage calls');}
  for(const item of report.coverage?.unmeasured??[])unknown.add(item);
 }
 observed.rows_written+=alarmSets;
 for(const item of ['Cloudflare CPU and GB-seconds','retained database/KV storage','Workers Builds','Workers/DO request billing','R2, AI, Browser and other provider charges'])unknown.add(item);
 if(storageCalls)unknown.add(`${storageCalls} DO storage API calls use hidden SQLite rows, which this report cannot price exactly.`);
 if(otherAlarms)unknown.add(`${otherAlarms} getAlarm/deleteAlarm calls are observed without an inferred internal row charge.`);
 const rows=Object.entries(metrics).map(([metric,rule])=>{const observedUnits=metric==='kv_changes'?['kv_writes','kv_deletes','kv_lists'].reduce((sum,key)=>sum+(observed[key]??0),0):(observed[metric]??0),units=observedUnits*repetitions,known=alreadyUsed!==null&&Object.hasOwn(alreadyUsed,metric),used=known?amount(alreadyUsed[metric],`alreadyUsed.${metric}`):null,before=known?Math.max(0,used-rule.included_monthly):null,after=known?Math.max(0,used+units-rule.included_monthly):null;return {metric,spend_meter_line_id:pricing.meter_line_ids[metric],rate_source:rule.source,observed_units:observedUnits,scenario_units:units,already_used_in_billing_cycle:used,included_monthly:rule.included_monthly,gross_at_overage_rate_usd:units*rule.dollars_per_unit,additional_overage_usd:units===0?0:known?(after-before)*rule.dollars_per_unit:null};});
 return {version:'trillion.local-cost-estimate/v1',currency:'USD',pricing_version:pricing.version,pricing_sources:pricing.sources,basis:'Measured local SQL/KV units priced at published Paid Standard rates; an estimate, not a Cloudflare invoice.',repetitions,alarm_set_rows_added:alarmSets*repetitions,priced_categories:rows,measured_categories_gross_usd:rows.reduce((s,r)=>s+r.gross_at_overage_rate_usd,0),measured_categories_additional_overage_usd:rows.some(r=>r.additional_overage_usd===null)?null:rows.reduce((s,r)=>s+r.additional_overage_usd,0),allowance_basis:alreadyUsed===null?'Unknown: no free allowance is assumed. Gross values show the overage-rate scenario.':'Only supplied account-wide billing-cycle counters are known; other positive metrics remain unknown.',fixed_monthly_workers_minimum_usd:pricing.fixed_monthly_workers_minimum,whole_account_estimate_complete:false,unpriced:[...unknown],notes:pricing.notes};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const path=process.argv[2];if(!path)throw new Error('Usage: node scripts/local-cost-pricing.mjs local-report.json [repetitions] [already-used.json]');const report=JSON.parse(readFileSync(path,'utf8')),alreadyUsed=process.argv[4]?JSON.parse(readFileSync(process.argv[4],'utf8')):null,result=priceLocalCost(report,{repetitions:process.argv[3]===undefined?1:Number(process.argv[3]),alreadyUsed});process.stdout.write(JSON.stringify(result,null,2)+'\n');}
