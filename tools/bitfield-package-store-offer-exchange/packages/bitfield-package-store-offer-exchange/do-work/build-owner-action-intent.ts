import type { ExchangeAction, ExchangeRelationship, RecordMap } from '../read-data/read-record-exchange-projection';
import { isRecordMap } from '../read-data/read-record-exchange-projection';

export interface OwnerActionIntentInput {
  action: ExchangeAction;
  recordRef: string;
  relationships?: ExchangeRelationship[];
  values?: RecordMap;
  actorRef?: string;
  correlationRef?: string;
}

export interface OwnerActionIntent {
  target: string;
  payload: RecordMap;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function relationshipValues(ref: string, relationships: ExchangeRelationship[]): string[] {
  return relationships.filter((entry) => entry.relationshipRef === ref).map((entry) => entry.targetRef);
}

function readBindingValue(bindingFrom: string, input: OwnerActionIntentInput): unknown {
  if (bindingFrom === 'record.current') return input.recordRef;
  if (bindingFrom.startsWith('relationship:')) return relationshipValues(bindingFrom, input.relationships ?? []);
  if (bindingFrom.startsWith('value.')) {
    const key = bindingFrom.slice('value.'.length);
    return isRecordMap(input.values) ? input.values[key] : undefined;
  }
  return undefined;
}

export function buildOwnerActionIntent(input: OwnerActionIntentInput): OwnerActionIntent {
  const boundInput: RecordMap = {};
  for (const binding of input.action.inputBindings) {
    const value = readBindingValue(binding.from, input);
    if (value !== undefined) boundInput[binding.to] = value;
  }
  return {
    target: input.action.target,
    payload: {
      operation_ref: input.action.operationRef,
      definition_ref: input.action.definitionRef ?? null,
      action_ref: input.action.id,
      target_owner_ref: input.action.targetOwnerRef,
      record_ref: input.recordRef,
      actor_ref: input.actorRef ?? null,
      correlation_ref: input.correlationRef ?? `${input.action.id}:${input.recordRef}`,
      input: boundInput,
      result_projection_ref: input.action.resultProjectionRef ?? null,
    },
  };
}

export function buildOwnerActionIntentTarget(request: unknown): OwnerActionIntent {
  if (!isRecordMap(request) || !isRecordMap(request.action)) {
    throw new Error('record-exchange-intent-request-invalid');
  }
  const action = request.action as unknown as ExchangeAction;
  const relationships = Array.isArray(request.relationships)
    ? request.relationships.filter(isRecordMap).map((entry) => ({
        id: text(entry.id),
        sourceRef: text(entry.sourceRef ?? entry.source_ref),
        relationshipRef: text(entry.relationshipRef ?? entry.relationship_ref),
        targetRef: text(entry.targetRef ?? entry.target_ref),
        label: text(entry.label),
      }))
    : [];
  return buildOwnerActionIntent({
    action,
    recordRef: text(request.recordRef ?? request.record_ref),
    relationships,
    values: isRecordMap(request.values) ? request.values : undefined,
    actorRef: text(request.actorRef ?? request.actor_ref) || undefined,
    correlationRef: text(request.correlationRef ?? request.correlation_ref) || undefined,
  });
}

