import { type ActionDescriptor, type PlainRecord, text } from '../read-data/descriptor-contracts.ts';

export interface GenericRecordEventContext {
  operation_id: string;
  actor_ref?: string;
  subject_ref?: string;
  source_record_ref?: string;
  address_prefix?: string;
}

export interface GenericRecordWrite {
  address: string;
  path: string[];
  payload: PlainRecord;
  remove: boolean;
}

function cleanSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9:._-]/g, '-');
}

export function buildGenericRecordEventWrite(
  descriptor: ActionDescriptor,
  fieldValues: PlainRecord,
  context: GenericRecordEventContext,
): GenericRecordWrite {
  const prefix = context.address_prefix ?? 'package::package-store-reviews';
  const id = cleanSegment(text(fieldValues.id, context.operation_id));
  const operation = descriptor.operation ?? 'append-record';
  const recordKind = descriptor.record_kind ?? 'generic-record';
  const relationshipId = descriptor.relationship_id ?? '';
  const isRelationship = operation === 'append-relationship';
  const address = isRelationship
    ? `${prefix}::relationship::${cleanSegment(relationshipId || descriptor.id)}::${id}`
    : `${prefix}::record::${cleanSegment(recordKind)}::${id}`;

  return {
    address,
    path: ['current-item', 'published-record'],
    payload: {
      kind: isRelationship ? 'generic-relationship-event' : 'generic-record-event',
      operation,
      action_id: descriptor.id,
      record_kind: recordKind,
      relationship_id: relationshipId || null,
      record_id: id,
      actor_ref: context.actor_ref ?? text(fieldValues['actor-ref'], ''),
      subject_ref: context.subject_ref ?? text(fieldValues['subject-ref'], ''),
      source_record_ref: context.source_record_ref ?? text(fieldValues.source_record_ref, ''),
      field_values: fieldValues,
    },
    remove: operation === 'remove-record',
  };
}
