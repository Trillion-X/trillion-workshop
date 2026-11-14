import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  MotionSourceAttachmentRecord,
  MotionSourceRecordRef,
} from '../read-data/motion-comparison-factor-types.ts';

export const ATTACH_MOTION_SOURCE_EVIDENCE_ACTION = 'action:motion-comparison.attach-source-evidence';

/**
 * Structural shape of a motion-analysis evidence record this package accepts.
 * Self-describing DATA (L090): motion-comparison reads the discriminator and
 * artifact fields off a generic record and NEVER imports motion-analysis source
 * (package decoupling — packages coordinate through records/Envelopes, not
 * compile-time source imports). Adding a new evidence kind is a new discriminator
 * field in the DATA, not a source change here.
 */
type MotionAnalysisEvidenceRecord = {
  track_id?: string;
  phase_id?: string;
  alignment_id?: string;
  comparison_id?: string;
  kind?: string;
  track_artifact_ref?: MotionSourceRecordRef['artifactRef'];
  transform_artifact_ref?: MotionSourceRecordRef['artifactRef'];
  [key: string]: unknown;
};

export type AttachMotionSourceEvidenceDraft = {
  attachmentId?: string;
  attachedToId: string;
  sourceKind: string;
  sourceRef: string;
  sourceRecord?: MotionSourceRecordRef;
  label?: string;
  capturedAt?: string;
  confidence?: number;
  note?: string;
  createdBy?: string;
  now?: Date;
};

export type AttachMotionAnalysisEvidenceDraft = Omit<
  AttachMotionSourceEvidenceDraft,
  'sourceKind' | 'sourceRef' | 'sourceRecord'
> & {
  record: MotionAnalysisEvidenceRecord;
  evidenceRole?: MotionSourceRecordRef['evidenceRole'];
};

export type AttachMotionSourceEvidenceInput = {
  attachment_id: string;
  source_attachment_record: MotionSourceAttachmentRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function cleanRequired(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} is required`);
  return cleaned;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function cleanConfidence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Source confidence must be between 0 and 1');
  }
  return value;
}

function cleanSourceRecord(record: MotionSourceRecordRef | undefined): MotionSourceRecordRef | undefined {
  if (!record) return undefined;
  return {
    packageName: cleanRequired(record.packageName, 'Source package'),
    recordKind: cleanRequired(record.recordKind, 'Source record kind'),
    recordId: cleanOptional(record.recordId),
    artifactRef: record.artifactRef,
    evidenceRole: record.evidenceRole,
  };
}

export function buildAttachMotionSourceEvidenceInput(
  draft: AttachMotionSourceEvidenceDraft,
): AttachMotionSourceEvidenceInput {
  const attachmentId = draft.attachmentId ?? generatedId('motion-source-attachment');
  return {
    attachment_id: attachmentId,
    source_attachment_record: {
      kind: 'motion-source-attachment',
      attachmentId,
      attachedToId: cleanRequired(draft.attachedToId, 'Attached record id'),
      sourceKind: cleanRequired(draft.sourceKind, 'Source kind'),
      sourceRef: cleanRequired(draft.sourceRef, 'Source reference'),
      sourceRecord: cleanSourceRecord(draft.sourceRecord),
      label: cleanOptional(draft.label),
      capturedAt: cleanOptional(draft.capturedAt),
      confidence: cleanConfidence(draft.confidence),
      note: cleanOptional(draft.note),
      createdBy: draft.createdBy,
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

function recordText(record: MotionAnalysisEvidenceRecord, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function motionAnalysisRecordId(record: MotionAnalysisEvidenceRecord): string {
  const id = recordText(record, 'track_id')
    ?? recordText(record, 'phase_id')
    ?? recordText(record, 'alignment_id')
    ?? recordText(record, 'comparison_id');
  return cleanRequired(id ?? '', 'Motion analysis record id');
}

function motionAnalysisRecordKind(record: MotionAnalysisEvidenceRecord): string {
  if (recordText(record, 'track_id')) return 'motion-analysis.track';
  if (recordText(record, 'phase_id')) return 'motion-analysis.phase';
  if (recordText(record, 'alignment_id')) return 'motion-analysis.alignment';
  if (recordText(record, 'comparison_id')) return 'motion-analysis.comparison';
  return cleanRequired(recordText(record, 'kind') ?? '', 'Motion analysis record kind');
}

function motionAnalysisArtifactRef(record: MotionAnalysisEvidenceRecord): MotionSourceRecordRef['artifactRef'] {
  if ('track_artifact_ref' in record) return record.track_artifact_ref;
  if ('transform_artifact_ref' in record) return record.transform_artifact_ref;
  return undefined;
}

export function buildAttachMotionAnalysisEvidenceInput(
  draft: AttachMotionAnalysisEvidenceDraft,
): AttachMotionSourceEvidenceInput {
  const recordId = motionAnalysisRecordId(draft.record);
  const recordKind = motionAnalysisRecordKind(draft.record);
  return buildAttachMotionSourceEvidenceInput({
    ...draft,
    sourceKind: recordKind,
    sourceRef: recordId,
    sourceRecord: {
      packageName: 'motion-analysis',
      recordKind,
      recordId,
      artifactRef: motionAnalysisArtifactRef(draft.record),
      evidenceRole: draft.evidenceRole,
    },
  });
}

export function attachMotionSourceEvidence(input: AttachMotionSourceEvidenceInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: ATTACH_MOTION_SOURCE_EVIDENCE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
