export type RecordMap = Record<string, unknown>;

export interface ActionDescriptor {
  id: string;
  target: string;
  operation?: string;
  definitionId?: string;
  ownerRef?: string;
  permissionRef?: string;
  idempotencyKey?: string;
  input?: RecordMap;
  copy?: Array<{ key: string; from?: string; value?: unknown }>;
}

export interface ActionContext {
  actionId: string;
  workRecordId: string;
  actorRef?: string;
  ownerRef?: string;
  answers?: RecordMap;
  fieldPatch?: RecordMap;
  ownerRefs?: string[];
  receiptRef?: string;
}

export interface TargetInvocation {
  target: string;
  payload: RecordMap;
}

function isObject(value: unknown): value is RecordMap {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPath(context: ActionContext, path: string): unknown {
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
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function buildRecordWorkActionInvocation(
  descriptor: ActionDescriptor,
  context: ActionContext,
): TargetInvocation {
  if (descriptor.ownerRef && context.ownerRef && descriptor.ownerRef !== context.ownerRef) {
    throw new Error('record-work-action-owner-mismatch');
  }
  const copied: RecordMap = {};
  for (const rule of descriptor.copy ?? []) {
    const value = rule.from ? readPath(context, rule.from) : rule.value;
    if (value !== undefined) copied[rule.key] = value;
  }
  return {
    target: descriptor.target,
    payload: {
      operation: descriptor.operation ?? (descriptor.definitionId ? 'execute_definition' : 'invoke'),
      definition_id: descriptor.definitionId ?? null,
      action_id: descriptor.id,
      work_record_id: context.workRecordId,
      actor_ref: context.actorRef ?? null,
      owner_ref: descriptor.ownerRef ?? context.ownerRef ?? null,
      permission_ref: descriptor.permissionRef ?? null,
      idempotency_key: descriptor.idempotencyKey ?? `${descriptor.id}:${context.workRecordId}`,
      input: {
        ...(descriptor.input ?? {}),
        ...(context.answers ?? {}),
        ...copied,
        field_patch: context.fieldPatch ?? {},
        owner_refs: context.ownerRefs ?? [],
        receipt_ref: context.receiptRef ?? null,
      },
    },
  };
}

