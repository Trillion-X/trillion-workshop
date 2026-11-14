// packages/workflow-canvas/do-work/delete-workflow-canvas-definition.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Build the owner request that removes ONE canvas-owned action: the package's
// `delete-workflow-canvas-action` definition retracts every record the save
// action wrote for that id (entity, type membership, workflow participation,
// the attribute facts including spatial layout, and the published-record
// pointer). Same removal vocabulary the journal's delete action uses:
// write items with address + path and no payload are retractions.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. do-work builds request bytes and sends them to the owner — nothing else.
// 2. Only canvas-owned ids are deletable — callers gate on `editable`;
//    shipped definitions are re-asserted by their package on next admission,
//    so deleting them here would be a lie.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';

const DELETE_WORKFLOW_CANVAS_ACTION = 'action:delete-workflow-canvas-action';

export async function deleteWorkflowCanvasDefinition(input: {
  actionId: string;
  workflowId: string;
}): Promise<unknown> {
  if (!input.actionId.startsWith('action:')) {
    throw new Error('Only canvas actions can be removed.');
  }
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: DELETE_WORKFLOW_CANVAS_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        action_id: input.actionId,
        workflow_id: input.workflowId,
      },
    },
  });
}
