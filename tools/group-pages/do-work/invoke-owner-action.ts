import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  ActionDescriptor,
  GenericRecordProjectionActionContract,
  JsonValue,
} from '../read-data/generic-record-projection.ts';

export interface OwnerActionRequest {
  kind: 'owner-action-request';
  actionId: string;
  ownerInvoke: NonNullable<ActionDescriptor['owner_invoke']>;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedAt: string;
  metadata: Record<string, unknown>;
}

export interface LocalActionAcknowledgement {
  kind: 'local-presentation-acknowledgement';
  actionId: string;
  inputFacts: Record<string, unknown>;
}

export interface OwnerActionError {
  error: {
    code: 'missing-action' | 'missing-input' | 'missing-owner-invoke';
    message: string;
    details?: string[];
  };
}

export type BuiltOwnerAction = OwnerActionRequest | LocalActionAcknowledgement | OwnerActionError;

function findAction(
  contract: GenericRecordProjectionActionContract,
  actionId?: string,
): ActionDescriptor | undefined {
  return actionId
    ? contract.action_descriptors.find((action) => action.id === actionId)
    : undefined;
}

function cloneTemplate(template: Record<string, JsonValue> | undefined): Record<string, unknown> {
  return template ? JSON.parse(JSON.stringify(template)) as Record<string, unknown> : {};
}

function missingInputs(action: ActionDescriptor, inputFacts: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const binding of action.input_bindings ?? []) {
    const value = inputFacts[binding.key] ?? binding.default_value;
    if (binding.required && (value === undefined || value === null || value === '')) {
      missing.push(`Missing required input binding: ${binding.key}`);
    }
  }
  return missing;
}

export function buildOwnerActionRequest(input: {
  contract: GenericRecordProjectionActionContract;
  action_id?: string;
  input_facts?: Record<string, unknown>;
  idempotency_key?: string;
  requested_at?: string;
  metadata?: Record<string, unknown>;
}): BuiltOwnerAction {
  const action = findAction(input.contract, input.action_id);
  if (!action) {
    return {
      error: {
        code: 'missing-action',
        message: 'No owner-action descriptor matched the requested action id.',
      },
    };
  }

  const inputFacts = { ...(input.input_facts ?? {}) };
  for (const binding of action.input_bindings ?? []) {
    if (!(binding.key in inputFacts) && binding.default_value !== undefined) {
      inputFacts[binding.key] = binding.default_value;
    }
  }

  if (action.local_acknowledgement) {
    return { kind: 'local-presentation-acknowledgement', actionId: action.id, inputFacts };
  }

  const missing = missingInputs(action, inputFacts);
  if (!input.idempotency_key) missing.push('idempotency_key is required');
  if (!input.requested_at) missing.push('requested_at is required');
  if (missing.length) {
    return {
      error: {
        code: 'missing-input',
        message: 'Required owner-action request data is missing.',
        details: missing,
      },
    };
  }
  if (!action.owner_invoke) {
    return {
      error: {
        code: 'missing-owner-invoke',
        message: 'The selected action descriptor has no owner invocation target.',
      },
    };
  }

  const payload = {
    ...cloneTemplate(action.payload_template),
    action_id: action.id,
    input_facts: inputFacts,
  };

  return {
    kind: 'owner-action-request',
    actionId: action.id,
    ownerInvoke: action.owner_invoke,
    payload,
    idempotencyKey: input.idempotency_key as string,
    requestedAt: input.requested_at as string,
    metadata: {
      ...(action.metadata ?? {}),
      ...(input.metadata ?? {}),
    },
  };
}

export async function invokeOwnerActionDescriptor(input: {
  contract: GenericRecordProjectionActionContract;
  action_id: string;
  input_facts?: Record<string, unknown>;
  idempotency_key: string;
  requested_at: string;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  const built = buildOwnerActionRequest(input);
  if ('error' in built) return built;
  if (built.kind === 'local-presentation-acknowledgement') return built;

  console.log('[group-page] owner action descriptor invoked', {
    action: built.actionId,
    target: built.ownerInvoke.target,
  });

  return sendRequestToBitfieldTarget({
    target: built.ownerInvoke.target,
    payload: {
      operation: built.ownerInvoke.operation ?? 'execute_definition',
      definition_id: built.ownerInvoke.action_definition_id,
      include_steps: built.ownerInvoke.include_steps ?? false,
      include_output: built.ownerInvoke.include_output ?? false,
      input: {
        event_ref: built.idempotencyKey,
        requested_at: built.requestedAt,
        payload: built.payload,
        metadata: built.metadata,
      },
    },
  });
}
