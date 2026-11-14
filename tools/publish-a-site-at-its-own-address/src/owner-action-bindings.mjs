import { isObject, objectList, text } from './configured-record-action-projection.mjs';

export function readPath(source, path = []) {
  return path.reduce((current, segment) => (isObject(current) ? current[segment] : undefined), source);
}

export function findActionBinding(config, actionRef) {
  return objectList(config?.action_bindings).find((action) => text(action.id) === actionRef || text(action.role_ref) === actionRef) ?? null;
}

export function buildOwnerActionInvocation({ config, actionRef, subject, context = {} }) {
  const action = findActionBinding(config, actionRef);
  if (!action) return { errors: [{ code: 'missing-action-binding', detail: actionRef }], targetRequests: [], trace: { actionRef } };
  const sources = { subject, context };
  const input = {};
  const bindingKeys = [];
  for (const binding of objectList(action.input_bindings)) {
    const key = text(binding.key);
    const source = text(binding.source);
    const value = binding.value !== undefined ? binding.value : readPath(sources[source], binding.path ?? []);
    if (key && value !== undefined) {
      input[key] = value;
      bindingKeys.push(key);
    }
  }
  const target = text(action.target, 'slot::workflow');
  const definitionId = text(action.definition_id);
  const payload = definitionId
    ? {
        method: 'execute_definition',
        definition_id: definitionId,
        input,
        correlation_ref: text(context.correlation_ref),
      }
    : {
        method: text(action.method, 'invoke_owner_action'),
        action_id: text(action.id),
        input,
        correlation_ref: text(context.correlation_ref),
      };
  return {
    errors: [],
    targetRequests: [{ target, payload }],
    effectReceiptSeed: {
      correlation_ref: text(context.correlation_ref),
      effect_role: text(action.effect_role_ref),
      process_session_ref: null,
    },
    trace: {
      actionRef,
      actionId: text(action.id),
      bindingKeys,
      target,
      definitionId,
    },
  };
}

export function assertNoOwnerInternals(request) {
  const serialized = JSON.stringify(request);
  const forbidden = [
    'process_descriptor',
    'credential_secret',
    'http_request',
    'secret_value',
    'owner_internal_state',
  ];
  const found = forbidden.filter((term) => serialized.includes(term));
  if (found.length > 0) throw new Error(`owner internals leaked: ${found.join(', ')}`);
  return true;
}
