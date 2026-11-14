import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { ActionDescriptor, ActionInputCopy, JsonObject, ModelAction, ModelItem } from '../read-data/record-work-model.ts';

export interface RecordWorkActionContext {
  subject?: ModelItem | null;
  answers?: Readonly<JsonObject>;
  actor?: JsonObject;
  correlationId: string;
}

export interface TargetRequest {
  target: string;
  payload: JsonObject;
}

export type TargetSender = (request: TargetRequest) => Promise<unknown>;

function readFromContext(context: RecordWorkActionContext, source: string): unknown {
  const parts = source.split('.').filter(Boolean);
  let current: unknown;
  switch (parts.shift()) {
    case 'subject':
      current = context.subject ?? null;
      break;
    case 'answers':
      current = context.answers ?? {};
      break;
    case 'actor':
      current = context.actor ?? {};
      break;
    default:
      return undefined;
  }
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function copiedInput(copy: readonly ActionInputCopy[], context: RecordWorkActionContext): JsonObject {
  const result: JsonObject = {};
  for (const entry of copy) {
    const value = entry.from ? readFromContext(context, entry.from) : entry.value;
    if (value !== undefined) result[entry.key] = value;
  }
  return result;
}

export function buildRecordWorkActionInput(
  action: ActionDescriptor | ModelAction,
  context: RecordWorkActionContext,
): JsonObject {
  return {
    ...(action.input ?? {}),
    ...(context.answers ?? {}),
    ...copiedInput(action.copy ?? [], context),
    action_id: action.id,
    correlation_id: context.correlationId,
    subject: context.subject
      ? {
          id: context.subject.id,
          title: context.subject.title,
          values: context.subject.values,
          relationships: context.subject.relationships,
        }
      : null,
    actor: context.actor ?? null,
  };
}

export function buildRecordWorkActionRequest(action: ModelAction, context: RecordWorkActionContext): TargetRequest {
  if (action.blocked) throw new Error(action.blockedReason ?? 'This action is not available.');
  const target = action.ownerTarget;
  const operation = target.operation ?? 'execute_definition';
  const input = buildRecordWorkActionInput(action, context);
  if (operation === 'execute_definition') {
    if (!target.definitionId) throw new Error(`Owner target ${target.id} has no definition id.`);
    return {
      target: target.target,
      payload: {
        operation,
        definition_id: target.definitionId,
        include_steps: target.includeSteps ?? false,
        include_output: target.includeOutput ?? false,
        input,
      },
    };
  }
  return {
    target: target.target,
    payload: {
      operation,
      action_id: action.id,
      input,
    },
  };
}

export async function invokeRecordWorkAction(
  action: ModelAction,
  context: RecordWorkActionContext,
  sender: TargetSender = sendRequestToBitfieldTarget as TargetSender,
): Promise<unknown> {
  return sender(buildRecordWorkActionRequest(action, context));
}
