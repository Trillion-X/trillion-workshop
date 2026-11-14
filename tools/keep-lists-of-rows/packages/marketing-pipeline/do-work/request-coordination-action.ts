export type JsonRecord = Record<string, unknown>;

export interface CoordinationActionDescriptor {
  id: string;
  targetRef?: string;
  operation?: string;
  definitionRef?: string;
  input?: JsonRecord;
  inputMap?: Array<{ key: string; from?: string; value?: unknown }>;
  receiptRef?: string;
}

export interface CoordinationActionContext {
  operationId: string;
  recordRef?: string;
  fieldPatch?: JsonRecord;
  relationships?: JsonRecord[];
  evidenceRefs?: JsonRecord[];
  processSessionRefs?: JsonRecord[];
  answers?: JsonRecord;
  descriptors?: CoordinationActionDescriptor[];
}

export interface CoordinationTargetRequest {
  target: string;
  payload: JsonRecord;
}

export interface CoordinationActionRequest {
  writes: JsonRecord[];
  targetRequests: CoordinationTargetRequest[];
  errors: Array<{ code: string; detail: string }>;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readPath(context: CoordinationActionContext, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let current: unknown;
  switch (parts.shift()) {
    case 'request':
      current = context;
      break;
    case 'answers':
      current = context.answers ?? {};
      break;
    default:
      return undefined;
  }
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function mappedInput(descriptor: CoordinationActionDescriptor, context: CoordinationActionContext): JsonRecord {
  const copied: JsonRecord = {};
  for (const mapping of descriptor.inputMap ?? []) {
    const value = mapping.from ? readPath(context, mapping.from) : mapping.value;
    if (value !== undefined) copied[mapping.key] = value;
  }
  return {
    ...(isRecord(descriptor.input) ? descriptor.input : {}),
    ...(context.answers ?? {}),
    ...copied,
    action_id: descriptor.id,
    operation_id: context.operationId,
    record_ref: context.recordRef ?? null,
    field_patch: context.fieldPatch ?? {},
    relationships: context.relationships ?? [],
    evidence_refs: context.evidenceRefs ?? [],
    process_session_refs: context.processSessionRefs ?? [],
    receipt_ref: descriptor.receiptRef ?? null,
  };
}

function coordinationWrite(descriptor: CoordinationActionDescriptor, context: CoordinationActionContext): JsonRecord {
  return {
    kind: 'coordination.action-request.v1',
    action_id: descriptor.id,
    operation_id: context.operationId,
    record_ref: context.recordRef ?? null,
    field_patch: context.fieldPatch ?? {},
    relationships: context.relationships ?? [],
    evidence_refs: context.evidenceRefs ?? [],
    process_session_refs: context.processSessionRefs ?? [],
    receipt_ref: descriptor.receiptRef ?? null,
  };
}

export function buildCoordinationTargetRequest(
  descriptor: CoordinationActionDescriptor,
  context: CoordinationActionContext,
): CoordinationTargetRequest {
  const payload = mappedInput(descriptor, context);
  if (descriptor.definitionRef) {
    return {
      target: descriptor.targetRef ?? 'slot::workflow',
      payload: {
        operation: descriptor.operation ?? 'execute_definition',
        definition_ref: descriptor.definitionRef,
        input: payload,
        receipt_ref: descriptor.receiptRef ?? null,
      },
    };
  }
  return {
    target: descriptor.targetRef ?? 'engine.operation.write-batch',
    payload: {
      operation: descriptor.operation ?? 'write',
      input: payload,
    },
  };
}

export function requestCoordinationAction(
  descriptor: CoordinationActionDescriptor | undefined,
  context: CoordinationActionContext,
): CoordinationActionRequest {
  if (!descriptor) {
    return {
      writes: [],
      targetRequests: [],
      errors: [{ code: 'missing-action-descriptor', detail: 'No action descriptor matched the request.' }],
    };
  }
  const operationId = text(context.operationId, '');
  if (!operationId) {
    return {
      writes: [],
      targetRequests: [],
      errors: [{ code: 'missing-operation-id', detail: 'Every action request needs a stable operation id.' }],
    };
  }
  const write = coordinationWrite(descriptor, context);
  const targetRequests = descriptor.targetRef || descriptor.definitionRef
    ? [buildCoordinationTargetRequest(descriptor, context)]
    : [];
  console.info(`[marketing-pipeline] action descriptor=${descriptor.id} target=${descriptor.targetRef ?? 'local-write'}`);
  return {
    writes: [write],
    targetRequests,
    errors: [],
  };
}
