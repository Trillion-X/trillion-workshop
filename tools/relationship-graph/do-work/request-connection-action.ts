import {
  defaultSelectorRegistry,
  evaluateSelector,
  objectValue,
  textValue,
  type SelectorRegistry,
} from '../read-data/connection-descriptor.ts';
import type { ActionDescriptor, JsonObject } from '../read-data/connection-model.ts';

export type ConnectionActionInput = {
  readonly action: ActionDescriptor;
  readonly input: JsonObject;
  readonly correlation_id?: string;
};

export type ConnectionActionUnavailable = {
  readonly available: false;
  readonly reason: 'missing-target' | 'missing-action';
};

export type ConnectionActionPrepared = {
  readonly available: true;
  readonly target: string;
  readonly payload: JsonObject;
};

export type ConnectionActionResult = ConnectionActionUnavailable | ConnectionActionPrepared;

function mappedInput(
  action: ActionDescriptor,
  input: JsonObject,
  registry: SelectorRegistry,
): JsonObject {
  if (!action.input_mapping) return input;
  const payload: Record<string, unknown> = {};
  const context = { row: { payload: input }, payload: input };
  for (const [key, selector] of Object.entries(action.input_mapping)) {
    const value = evaluateSelector(selector, context, registry);
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}

export function prepareConnectionActionRequest(
  value: ConnectionActionInput,
  registry: SelectorRegistry = defaultSelectorRegistry,
): ConnectionActionResult {
  const actionId = textValue(value.action.id);
  if (!actionId) return { available: false, reason: 'missing-action' };
  const target = textValue(value.action.target);
  if (!target) return { available: false, reason: 'missing-target' };

  return {
    available: true,
    target,
    payload: objectValue({
      action_id: actionId,
      operation: value.action.operation ?? 'owner-action',
      definition_id: value.action.definition_id,
      input: mappedInput(value.action, value.input, registry),
      status_mapping: value.action.status_mapping,
      correlation_id: value.correlation_id,
    }),
  };
}
