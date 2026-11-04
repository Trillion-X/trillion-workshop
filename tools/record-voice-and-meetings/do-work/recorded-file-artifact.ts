import {
  stageContentMediaFile,
  type ContentMediaSourceRef,
} from '../../content-media-evidence/do-work/content-media-work-loop';

import type { CaptureDescriptorValue } from './record-audio-requests';

export type RecordAudioSourceRef = ContentMediaSourceRef;

export type RecordedFileArtifactInput = {
  recordingId: string;
  recordedFileId: string;
  mode: CaptureDescriptorValue;
  materialRole?: string;
  mediaType: string;
  displayName?: string;
  recordedAt: string;
  bytes: Uint8Array;
};

export type RecordedFileArtifactWrite = {
  sourceRef: RecordAudioSourceRef;
};

export function recordedFileBytesAddressLabel(recordedFileId: string): string {
  return `package::record-audio::source-bytes::${recordedFileId}`;
}

export async function buildRecordedFileArtifactWrite(input: RecordedFileArtifactInput): Promise<RecordedFileArtifactWrite> {
  if (input.bytes.byteLength === 0) {
    throw new Error('Recorded file bytes must not be empty.');
  }

  const displayName = input.displayName ?? `${input.mode} source ${input.recordedAt}`;
  const file = new File([input.bytes.slice()], displayName, { type: input.mediaType });
  const sourceRef = await stageContentMediaFile({
    packageName: 'record-audio',
    file,
    sourceId: input.recordedFileId,
    role: input.materialRole,
    pathLabels: ['record-audio', 'source-bytes', input.mode],
  });
  return {
    sourceRef,
  };
}

export async function saveRecordedFileArtifact(input: RecordedFileArtifactInput): Promise<{
  sourceRef: RecordAudioSourceRef;
}> {
  const write = await buildRecordedFileArtifactWrite(input);
  return {
    sourceRef: write.sourceRef,
  };
}
