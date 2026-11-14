// packages/workflow-canvas/do-work/save-workflow-canvas-layout.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Build the owner-action request that saves WHERE one canvas item sits.
// Placement is a spatial fact (`prop:spatial:layout`) on the real record —
// safe for any node kind (action or trigger) because it writes ONLY the
// spatial fact through `action:save-workflow-canvas-layout`. Dragging a
// shipped action repositions it without ever touching its behavior.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. do-work builds request bytes and sends them to the owner — nothing else.
// 2. Layout saves never write behavior facts (slug/steps/description) — that
//    separation is what makes drag safe on every node kind.
// 3. subject_type mirrors the record's entity type so the fact address stays
//    canonical (`...|prop:spatial:layout|type:action` / `type:trigger`).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { WorkflowCanvasNodeKind } from '../read-data/read-workflow-canvas-layout';

const SAVE_WORKFLOW_CANVAS_LAYOUT_ACTION = 'action:save-workflow-canvas-layout';

export async function saveWorkflowCanvasLayout(input: {
  subjectId: string;
  kind: WorkflowCanvasNodeKind;
  x: number;
  y: number;
}): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: SAVE_WORKFLOW_CANVAS_LAYOUT_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        subject_id: input.subjectId,
        // Generic transform, not an enum: the engine's subject_type IS `type:`
        // + the node kind. A new node kind maps to `type:<kind>` for free — no
        // branch to edit (L090). `type:trigger`/`type:action` byte-for-byte.
        subject_type: `type:${input.kind}`,
        layout: {
          x: Math.round(input.x),
          y: Math.round(input.y),
        },
      },
    },
  });
}
