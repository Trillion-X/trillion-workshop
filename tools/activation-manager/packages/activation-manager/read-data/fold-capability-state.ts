import {
  type CapabilityActionDescriptor,
  type CapabilityEvidenceRecord,
  type CapabilityProjectionConfig,
  type CapabilityStateDecodeResult,
  type CapabilityStateDescriptor,
  type DecodeProblem,
  record,
  text,
} from './capability-state-records';

export interface CapabilityStateActionView {
  id: string;
  label: string;
  target: string;
  enabled: boolean;
  disabledReason?: string;
  request: unknown;
  processSessionRef?: string;
  metadata: Record<string, unknown>;
}

export interface CapabilityStateView {
  id: string;
  subjectRef: string;
  capabilityRef: string;
  title: string;
  state: CapabilityStateDescriptor;
  evidenceRefs: string[];
  requirementRefs: string[];
  nextActionDescriptors: CapabilityStateActionView[];
  displayRefs: Record<string, unknown>;
  stale: boolean;
  missing: boolean;
  fields: Record<string, unknown>;
}

export interface CapabilityStateProjection {
  views: CapabilityStateView[];
  projection: CapabilityProjectionConfig;
  problems: DecodeProblem[];
}

function fallbackProjection(): CapabilityProjectionConfig {
  return {
    kind: 'capability-state-projection-record',
    id: 'capability-state-projection:implicit',
    label: '',
    sourceRecordKind: 'capability-state-evidence-record',
    readerKey: 'default',
    freshness: { label: '', stale: false, fields: {} },
  };
}

function viewTitle(recordEntry: CapabilityEvidenceRecord): string {
  const display = record(recordEntry.display);
  return text(display.title) || text(display.label) || recordEntry.id;
}

function actionView(action: CapabilityActionDescriptor, staleReason?: string): CapabilityStateActionView {
  return {
    id: action.id,
    label: action.label,
    target: action.target,
    enabled: staleReason ? false : action.enabled,
    disabledReason: staleReason || action.disabledReason,
    request: action.input,
    processSessionRef: action.processSessionRef,
    metadata: action.metadata,
  };
}

function liveEvidence(records: readonly CapabilityEvidenceRecord[]): CapabilityEvidenceRecord[] {
  const superseded = new Set(records.flatMap((entry) => entry.supersedes));
  return records.filter((entry) => !superseded.has(entry.id));
}

export function foldCapabilityState(decode: CapabilityStateDecodeResult): CapabilityStateProjection {
  const projection = decode.projections[0] ?? fallbackProjection();
  const staleReason = projection.freshness.stale
    ? projection.freshness.disabledReason || projection.freshness.label
    : undefined;
  const views = liveEvidence(decode.evidence).map((recordEntry) => ({
    id: recordEntry.id,
    subjectRef: recordEntry.subjectRef,
    capabilityRef: recordEntry.capabilityRef,
    title: viewTitle(recordEntry),
    state: recordEntry.state,
    evidenceRefs: recordEntry.evidenceRefs,
    requirementRefs: recordEntry.requirements.map((entry) => entry.id),
    nextActionDescriptors: recordEntry.actions.map((action) => actionView(action, staleReason)),
    displayRefs: record(recordEntry.display.refs ?? recordEntry.display.display_refs),
    stale: projection.freshness.stale,
    missing: false,
    fields: recordEntry.fields,
  }));

  return {
    views: views.sort((left, right) => {
      const rankDelta = (left.state.rank ?? Number.MAX_SAFE_INTEGER) - (right.state.rank ?? Number.MAX_SAFE_INTEGER);
      return rankDelta === 0 ? left.title.localeCompare(right.title) : rankDelta;
    }),
    projection,
    problems: decode.problems,
  };
}
