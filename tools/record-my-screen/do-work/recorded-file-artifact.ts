// packages/screen-recording/do-work/recorded-file-artifact.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Screen recording artifact staging and storage. Mirrors the pattern of
// record-audio/record-video's recorded-file-artifact.ts.
//
// =============================================================================

import {
  stageContentMediaFile,
  type ContentMediaSourceRef,
} from '../../content-media-evidence/do-work/content-media-work-loop';

import type { ScreenCaptureMode } from './screen-recording-requests';

export type ScreenRecordingSourceRef = ContentMediaSourceRef;

export type RecordedFileArtifactInput = {
  recordingId: string;
  mode?: ScreenCaptureMode;
  materialRole?: string;
  mediaType: string;
  displayName?: string;
  recordedAt?: string;
  blob: Blob;
};

export type RecordedFileArtifactWrite = {
  sourceRef: ScreenRecordingSourceRef;
};

export function recordedFileBytesAddressLabel(recordingId: string): string {
  return `package::screen-recording::source-bytes::${recordingId}`;
}

export async function buildRecordedFileArtifactWrite(input: RecordedFileArtifactInput): Promise<RecordedFileArtifactWrite> {
  if (input.blob.size === 0) {
    throw new Error('Recorded file blob must not be empty.');
  }

  const displayName = input.displayName ?? `${input.mode ?? 'screen'} recording ${input.recordedAt ?? new Date().toISOString()}`;
  const bytes = await input.blob.arrayBuffer();
  const file = new File([bytes], displayName, { type: input.mediaType });

  const sourceRef = await stageContentMediaFile({
    packageName: 'screen-recording',
    file,
    sourceId: input.recordingId,
    role: input.materialRole ?? 'stored-screen',
    pathLabels: ['screen-recording', 'source-bytes', input.mode ?? 'screen'],
  });

  return {
    sourceRef,
  };
}

export async function saveRecordedFileArtifact(input: RecordedFileArtifactInput): Promise<{
  sourceRef: ScreenRecordingSourceRef;
}> {
  const write = await buildRecordedFileArtifactWrite(input);
  return {
    sourceRef: write.sourceRef,
  };
}
