#!/usr/bin/env node
import {composeRunRequest} from './compose-run-request-lib.mjs';
const arg=(flag)=>{const index=process.argv.indexOf(flag);return index<0?undefined:process.argv[index+1]};
const parse=(flag,fallback)=>{try{return JSON.parse(arg(flag)??'')}catch{return fallback}};
const recipe=parse('--recipe-json',{});
if(Array.isArray(recipe?.gate_policy?.required_verdicts)&&recipe.gate_policy.required_verdicts.length>0){
  throw new Error('Calibrated review must run through content-generation.run-grounded-content outside the workflow lane');
}
const request=composeRunRequest({recipe,workItem:parse('--work-item-json',{}),grounding:parse('--grounding-json',[]),blocks:parse('--instruction-blocks-json',[]),requestId:arg('--request-id')});
process.stdout.write(JSON.stringify(request));
