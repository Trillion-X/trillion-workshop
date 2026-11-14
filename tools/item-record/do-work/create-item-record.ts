import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export interface CreateItemRecordRequest {
  eventRef: string;
  scopeRef: string;
  targetRef: string;
  expectedRevision?: number;
  kind?: string | null;
  parentRef?: string | null;
  categoryRef?: string | null;
  title?: string | null;
  body?: string | null;
  extraFields?: Record<string, unknown>;
}

/** All caller-provided semantics remain opaque fields; target and scope are distinct owner coordinates. */
export async function createItemRecord(request: CreateItemRecordRequest): Promise<unknown> {
  if (!request.scopeRef?.trim() || !request.targetRef?.trim() || !request.eventRef?.trim()) throw new Error('item creation requires a subject, target, and idempotency reference');
  const fields: Record<string, unknown> = {
    ...(request.kind ? { kind: request.kind } : {}),
    ...(request.title ? { title: request.title } : {}),
    ...(request.body ? { body: request.body } : {}),
    ...(request.parentRef ? { parentRef: request.parentRef } : {}),
    ...(request.categoryRef ? { categoryRef: request.categoryRef } : {}),
    ...(request.extraFields ?? {}),
  };
  return sendRequestToBitfieldTarget({ target: 'item-record.create-item-record', payload: {
    subject_ref: request.scopeRef,
    target_ref: request.targetRef,
    expected_revision: request.expectedRevision ?? 0,
    idempotency_ref: request.eventRef,
    fields,
  } });
}
