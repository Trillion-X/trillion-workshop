// Run the same fingerprint-checked workflow module the hosted Worker uses.
import { committedModuleForTests } from './committed-modules-for-tests.mjs';
export async function workflowEngineForTests() {
  return (await committedModuleForTests('workflow-engine')).bindings;
}
