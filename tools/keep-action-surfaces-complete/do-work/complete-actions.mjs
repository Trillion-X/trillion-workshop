import { createActionCompleteness } from '../read-data/action-completeness.mjs';
// Opinion content is caller input or one selected content-setting row, never a code import.
export async function completeActions(input = {}, { door } = {}) {
 const policy=input.policy ?? await door.read('record:content-setting','record:content-setting:action-completeness');
 if(!policy || !Array.isArray(policy.core_actions))throw new Error('Supply the action-completeness policy row.');
 const modes=input.modes ?? (input.operation==='decorate' ? await door.read('record:content-setting','record:content-setting:execution-mode-records') : {records:[]});
 if(!modes || !Array.isArray(modes.records))throw new Error('Supply the execution-mode rows before decorating a recipe.');
 const owner=createActionCompleteness({policy,modes});
 switch(input.operation ?? 'workflow') {
  case 'workflow':return owner.actionCompletenessWorkflow();
  case 'decorate':return owner.withActionCompleteness(input.recipe);
  case 'inventory':return {problems:owner.actionInventoryProblems(input.inventory,input.contract)};
  case 'proof':return {problems:owner.actionProofProblems(input.proof,input.inventory,input.contract,input.now)};
  default:throw new Error('Choose workflow, decorate, inventory or proof.');
 }
}
