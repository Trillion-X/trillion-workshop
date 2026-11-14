import { record, text } from '../read-data/capability-state-records';

export interface CallerContextDescriptor {
  subjectRef?: string;
  readerKey: string;
  resolved: boolean;
  reason?: string;
  actionDescriptorRefs: string[];
  fields: Record<string, unknown>;
}

export function resolveCallerContext(value: unknown): CallerContextDescriptor {
  const row = record(value);
  const descriptor = record(row.context ?? row.caller_context ?? row.callerContext ?? value);
  const subjectRef = text(descriptor.subject_ref ?? descriptor.subjectRef) || undefined;
  const readerKey = text(descriptor.reader_key ?? descriptor.readerKey) || 'default';
  const rawActionDescriptorRefs = descriptor.action_descriptor_refs ?? descriptor.actionDescriptorRefs;
  const actionDescriptorRefs = Array.isArray(rawActionDescriptorRefs)
    ? rawActionDescriptorRefs
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
    : [];
  return {
    subjectRef,
    readerKey,
    resolved: !!subjectRef,
    reason: subjectRef ? undefined : text(descriptor.reason) || 'caller context is missing required subject data',
    actionDescriptorRefs,
    fields: record(descriptor.fields),
  };
}
