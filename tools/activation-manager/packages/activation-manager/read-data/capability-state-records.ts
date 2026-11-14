export interface CapabilityStateDescriptor {
  key: string;
  label?: string;
  tone?: string;
  rank?: number;
  terminal?: boolean;
  error?: boolean;
  fields: Record<string, unknown>;
}

export interface CapabilityRequirementDescriptor {
  id: string;
  label: string;
  fields: Record<string, unknown>;
}

export interface CapabilityActionDescriptor {
  id: string;
  label: string;
  target: string;
  enabled: boolean;
  input: unknown;
  disabledReason?: string;
  processSessionRef?: string;
  metadata: Record<string, unknown>;
}

export interface CapabilityEvidenceRecord {
  kind: 'capability-state-evidence-record';
  id: string;
  subjectRef: string;
  capabilityRef: string;
  state: CapabilityStateDescriptor;
  evidenceRefs: string[];
  requirements: CapabilityRequirementDescriptor[];
  actions: CapabilityActionDescriptor[];
  display: Record<string, unknown>;
  fields: Record<string, unknown>;
  supersedes: string[];
}

export interface CapabilityProjectionConfig {
  kind: 'capability-state-projection-record';
  id: string;
  label: string;
  sourceRecordKind: string;
  readerKey: string;
  freshness: {
    label: string;
    stale: boolean;
    disabledReason?: string;
    fields: Record<string, unknown>;
  };
}

export interface CapabilityAttemptRecord {
  kind: 'capability-action-attempt-record';
  id: string;
  descriptorRef: string;
  subjectRef?: string;
  capabilityRef?: string;
  ownerTargetRef: string;
  correlationRef?: string;
  inputRef?: string;
  fields: Record<string, unknown>;
}

export interface CapabilityResultRecord {
  kind: 'capability-action-result-record';
  id: string;
  attemptRef: string;
  evidenceRefs: string[];
  outcome: string;
  fields: Record<string, unknown>;
}

export interface DecodeProblem {
  id: string;
  title: string;
  detail?: string;
}

export interface CapabilityStateDecodeResult {
  evidence: CapabilityEvidenceRecord[];
  projections: CapabilityProjectionConfig[];
  attempts: CapabilityAttemptRecord[];
  results: CapabilityResultRecord[];
  problems: DecodeProblem[];
}

export type PackageThing = {
  payload?: unknown;
};

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textList(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function problem(id: string, title: string, detail?: string): DecodeProblem {
  return detail ? { id, title, detail } : { id, title };
}

function readStateDescriptor(value: unknown): CapabilityStateDescriptor {
  const row = record(value);
  return {
    key: text(row.key),
    label: text(row.label) || undefined,
    tone: text(row.tone) || undefined,
    rank: number(row.rank),
    terminal: bool(row.terminal, false),
    error: bool(row.error, false),
    fields: record(row.fields),
  };
}

function readRequirement(value: unknown): CapabilityRequirementDescriptor | null {
  const row = record(value);
  const id = text(row.id);
  const label = text(row.label);
  if (!id || !label) return null;
  return { id, label, fields: record(row.fields) };
}

export function readCapabilityActionDescriptor(value: unknown): CapabilityActionDescriptor | null {
  const row = record(value);
  const id = text(row.id);
  const label = text(row.label);
  const target = text(row.target);
  if (!id || !label || !target) return null;
  return {
    id,
    label,
    target,
    enabled: bool(row.enabled, true),
    input: row.input ?? {},
    disabledReason: text(row.disabled_reason ?? row.disabledReason) || undefined,
    processSessionRef: text(row.process_session_ref ?? row.processSessionRef) || undefined,
    metadata: record(row.metadata),
  };
}

function readEvidence(value: unknown, index: number, problems: DecodeProblem[]): CapabilityEvidenceRecord | null {
  const row = record(value);
  if (text(row.kind) !== 'capability-state-evidence-record') return null;
  const id = text(row.id);
  const subjectRef = text(row.subject_ref ?? row.subjectRef);
  const capabilityRef = text(row.capability_ref ?? row.capabilityRef);
  const state = readStateDescriptor(row.state_descriptor ?? row.stateDescriptor);
  const problemId = id || `capability-state-evidence-record:${index}`;
  if (!id) problems.push(problem(`${problemId}:missing-id`, 'Capability evidence is missing an id'));
  if (!subjectRef) problems.push(problem(`${problemId}:missing-subject`, 'Capability evidence is missing a subject reference'));
  if (!capabilityRef) problems.push(problem(`${problemId}:missing-capability`, 'Capability evidence is missing a capability reference'));
  if (!state.key) problems.push(problem(`${problemId}:missing-state`, 'Capability evidence is missing a state descriptor key'));
  if (!id || !subjectRef || !capabilityRef || !state.key) return null;

  return {
    kind: 'capability-state-evidence-record',
    id,
    subjectRef,
    capabilityRef,
    state,
    evidenceRefs: textList(row.evidence_refs ?? row.evidenceRefs),
    requirements: list(row.requirements).map(readRequirement).filter((entry): entry is CapabilityRequirementDescriptor => entry !== null),
    actions: list(row.actions).map(readCapabilityActionDescriptor).filter((entry): entry is CapabilityActionDescriptor => entry !== null),
    display: record(row.display),
    fields: record(row.fields),
    supersedes: textList(row.supersedes),
  };
}

function readProjection(value: unknown): CapabilityProjectionConfig | null {
  const row = record(value);
  if (text(row.kind) !== 'capability-state-projection-record') return null;
  const id = text(row.id);
  const label = text(row.label);
  if (!id || !label) return null;
  const freshness = record(row.freshness);
  return {
    kind: 'capability-state-projection-record',
    id,
    label,
    sourceRecordKind: text(row.source_record_kind ?? row.sourceRecordKind) || 'capability-state-evidence-record',
    readerKey: text(row.reader_key ?? row.readerKey) || 'default',
    freshness: {
      label: text(freshness.label),
      stale: bool(freshness.stale, false),
      disabledReason: text(freshness.disabled_reason ?? freshness.disabledReason) || undefined,
      fields: record(freshness.fields),
    },
  };
}

function readAttempt(value: unknown): CapabilityAttemptRecord | null {
  const row = record(value);
  if (text(row.kind) !== 'capability-action-attempt-record') return null;
  const id = text(row.id);
  const descriptorRef = text(row.descriptor_ref ?? row.descriptorRef);
  const ownerTargetRef = text(row.owner_target_ref ?? row.ownerTargetRef);
  if (!id || !descriptorRef || !ownerTargetRef) return null;
  return {
    kind: 'capability-action-attempt-record',
    id,
    descriptorRef,
    subjectRef: text(row.subject_ref ?? row.subjectRef) || undefined,
    capabilityRef: text(row.capability_ref ?? row.capabilityRef) || undefined,
    ownerTargetRef,
    correlationRef: text(row.correlation_ref ?? row.correlationRef) || undefined,
    inputRef: text(row.input_ref ?? row.inputRef) || undefined,
    fields: record(row.fields),
  };
}

function readResult(value: unknown): CapabilityResultRecord | null {
  const row = record(value);
  if (text(row.kind) !== 'capability-action-result-record') return null;
  const id = text(row.id);
  const attemptRef = text(row.attempt_ref ?? row.attemptRef);
  const outcome = text(row.outcome);
  if (!id || !attemptRef || !outcome) return null;
  return {
    kind: 'capability-action-result-record',
    id,
    attemptRef,
    outcome,
    evidenceRefs: textList(row.evidence_refs ?? row.evidenceRefs),
    fields: record(row.fields),
  };
}

export function decodeCapabilityStateRecords(rawThings: readonly PackageThing[]): CapabilityStateDecodeResult {
  const problems: DecodeProblem[] = [];
  const payloads = rawThings.map((thing) => thing.payload);
  return {
    evidence: payloads
      .map((payload, index) => readEvidence(payload, index, problems))
      .filter((entry): entry is CapabilityEvidenceRecord => entry !== null),
    projections: payloads.map(readProjection).filter((entry): entry is CapabilityProjectionConfig => entry !== null),
    attempts: payloads.map(readAttempt).filter((entry): entry is CapabilityAttemptRecord => entry !== null),
    results: payloads.map(readResult).filter((entry): entry is CapabilityResultRecord => entry !== null),
    problems,
  };
}
