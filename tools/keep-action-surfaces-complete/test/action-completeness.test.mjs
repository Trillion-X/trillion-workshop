import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionCompleteness } from '../read-data/action-completeness.mjs';
// Caller-owned opinion rows; deliberately synthetic, not product content.
const policy={id:'standard:test',version:2,workflow_id:'workflow:complete',label:'Complete',instruction:'Account for every action.',plan:'Plan each path.',proof:'Show observed proof.',core_actions:['create','read','edit','delete'],exclusion_kinds:['view-with-management-surface'],additional_action_examples:[],guard_step_ids:{inventory:'inventory',proof:'proof'},limits:{surfaces:50,operations:100,extra_actions_per_surface:20}};
const modes={records:[{action_completeness:{targets:[{workflow_id:'workflow:trillion-x',inventory_after:'ground-and-scope',proof_before:'retain-and-propagate'}]}}]};
const {actionCompletenessWorkflow, actionInventoryProblems, actionProofProblems, withActionCompleteness}=createActionCompleteness({policy,modes});
const refs=['fixture:direct-observation'];
const sentence='Observed through the actual bounded test entry point.';
const pathPlan=()=>({actor_context:sentence,entry_point:'/items',intended_result:sentence,dependencies:[],allowed_path_test:sentence,blocked_path_test:sentence});
const pathProof=()=>({actor_context:sentence,observed_result:sentence,dependencies:[],allowed_path_evidence:refs,blocked_path_evidence:refs});
const operation=(action,surface='items/api')=>({id:`${surface}/${action}`,action,surface,acceptance_test:sentence,authorization_test:sentence,recovery_test:sentence,evidence_refs:refs,path_plan:pathPlan()});
const inventory=()=>({applicability:'capability-change',scope_reason:sentence,scope_evidence_refs:refs,
  surfaces:[{id:'items/api',owner:'shared item owner',source_refs:refs,additional_actions:['restore']}],
  required:[...policy.core_actions,'restore'].map(action=>operation(action)),excluded:[],sibling_audit:{looked_at:refs,findings:sentence,shared_fix:sentence}});
const proof=input=>({verified:input.required.map(({id})=>({id,state:'verified',observed:sentence,success_evidence:refs,authorization_evidence:refs,recovery_evidence:refs,path_proof:pathProof()})),sibling_readback:sentence,retained_lesson_refs:refs});

test('a complete action inventory and its proof pass',()=>{const input=inventory();assert.deepEqual(actionInventoryProblems(input),[]);assert.deepEqual(actionProofProblems(proof(input),input),[]);});
test('a read-only slice cannot masquerade as a complete inventory',()=>{
  const input=inventory();input.required=[operation('read')];const problems=actionInventoryProblems(input).join('\n');
  for(const action of ['create','edit','delete','restore'])assert.ok(problems.includes(action),action);
});
test('all resource surfaces, not only the API, must have their full action surface',()=>{
  const input=inventory();input.surfaces.push({id:'items/native',owner:'same owner',source_refs:refs,additional_actions:[]});
  assert.match(actionInventoryProblems(input).join(' '),/items\/native/);
  input.required.push(...policy.core_actions.map(action=>operation(action,'items/native')));assert.deepEqual(actionInventoryProblems(input),[]);
});
test('a view exclusion needs an actual management surface, not a missing implementation',()=>{
  const input=inventory();const removed=input.required.pop();input.excluded.push({id:removed.id,surface:removed.surface,action:removed.action,basis:'view-with-management-surface',reason:sentence,evidence_refs:refs,management_surface:''});
  assert.match(actionInventoryProblems(input).join(' '),/management surface/);input.excluded[0].management_surface='/items/manage';assert.deepEqual(actionInventoryProblems(input),[]);
  input.excluded[0].basis='not-built-yet';assert.match(actionInventoryProblems(input).join(' '),/missing implementation/);
});
test('duplicates, invented operations and reclassified pairs do not hide missing work',()=>{
  const input=inventory();input.required.push({...input.required[0],id:'different-id'});assert.match(actionInventoryProblems(input).join(' '),/more than once/);
  input.required.pop();input.required.push(operation('teleport'));assert.match(actionInventoryProblems(input).join(' '),/not declared/);
  input.required.pop();input.required[1].id=input.required[0].id;assert.match(actionInventoryProblems(input).join(' '),/unique/);
});
test('proof must include mutations, authorization and recovery, not only reading',()=>{
  const input=inventory(),result=proof(input);result.verified=result.verified.filter(item=>item.id.endsWith('/read'));assert.match(actionProofProblems(result,input).join(' '),/no verified outcome/);
  const full=proof(input);full.verified[0].state='blocked';full.verified[1].authorization_evidence=[];full.verified[2].recovery_evidence=[];
  const errors=actionProofProblems(full,input).join(' ');assert.match(errors,/not verified/);assert.match(errors,/authorization_evidence/);assert.match(errors,/recovery_evidence/);
});
test('non-capability tasks preserve narrow scope rather than inventing product work',()=>{
  const input={...inventory(),applicability:'non-capability-task',surfaces:[],required:[],excluded:[]};assert.deepEqual(actionInventoryProblems(input),[]);assert.deepEqual(actionProofProblems(proof(input),input),[]);
  input.required=[operation('read')];assert.match(actionInventoryProblems(input).join(' '),/quietly contain/);
});
test('new core actions are DATA and older contract snapshots retain their semantics',()=>{
  const original=actionCompletenessWorkflow(),input=inventory(),settings=structuredClone(policy);settings.core_actions.push('compare');const changed=actionCompletenessWorkflow(settings);
  assert.match(actionInventoryProblems(input,changed.action_completeness).join(' '),/compare/);assert.deepEqual(actionInventoryProblems(input,original.action_completeness),[]);
});
test('decorating a new account-saved X recipe preserves its steps and never mutates old snapshots',()=>{
  const recipe={id:'workflow:trillion-x',steps:['ground-and-scope','compose-the-smallest-complete-change','execute-and-prove','retain-and-propagate'].map(id=>({id,do:sentence,submit:{type:'object'}}))};
  const old=structuredClone(recipe),next=withActionCompleteness(recipe);assert.deepEqual(recipe,old);assert.equal(next.steps.length,6);assert.deepEqual(withActionCompleteness(next),next);
  assert.equal(next.steps[1].id,policy.guard_step_ids.inventory);assert.equal(next.steps.at(-2).id,policy.guard_step_ids.proof);assert.deepEqual(next.steps.filter(step=>old.steps.some(item=>item.id===step.id)),old.steps);
  const unrelated={...old,id:'workflow:weekly-review'};assert.equal(withActionCompleteness(unrelated),unrelated);
});
test('an unsupported account mode graph cannot break unrelated workflow discovery',()=>{
  const original={id:'workflow:trillion-x',definition:{steps:[{id:'one',kind:'ask',config:{name:'ai',input:{do:sentence,submit:{type:'object'}}}}],edges:[]}};const guarded=withActionCompleteness(original);
  assert.match(guarded.action_completeness.attachment_error,/adapt its graph/);assert.deepEqual(guarded.definition,original.definition);assert.equal(original.action_completeness,undefined);
  const ordinary={...original,id:'workflow:unrelated-graph'};assert.equal(withActionCompleteness(ordinary),ordinary);
});
test('different callers keep separate opinion rows',()=>{
 const other=createActionCompleteness({policy:{...policy,instruction:'A separate account instruction.'},modes});
 assert.equal(other.actionCompletenessWorkflow().steps[0].do.startsWith('A separate account instruction.'),true);
 assert.equal(actionCompletenessWorkflow().steps[0].do.startsWith(policy.instruction),true);
});
