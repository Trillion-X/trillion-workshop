import {
  submitWorkflowAction,
  type ContentMediaSourceRef,
} from '@/packages/content-media-evidence/do-work/content-media-work-loop';

export const WRITE_MEDIA_COMPOSITION_RECORD_ACTION_ID = 'action:write-media-composition-record';

export type MediaCompositionRecord = {
  address: string;
  path: readonly string[];
  payload: Record<string, unknown>;
};

export type WriteMediaCompositionRecordInput = {
  record: MediaCompositionRecord;
};

export type BuildEditDecisionInput = {
  decisionId?: string;
  action: string;
  label: string;
  sourceRef?: ContentMediaSourceRef | Record<string, unknown>;
  span?: { start?: number; end?: number };
  parameters?: Record<string, unknown>;
  createdAt?: string;
};

export type BuildMarkerInput = {
  markerId?: string;
  label: string;
  sourceRef?: ContentMediaSourceRef | Record<string, unknown>;
  time?: number;
  span?: { start?: number; end?: number };
  createdAt?: string;
};

export type BuildSelectionInput = {
  selectionId?: string;
  intentId?: string;
  compositionRunId?: string;
  sourceRef: ContentMediaSourceRef | Record<string, unknown>;
  span?: { start?: number; end?: number };
  evidenceRefs?: readonly Record<string, unknown>[];
  selectionProfileRef?: Record<string, unknown>;
  createdAt?: string;
};

// Media-composition records live on their own published lane so the maintained
// projection producer (`record_from_matching_records` matching this exact path)
// aggregates ONLY media-composition records — never the whole app's published
// records — and the producer edge fires only on media-composition writes.
const PUBLISHED_PATH = ['media-composition', 'content-media-evidence'] as const;

function safeAddressSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return segment || 'record';
}

export function createMediaCompositionRecordId(prefix: string): string {
  return `${safeAddressSegment(prefix)}:${crypto.randomUUID()}`;
}

export function mediaCompositionRecordAddress(kind: string, id: string): string {
  const family = kind.startsWith('media-composition.')
    ? kind.slice('media-composition.'.length)
    : kind;
  return `package::media-composition::${safeAddressSegment(family)}::${safeAddressSegment(id)}`;
}

export function buildMediaCompositionEditDecisionRecord(input: BuildEditDecisionInput): MediaCompositionRecord {
  const decisionId = input.decisionId ?? createMediaCompositionRecordId('edit');
  const payload = {
    kind: 'media-composition.edit-decision',
    role: 'edit_decisions',
    decision_id: decisionId,
    action: input.action,
    label: input.label,
    source_ref: input.sourceRef ?? {},
    span: input.span ?? {},
    parameters: input.parameters ?? {},
    created_at: input.createdAt ?? new Date().toISOString(),
  };
  return {
    address: mediaCompositionRecordAddress('media-composition.edit-decision', decisionId),
    path: PUBLISHED_PATH,
    payload,
  };
}

export function buildMediaCompositionMarkerRecord(input: BuildMarkerInput): MediaCompositionRecord {
  const markerId = input.markerId ?? createMediaCompositionRecordId('marker');
  const payload = {
    kind: 'media-composition.marker',
    role: 'markers',
    marker_id: markerId,
    label: input.label,
    source_ref: input.sourceRef ?? {},
    time: input.time ?? 0,
    span: input.span ?? {},
    created_at: input.createdAt ?? new Date().toISOString(),
  };
  return {
    address: mediaCompositionRecordAddress('media-composition.marker', markerId),
    path: PUBLISHED_PATH,
    payload,
  };
}

export function buildMediaCompositionSelectionRecord(input: BuildSelectionInput): MediaCompositionRecord {
  const selectionId = input.selectionId ?? createMediaCompositionRecordId('selection');
  const payload = {
    kind: 'media-composition.selection',
    role: 'selections',
    selection_id: selectionId,
    intent_id: input.intentId ?? 'manual-select-source',
    composition_run_id: input.compositionRunId ?? 'local-media-workspace',
    source_ref: input.sourceRef,
    selected_source_ref: input.sourceRef,
    source_span_refs: [
      {
        source_ref: input.sourceRef,
        span: input.span ?? {},
      },
    ],
    evidence_refs: input.evidenceRefs ?? [],
    selection_profile_ref: input.selectionProfileRef ?? {
      kind: 'selected-source',
      source_ref: input.sourceRef,
    },
    created_at: input.createdAt ?? new Date().toISOString(),
  };
  return {
    address: mediaCompositionRecordAddress('media-composition.selection', selectionId),
    path: PUBLISHED_PATH,
    payload,
  };
}

export async function writeMediaCompositionRecord(
  input: WriteMediaCompositionRecordInput,
): Promise<unknown> {
  return submitWorkflowAction({
    definitionId: WRITE_MEDIA_COMPOSITION_RECORD_ACTION_ID,
    input,
    includeSteps: true,
    includeOutput: true,
  });
}
