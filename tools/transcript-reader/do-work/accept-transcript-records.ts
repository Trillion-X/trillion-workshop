// package-set://bitfield-studio/packages/transcript-history/do-work/accept-transcript-records.ts
//
// Descriptor-driven owner action builder. It emits the existing generic
// write-batch operation; it does not introduce a transcript-specific endpoint.

import type { JsonRecord, TranscriptHistoryItem } from '@/packages/transcript-history/read-data/transcript-history-record-graph';

export interface BindingDescriptor {
  from: 'selected' | 'answers' | 'literal';
  path?: readonly string[];
  value?: unknown;
}

export interface WritePlanDescriptor {
  recordRole: string;
  addressPrefix: string;
  idFrom: BindingDescriptor;
  path: readonly string[];
  payload: Record<string, BindingDescriptor | unknown>;
  sourceList?: BindingDescriptor;
}

export interface AcceptTranscriptRecordsActionDescriptor {
  id: string;
  operation?: 'engine.operation.write-batch';
  proofGates?: readonly string[];
  writePlan: readonly WritePlanDescriptor[];
}

export interface AcceptTranscriptRecordsContext {
  selected?: TranscriptHistoryItem | null;
  answers?: Readonly<JsonRecord>;
}

export interface RecordWrite {
  address: string;
  path: string[];
  payload: JsonRecord;
}

export interface AcceptTranscriptRecordsRequest {
  operation: 'engine.operation.write-batch';
  records: RecordWrite[];
  proof: {
    actionId: string;
    proofGates: readonly string[];
    sourceRefs: readonly string[];
    idempotencyKey: string;
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9:._-]/g, '-');
}

function readPath(value: unknown, path: readonly string[] = []): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function readBinding(binding: BindingDescriptor, context: AcceptTranscriptRecordsContext, item: TranscriptHistoryItem | JsonRecord | null): unknown {
  if (binding.from === 'literal') return binding.value;
  const source = binding.from === 'answers' ? context.answers ?? {} : item && 'raw' in item ? item.raw : item;
  return readPath(source, binding.path ?? []);
}

function isBinding(value: unknown): value is BindingDescriptor {
  return isRecord(value) && (value.from === 'selected' || value.from === 'answers' || value.from === 'literal');
}

function payloadFrom(plan: WritePlanDescriptor, context: AcceptTranscriptRecordsContext, item: TranscriptHistoryItem | JsonRecord): JsonRecord {
  const payload: JsonRecord = { kind: plan.recordRole };
  for (const [key, value] of Object.entries(plan.payload)) {
    payload[key] = isBinding(value) ? readBinding(value, context, item) : value;
  }
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)) as JsonRecord;
}

function sourceItems(plan: WritePlanDescriptor, context: AcceptTranscriptRecordsContext): Array<TranscriptHistoryItem | JsonRecord> {
  if (!plan.sourceList) return context.selected ? [context.selected] : [];
  const value = readBinding(plan.sourceList, context, context.selected ?? null);
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function writeFrom(plan: WritePlanDescriptor, context: AcceptTranscriptRecordsContext, item: TranscriptHistoryItem | JsonRecord): RecordWrite {
  const id = readBinding(plan.idFrom, context, item);
  if (typeof id !== 'string' || !id) throw new Error(`Action write for ${plan.recordRole} is missing its declared identity.`);
  return {
    address: `${plan.addressPrefix}${cleanSegment(id)}`,
    path: [...plan.path],
    payload: payloadFrom(plan, context, item),
  };
}

export function buildAcceptTranscriptRecordsRequest(
  action: AcceptTranscriptRecordsActionDescriptor,
  context: AcceptTranscriptRecordsContext,
): AcceptTranscriptRecordsRequest {
  if (!context.selected) throw new Error('Select a current record before accepting it.');
  if (action.proofGates?.length && context.selected.proofRefs.length === 0) {
    throw new Error('This action needs current source proof before it can write records.');
  }
  const records = action.writePlan.flatMap((plan) => sourceItems(plan, context).map((item) => writeFrom(plan, context, item)));
  const sourceRefs = [...new Set(context.selected.proofRefs)];
  return {
    operation: action.operation ?? 'engine.operation.write-batch',
    records,
    proof: {
      actionId: action.id,
      proofGates: action.proofGates ?? [],
      sourceRefs,
      idempotencyKey: `${action.id}:${context.selected.id}:${sourceRefs.join('|')}`,
    },
  };
}
