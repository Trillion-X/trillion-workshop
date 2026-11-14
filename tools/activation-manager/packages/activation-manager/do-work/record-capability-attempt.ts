export interface CapabilityActionAttemptInput {
  descriptorRef: string;
  ownerTargetRef: string;
  subjectRef?: string;
  capabilityRef?: string;
  correlationRef?: string;
  inputRef?: string;
  processSessionRef?: string;
  evidenceRefs?: string[];
  fields?: Record<string, unknown>;
}

export interface CapabilityActionAttemptRecord {
  kind: 'capability-action-attempt-record';
  id: string;
  descriptorRef: string;
  ownerTargetRef: string;
  subjectRef?: string;
  capabilityRef?: string;
  correlationRef?: string;
  inputRef?: string;
  processSessionRef?: string;
  evidenceRefs?: string[];
  dispatched: boolean;
  disabledReason?: string;
  fields: Record<string, unknown>;
}

function clean(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export function recordCapabilityAttempt(input: CapabilityActionAttemptInput): CapabilityActionAttemptRecord {
  const descriptorRef = clean(input.descriptorRef, 'descriptorRef');
  const ownerTargetRef = clean(input.ownerTargetRef, 'ownerTargetRef');
  const id = input.correlationRef?.trim() || `${descriptorRef}:attempt`;
  return {
    kind: 'capability-action-attempt-record',
    id,
    descriptorRef,
    ownerTargetRef,
    subjectRef: input.subjectRef,
    capabilityRef: input.capabilityRef,
    correlationRef: input.correlationRef,
    inputRef: input.inputRef,
    processSessionRef: input.processSessionRef,
    evidenceRefs: input.evidenceRefs,
    dispatched: true,
    fields: input.fields ?? {},
  };
}
