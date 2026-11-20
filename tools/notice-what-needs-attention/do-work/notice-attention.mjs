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
 switch(input.operation ?? 'decide') {
  case 'facts':return owner.attentionFacts(input.arrival,input.now);
  case 'check-rules':return {rules:owner.checkAttentionRules(input.rules)};
  case 'classifier':return {request:owner.classifyRequest(owner.attentionFacts(input.arrival,input.now)),attention:owner.classifiedAttention(input.answer)};
  case 'decide':{
   const facts=owner.attentionFacts(input.arrival,input.now);
   const decision=await owner.decideAttention({facts,rules:owner.attentionRules(input.saved_rules),matches:(tree,row)=>filterRecords({tree,fields:settings.facts,records:[row]}).matches.length===1});
   return {...decision,opens:owner.attentionOpens(decision.attention),arrival:owner.keptAs(input.arrival,decision)};
  }
  default:throw new Error('Choose decide, facts, check-rules or classifier.');
 }
}
