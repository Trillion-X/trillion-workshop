import { readPath } from '../read-data/universal-action-event-contract.ts';
import { ownerActionDisabledReason } from './owner-action-disabled-reason.ts';
import type {
  JsonObject,
  UniversalActionEventActionDescriptor,
  UniversalActionEventDescriptorSet,
  UniversalActionEventRecord,
} from '../read-data/universal-action-event-contract.ts';

export interface OwnerActionEventRequestContext {
  record?: UniversalActionEventRecord | null;
  answers?: Readonly<JsonObject>;
}

export interface OwnerActionEventTargetRequest {
  target: string;
  payload: JsonObject;
}

function mappedInput(action: UniversalActionEventActionDescriptor, context: OwnerActionEventRequestContext): JsonObject {
  const input: JsonObject = { ...(action.input ?? {}), ...(context.answers ?? {}) };
  for (const mapping of action.inputMapping ?? []) {
    const value = mapping.from ? readPath(context, mapping.from) : mapping.value;
    if (value !== undefined) input[mapping.key] = value;
  }
  if (context.record) {
    input.record_id = context.record.recordId;
    input.subject_refs = context.record.subjectRefs ?? [];
    input.source_refs = context.record.sourceRefs ?? [];
  }
  input.action_id = action.id;
  return input;
}

export function buildOwnerActionEventRequest(
  action: UniversalActionEventActionDescriptor,
  descriptors: UniversalActionEventDescriptorSet,
  context: OwnerActionEventRequestContext = {},
): OwnerActionEventTargetRequest {
  const disabledReason = ownerActionDisabledReason(action, descriptors);
  if (disabledReason) throw new Error(disabledReason);
  const operation = action.operation ?? 'execute_definition';
  const input = mappedInput(action, context);
  if (operation === 'execute_definition') {
    if (!action.definitionId) throw new Error(`Action ${action.id} has no owner definition.`);
    return {
      target: action.target ?? 'slot::workflow',
      payload: {
        operation,
        definition_id: action.definitionId,
        include_steps: false,
        include_output: false,
        input,
      },
    };
  }
  return {
    target: action.target ?? 'slot::workflow',
    payload: {
      operation,
      action_id: action.id,
      input,
    },
  };
}
