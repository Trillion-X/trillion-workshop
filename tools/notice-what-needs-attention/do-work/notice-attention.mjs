import { createAttention } from '../read-data/attention.mjs';
import { readFileSync } from 'node:fs';
import { initSync, filterRecords as engineFilterRecords } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
// The formula engine is loaded on the first rule read, from its bytes beside the built module.
let engineReady = false;
const filterRecords = request => {
  if (!engineReady) {
    initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
    engineReady = true;
  }
  return engineFilterRecords(request);
};
// This tool evaluates only the rules and caller-supplied classifier answers. It makes no model call.
export async function noticeAttention(input = {}) {
 const settings=input.settings;
 if(!settings?.attentions || !Array.isArray(settings.starting_rules))throw new Error('Supply the attention policy row.');
 const history=input.history;
 if(!Number.isFinite(history?.history_after_minutes))throw new Error('Supply the brought-in history policy row.');
 // The current brought-in owner's timestamp rule, with its policy handed in rather than imported.
 const wordsAgeMinutes=record=>{
  const authored=Date.parse(record?.authored_at ?? record?.at ?? '');
  const kept=Date.parse(record?.recorded_at ?? '');
  return Number.isNaN(authored)||Number.isNaN(kept)?null:(kept-authored)/60000;
 };
 const broughtIn=record=>{const age=wordsAgeMinutes(record);return age!==null&&age>=history.history_after_minutes;};
 const owner=createAttention(settings,{broughtIn,wordsAgeMinutes});
 const matches=(tree,row)=>filterRecords({tree,fields:settings.facts,records:[row]}).matches.length===1;
 switch(input.operation ?? 'decide') {
  case 'facts':return owner.attentionFacts(input.arrival,input.now);
  case 'check-rules':return {rules:owner.checkAttentionRules(input.rules)};
  case 'classifier':return {request:owner.classifyRequest(owner.attentionFacts(input.arrival,input.now)),attention:owner.classifiedAttention(input.answer)};
  case 'decide':{
   const facts=owner.attentionFacts(input.arrival,input.now);
   const decision=await owner.decideAttention({facts,rules:owner.attentionRules(input.saved_rules),matches});
   return {...decision,opens:owner.attentionOpens(decision.attention),arrival:owner.keptAs(input.arrival,decision)};
  }
  case 'retriage':return retriageDecisions(owner,{input,matches});
  default:throw new Error('Choose decide, facts, check-rules, classifier or retriage.');
 }
}

// Waiting jobs the rules now keep as context, decided from the page the caller reads (no record is read or closed here).
// input.handoffs: one page of open jobs as { handoff_id, input, taken_by?, to_agent? } in handed order;
// input.messages: { [message_id]: { text, at?, app?, authored_at?, recorded_at? } } for the words each job names;
// input.answers: { [words]: classifier answer } for words the rules send to the classifier (asked of the same words).
// Returns { looked_at, decided: [{ handoff_id, outcome: 'handled', reason }], classified, next_after }: the caller closes `decided`.
async function retriageDecisions(owner,{input,matches}){
 const page=Array.isArray(input.handoffs)?input.handoffs:[];
 const byId=new Map(page.map(job=>[job.handoff_id,job]));
 const messages=input.messages??{};
 const answers=input.answers??{};
 const saved=input.saved_rules;
 const rules=owner.attentionRules(saved);
 const decided=[];
 const pieces={
  openHandoffs:({after,limit})=>{const from=after?page.findIndex(job=>job.handoff_id===after)+1:0;return page.slice(from,from+limit).map(({handoff_id})=>({handoff_id}));},
  readHandoff:id=>byId.get(id),
  readMessage:id=>messages[id]??null,
  byRules:async arrival=>owner.decideAttention({facts:owner.attentionFacts(arrival),rules,matches}),
  // No answer for these words leaves the job open ({ attention: null }), never closed.
  attention:async arrival=>({attention:owner.classifiedAttention(answers[arrival.text])??null}),
  close:async items=>{decided.push(...items);return {closed:items.map(item=>({handoff_id:item.handoff_id}))};},
 };
 const result=await owner.retriageWaiting(pieces,{limit:input.limit,after:input.after,classified:input.classified});
 return {...result,decided};
}
