import { readPath } from '../read-data/read-record-projection.mjs';

function readFromContext(context, source) {
  if (typeof source !== 'string' || source.length === 0) return undefined;
  const parts = source.split('.').filter(Boolean);
  const root = parts.shift();
  if (root === 'row') return readPath(context.row, parts);
  if (root === 'answers') return readPath(context.answers ?? {}, parts);
  if (root === 'session') return readPath(context.session ?? {}, parts);
  return undefined;
}

export function buildRecordActionInput(action, context = {}) {
  const copied = {};
  for (const entry of Array.isArray(action?.copy) ? action.copy : []) {
    const value = entry.from ? readFromContext(context, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  return {
    ...(action?.input ?? {}),
    ...(context.answers ?? {}),
    ...copied,
    action_id: action?.id,
    row_id: context.row?.recordId,
  };
}

export function buildRecordActionRequest(action, context = {}) {
  if (!action || typeof action !== 'object') throw new Error('Action descriptor is required.');
  if (action.enabled === false) throw new Error(action.disabledReason ?? 'Action is disabled.');
  if (typeof action.id !== 'string' || action.id.length === 0) throw new Error('Action descriptor requires id.');
  const operation = action.operation ?? 'execute_definition';
  const target = action.target ?? 'slot::workflow';
  const input = buildRecordActionInput(action, context);
  if (operation === 'execute_definition') {
    const definitionId = action.definitionId ?? action.definition_id;
    if (typeof definitionId !== 'string' || definitionId.length === 0) {
      throw new Error(`Action ${action.id} has no owner definition.`);
    }
    return {
      target,
      payload: {
        operation,
        definition_id: definitionId,
        include_steps: false,
        include_output: false,
        input,
      },
    };
  }
  return {
    target,
    payload: {
      operation,
      action_id: action.id,
      input,
    },
  };
}

export async function invokeRecordAction(action, context = {}, sender) {
  if (typeof sender !== 'function') throw new Error('A target sender function is required.');
  const request = buildRecordActionRequest(action, context);
  return sender(request);
}
