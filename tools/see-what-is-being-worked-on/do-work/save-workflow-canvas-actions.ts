// packages/workflow-canvas/do-work/save-workflow-canvas-actions.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Build the owner-action request that saves canvas action edits into the REAL
// workflow definition store (`type:action`, `prop:action:slug / description /
// is_active / workflow_steps` + `prop:spatial:layout`). The owner action
// `action:save-workflow-canvas-actions` loops the edits through
// `action:save-workflow-canvas-action`, whose write step emits the canonical
// entity / entity_types / participation / attribute_fact rows.
//
// Saved definitions are immediately executable by the workflow owner and
// republished to the canvas feed by the on-change trigger — the edit loop
// closes without any canvas-private store.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. do-work builds request bytes and sends them to the owner — it never
//    writes engine state itself and never becomes a runtime.
// 2. Steps are passed through with identity — this module never rewrites,
//    filters, or invents step bodies.
// 3. The id namespace is `action:<slug>`; slug is derived once here (SSOT for
//    the id↔slug relationship on the save path).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';

const SAVE_WORKFLOW_CANVAS_ACTIONS_ACTION = 'action:save-workflow-canvas-actions';

export interface WorkflowCanvasActionEdit {
  /** Entity id, `action:<slug>`. */
  id: string;
  /**
   * Display name override. The definition's stored name is its slug; renaming
   * keeps the id stable and saves a new slug derived from this name. Omitted
   * = name stays derived from the id.
   */
  name?: string;
  description: string | null;
  /** The definition's steps array (engine step objects), identity-preserved. */
  steps: readonly unknown[];
  /**
   * The definition's step DAG — `{from, to, kind: "always"|"on_result",
   * config}` edges. Branching IS edge conditions in this engine; an empty
   * array means steps run in order.
   */
  edges?: readonly unknown[];
  enabled: boolean;
  /** World-space placement persisted as the record's spatial fact. */
  x: number;
  y: number;
}

/** `action:<slug>` → `<slug>`; the inverse of createActionId. */
export function slugFromActionId(id: string): string {
  return id.replace(/^action:/, '');
}

/** Build a new action id from a plain label. */
export function createActionId(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'action';
  return `action:${slug}`;
}

export async function saveWorkflowCanvasActions(input: {
  workflowId: string;
  actions: WorkflowCanvasActionEdit[];
}): Promise<unknown> {
  for (const action of input.actions) {
    if (!action.id.startsWith('action:')) {
      throw new Error('A canvas action id must start with "action:".');
    }
    if (!Array.isArray(action.steps)) {
      throw new Error('A canvas action edit needs its existing steps.');
    }
    if (!Object.prototype.hasOwnProperty.call(action, 'description')) {
      throw new Error('A canvas action edit needs its existing description.');
    }
  }

  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: SAVE_WORKFLOW_CANVAS_ACTIONS_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        workflow_id: input.workflowId,
        actions: input.actions.map((action) => ({
          id: action.id,
          slug: action.name?.trim()
            ? slugFromActionId(createActionId(action.name))
            : slugFromActionId(action.id),
          // A null description must never reach the definition record: the
          // workflow slot's `Definition.description` is a string, and one
          // null-field record poisons the slot's whole boot snapshot
          // (2026-06-11 incident, twice). Empty string is the honest empty.
          description: action.description ?? '',
          enabled: action.enabled,
          operations: action.steps,
          edges: action.edges ?? [],
          layout: {
            x: Math.round(action.x),
            y: Math.round(action.y),
          },
        })),
      },
    },
  });
}
