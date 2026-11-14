import { readPath, text } from './universal-action-event-contract.ts';
import type {
  UniversalActionEventProcessProofDescriptor,
  UniversalActionEventProofDescriptor,
  UniversalActionEventRecord,
} from './universal-action-event-contract.ts';

export interface ProcessProofInput {
  record: UniversalActionEventRecord;
  feed?: unknown;
  descriptor: UniversalActionEventProcessProofDescriptor;
}

export interface ProjectedProcessProof {
  id: string;
  label: string;
  proofDescriptor: UniversalActionEventProofDescriptor;
  sessionRef?: string;
  eventFeedRef?: string;
  summary: string;
  error?: string;
}

export function projectProcessProof(input: ProcessProofInput): ProjectedProcessProof {
  const sessionRef = text(readPath(input.record, input.descriptor.sessionRefPath ?? [])) || input.record.processSessionRefs?.[0];
  const eventFeedRef = text(readPath(input.record, input.descriptor.eventFeedRefPath ?? []));
  const summary = (input.descriptor.summaryPaths ?? [])
    .map((path) => text(readPath(input.feed, path)) || text(readPath(input.record, path)))
    .find(Boolean) ?? '';
  return {
    id: input.descriptor.id,
    label: input.descriptor.label ?? input.descriptor.id,
    sessionRef,
    eventFeedRef,
    summary,
    proofDescriptor: {
      id: input.descriptor.proofDescriptorId ?? input.descriptor.id,
      label: input.descriptor.label ?? input.descriptor.id,
      disclosure: 'summary',
      paths: [],
      errorText: summary ? undefined : 'Proof is not available.',
    },
    ...(summary ? {} : { error: 'Proof is not available.' }),
  };
}
