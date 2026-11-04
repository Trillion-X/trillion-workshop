import {
  dispatchPlaceableSurfaceCompletion,
} from '../../ui/show/placeable-surface-intent/surface-completion-target';

type Dispatch = (request: {
  target: string;
  payload: Record<string, unknown>;
}) => Promise<unknown>;

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

/** The auto-transcription trigger uses `auto:<recorded-file-id>` as its
 * request id. Audio Transcription owns the durable result at this exact
 * address, so the evidence answer can point at the future result without
 * copying media or transcript text into the form package. */
export function automaticTranscriptResultRef(recordedFileId: unknown): string {
  return `package::audio-transcription::result::auto:${requiredIdentifier(recordedFileId, 'Recorded file id')}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function durableReference(value: unknown, label: string): string | Record<string, unknown> {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const row = record(value);
  if (!row || Object.keys(row).length === 0) throw new Error(`${label} is invalid.`);
  return row;
}

export function recordAudioEvidenceResult(input: {
  sourceRef: unknown;
  transcriptRef?: unknown;
}): Record<string, unknown> {
  const sourceRef = record(input.sourceRef);
  if (!sourceRef || Object.keys(sourceRef).length === 0) {
    throw new Error('Recorded evidence requires a durable source reference.');
  }
  if (input.transcriptRef === undefined) return { source_ref: sourceRef };
  const transcriptRef = durableReference(input.transcriptRef, 'Recorded evidence transcript reference');
  return { source_ref: sourceRef, transcript_ref: transcriptRef };
}

/** Return only durable generic refs; recorded bytes never cross completion. */
export async function completeRecordedEvidence(
  input: {
    completionTarget: unknown;
    sourceRef: unknown;
    recordedFileId?: unknown;
    transcriptRef?: unknown;
  },
  dispatch?: Dispatch,
): Promise<unknown> {
  const transcriptRef = input.transcriptRef === undefined && input.recordedFileId !== undefined
    ? automaticTranscriptResultRef(input.recordedFileId)
    : input.transcriptRef;
  return dispatchPlaceableSurfaceCompletion(
    input.completionTarget,
    recordAudioEvidenceResult({ sourceRef: input.sourceRef, transcriptRef }),
    dispatch,
  );
}
