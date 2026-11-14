import { readPath } from '../read-data/ranked-record-review-projection.js';

function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The second value here is a caller-assembled LOOKUP bag (row, input, session, requestRef)
// that copy rules read from. It is not the Runtime Kit context object, and it must not be
// named `context`: the target admission guard reserves argument two for the runtime's
// injected context by parameter NAME, so a homonym passes the guard while the runtime
// would hand this function an object with none of these fields.
function readFromLookup(lookup, source) {
  if (typeof source !== 'string' || source.length === 0) return undefined;
  const parts = source.split('.').filter(Boolean);
  const root = parts.shift();
  if (root === 'row') return readPath(lookup.row, parts);
  if (root === 'input') return readPath(lookup.input ?? {}, parts);
  if (root === 'session') return readPath(lookup.session ?? {}, parts);
  return undefined;
}

function copiedInput(action, lookup) {
  const copied = {};
  for (const entry of Array.isArray(action?.copy) ? action.copy : []) {
    const value = entry.from ? readFromLookup(lookup, entry.from) : entry.value;
    if (value !== undefined) copied[entry.key] = value;
  }
  return copied;
}

function splitActionRequest(actionRequest) {
  if (!isPlainRecord(actionRequest)) return { action: actionRequest, lookup: {} };
  const { lookup, ...action } = actionRequest;
  return { action, lookup: isPlainRecord(lookup) ? lookup : {} };
}

export function buildOwnerActionInput(action, lookup = {}) {
  const row = lookup.row ?? {};
  return {
    ...(isPlainRecord(action?.input) ? action.input : {}),
    ...(isPlainRecord(lookup.input) ? lookup.input : {}),
    ...copiedInput(action, lookup),
    action_id: action?.id,
    row_ref: row.recordId,
    request_ref: lookup.requestRef ?? row.idempotencyRef ?? `${action?.id ?? 'action'}:${row.recordId ?? 'record'}`,
  };
}

// One request object: the action descriptor with its lookup bag under `lookup`. Argument
// two is left to the Runtime Kit calling convention (the injected runtime context), which
// this builder never reads.
export function buildOwnerActionRequest(actionRequest) {
  const { action, lookup } = splitActionRequest(actionRequest);
  if (!isPlainRecord(action)) throw new Error('Action descriptor is required.');
  if (typeof action.id !== 'string' || action.id.length === 0) throw new Error('Action descriptor requires id.');
  if (action.enabled === false) throw new Error(action.disabledReason ?? 'Action is disabled.');
  const target = action.target ?? 'slot::workflow';
  const operation = action.operation ?? 'execute_definition';
  const input = buildOwnerActionInput(action, lookup);
  if (operation === 'execute_definition') {
    const definitionId = action.definition_id ?? action.definitionId;
    if (typeof definitionId !== 'string' || definitionId.length === 0) {
      throw new Error(`Action ${action.id} has no owner definition.`);
    }
    const request = {
      target,
      payload: {
        operation,
        definition_id: definitionId,
        include_steps: false,
        include_output: false,
        input,
      },
    };
    console.log('[suggested-match] owner action request built', { request_ref: input.request_ref });
    return request;
  }
  const request = {
    target,
    payload: {
      operation,
      action_id: action.id,
      input,
    },
  };
  console.log('[suggested-match] owner action request built', { request_ref: input.request_ref });
  return request;
}

export async function invokeOwnerAction(actionRequest, _context, sender) {
  if (typeof sender !== 'function') throw new Error('A target sender function is required.');
  return sender(buildOwnerActionRequest(actionRequest));
}
