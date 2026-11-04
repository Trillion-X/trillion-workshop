import type {
  CompositionActionRef,
  CompositionBinding,
  CompositionTrigger,
  SceneNode,
} from '../read-data/documents';

export type CompositionActionRecord = {
  id: string;
  kind: 'composition-action-reference';
  action_ref: CompositionActionRef;
};

export type OwnerActionReferenceInput = {
  actionId: string;
  owner: string;
  target: string;
  input?: Record<string, unknown>;
};

export type WorkflowActionReferenceInput = {
  actionId: string;
  workflowId: string;
  target?: string;
  input?: Record<string, unknown>;
};

export type ProcessSessionActionReferenceInput = {
  actionId: string;
  ownerActionId: string;
  target: string;
  input?: Record<string, unknown>;
};

export type FsmDispatchReferenceInput = {
  actionId: string;
  stateRef: string;
  event: string;
  target?: string;
};

export function buildOwnerActionReference(input: OwnerActionReferenceInput): CompositionActionRecord {
  return actionRecord(input.actionId, {
    action_id: nonEmpty(input.actionId, 'actionId'),
    owner: nonEmpty(input.owner, 'owner'),
    target: nonEmpty(input.target, 'target'),
    ...(input.input ? { input: input.input } : {}),
  });
}

export function buildWorkflowActionReference(input: WorkflowActionReferenceInput): CompositionActionRecord {
  return actionRecord(input.actionId, {
    action_id: nonEmpty(input.actionId, 'actionId'),
    owner: nonEmpty(input.workflowId, 'workflowId'),
    target: nonEmpty(input.target ?? 'slot::workflow', 'target'),
    ...(input.input ? { input: input.input } : {}),
  });
}

export function buildProcessSessionActionReference(input: ProcessSessionActionReferenceInput): CompositionActionRecord {
  return actionRecord(input.actionId, {
    action_id: nonEmpty(input.ownerActionId, 'ownerActionId'),
    owner: 'process-session',
    target: nonEmpty(input.target, 'target'),
    ...(input.input ? { input: input.input } : {}),
  });
}

export function buildFsmDispatchActionReference(input: FsmDispatchReferenceInput): CompositionActionRecord {
  return actionRecord(input.actionId, {
    action_id: nonEmpty(input.actionId, 'actionId'),
    target: nonEmpty(input.target ?? 'slot::workflow', 'target'),
    input: {
      state_ref: nonEmpty(input.stateRef, 'stateRef'),
      event: nonEmpty(input.event, 'event'),
    },
  });
}

export function attachActionTrigger(
  node: SceneNode,
  event: string,
  action: CompositionActionRecord,
): SceneNode {
  const trigger: CompositionTrigger = {
    event: nonEmpty(event, 'event'),
    action_ref: action.action_ref,
  };
  return {
    ...node,
    triggers: [...(node.triggers ?? []), trigger],
  };
}

export function attachBinding(node: SceneNode, binding: CompositionBinding): SceneNode {
  return {
    ...node,
    bindings: [...(node.bindings ?? []), binding],
  };
}

function actionRecord(id: string, actionRef: CompositionActionRef): CompositionActionRecord {
  return {
    id: nonEmpty(id, 'id'),
    kind: 'composition-action-reference',
    action_ref: actionRef,
  };
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`composition action ${label} is empty`);
  return trimmed;
}
