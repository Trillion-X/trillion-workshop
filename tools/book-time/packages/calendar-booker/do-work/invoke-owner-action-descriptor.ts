import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export type OwnerActionDescriptor = {
  action_ref: string;
  target?: string;
  include_steps?: boolean;
  include_output?: boolean;
  input?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type OwnerActionInvocation = {
  descriptor: OwnerActionDescriptor;
  input: Record<string, unknown>;
  idempotency_key?: string;
};

export type OwnerActionTargetRequest = {
  target: string;
  payload: {
    operation: 'execute_definition';
    definition_id: string;
    include_steps: boolean;
    include_output: boolean;
    input: Record<string, unknown>;
  };
};

const WORKFLOW_TARGET = 'slot::workflow';

function cleanRef(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} needs a value`);
  return trimmed;
}

export function buildOwnerActionTargetRequest(invocation: OwnerActionInvocation): OwnerActionTargetRequest {
  const descriptor = invocation.descriptor;
  const target = descriptor.target?.trim() || WORKFLOW_TARGET;
  return {
    target,
    payload: {
      operation: 'execute_definition',
      definition_id: cleanRef(descriptor.action_ref, 'Action reference'),
      include_steps: descriptor.include_steps ?? false,
      include_output: descriptor.include_output ?? false,
      input: {
        ...descriptor.context,
        ...descriptor.input,
        ...invocation.input,
        ...(invocation.idempotency_key ? { idempotency_key: invocation.idempotency_key } : {}),
      },
    },
  };
}

export function invokeOwnerActionDescriptor(invocation: OwnerActionInvocation): Promise<unknown> {
  return sendRequestToBitfieldTarget(buildOwnerActionTargetRequest(invocation));
}
