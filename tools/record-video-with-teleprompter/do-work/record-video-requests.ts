import { sendRequestToBitfieldTarget } from '#workspace-records';

import type { ContentMediaSourceRef } from '../../content-media-evidence/do-work/content-media-work-loop';
import type { LocalPlaybackFileRef } from './recorded-file-store';

export type CaptureDescriptorValue = string;

export type CaptureSourceDescriptor = {
  id: string;
  value: CaptureDescriptorValue;
  sourceDescriptorRef: string;
  materialRole: string;
  defaultMediaType: string;
  fallbackImportMediaType: string;
  labelPrefix: string;
  browserConstraints: MediaStreamConstraints;
};

type BackendActionDescriptor = {
  id: string;
  definitionId: string;
  target: 'slot::workflow';
};

export const RECORD_VIDEO_BACKEND_DESCRIPTOR = {
  id: 'record-action-projection:record-video:media-capture',
  recordIdPrefix: 'media-record',
  captureOptions: {
    video: {
      value: 'video',
      sourceDescriptorRef: 'package::record-video::source-descriptor::browser-video',
      materialRole: 'stored-video',
      defaultMediaType: 'video/webm',
      fallbackImportMediaType: 'video/mp4',
      labelPrefix: 'Video',
      browserConstraints: { audio: true, video: true },
    },
  },
  actions: {
    saveRecordingState: {
      id: 'save-recording-state',
      definitionId: 'action:record-video:save-recording-state',
      target: 'slot::workflow',
    },
    saveCapturedMedia: {
      id: 'save-captured-media',
      definitionId: 'action:record-video:save-recorded-file',
      target: 'slot::workflow',
    },
    saveRecordingError: {
      id: 'save-recording-error',
      definitionId: 'action:record-video:save-recording-error',
      target: 'slot::workflow',
    },
    setRecordingName: {
      id: 'set-recording-name',
      definitionId: 'action:record-video:set-recording-name',
      target: 'slot::workflow',
    },
    setRecordingNotes: {
      id: 'set-recording-notes',
      definitionId: 'action:record-video:set-recording-notes',
      target: 'slot::workflow',
    },
    setRecordingSubtitle: {
      id: 'set-recording-subtitle',
      definitionId: 'action:record-video:set-recording-subtitle',
      target: 'slot::workflow',
    },
    removeRecording: {
      id: 'remove-recording',
      definitionId: 'action:record-video:remove-recording',
      target: 'slot::workflow',
    },
  },
} as const;

export type RecordVideoActionId =
  typeof RECORD_VIDEO_BACKEND_DESCRIPTOR.actions[keyof typeof RECORD_VIDEO_BACKEND_DESCRIPTOR.actions]['definitionId'];

function actionDescriptor(key: keyof typeof RECORD_VIDEO_BACKEND_DESCRIPTOR.actions): BackendActionDescriptor {
  return RECORD_VIDEO_BACKEND_DESCRIPTOR.actions[key];
}

export type RecordingStateInput = {
  recordingId: string;
  mode: CaptureDescriptorValue;
  sourceDescriptorRef?: string;
  state: string;
  observedAt: string;
  completionReason?: string;
};

export type RecordingNameInput = {
  recordedFileId: string;
  label: string;
};

export type RemoveRecordingInput = {
  recordedFileId: string;
};

export type RecordedFileInput = {
  recordingId: string;
  label: string;
  recordedFileId: string;
  mode: CaptureDescriptorValue;
  sourceDescriptorRef?: string;
  materialRole?: string;
  mediaType: string;
  byteLength: number;
  durationMs: number;
  recordedAt: string;
  storedFileRef: LocalPlaybackFileRef;
  sourceRef: ContentMediaSourceRef;
  completionReasonRef?: string;
  completionObservedAt?: string;
  artifactDisposition: string;
};

export type RecordingErrorInput = {
  recordingId: string;
  mode: CaptureDescriptorValue;
  sourceDescriptorRef?: string;
  message: string;
  observedAt: string;
};

export type RecordVideoWorkflowRequest = {
  target: 'slot::workflow';
  payload: {
    operation: 'execute_definition';
    definition_id: RecordVideoActionId;
    include_steps: false;
    include_output: false;
    input: Record<string, unknown>;
  };
};

function workflowRequest(
  descriptor: BackendActionDescriptor,
  input: Record<string, unknown>,
): RecordVideoWorkflowRequest {
  return {
    target: descriptor.target,
    payload: {
      operation: 'execute_definition',
      definition_id: descriptor.definitionId,
      include_steps: false,
      include_output: false,
      input: {
        ...input,
        action_descriptor_id: descriptor.id,
        backend_descriptor_id: RECORD_VIDEO_BACKEND_DESCRIPTOR.id,
      },
    },
  };
}

export function createRecordVideoId(prefix = RECORD_VIDEO_BACKEND_DESCRIPTOR.recordIdPrefix): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function captureSourceDescriptorFor(mode: CaptureDescriptorValue): CaptureSourceDescriptor {
  const descriptors = Object.values(RECORD_VIDEO_BACKEND_DESCRIPTOR.captureOptions);
  const matched = descriptors.find((descriptor) => descriptor.value === mode);
  return (matched ?? descriptors[0]) as CaptureSourceDescriptor;
}

export function buildSaveRecordingStateRequest(input: RecordingStateInput): RecordVideoWorkflowRequest {
  return workflowRequest(actionDescriptor('saveRecordingState'), {
    recording_id: input.recordingId,
    record_id: input.recordingId,
    mode: input.mode,
    capture_kind: input.mode,
    source_descriptor_ref: input.sourceDescriptorRef ?? captureSourceDescriptorFor(input.mode).sourceDescriptorRef,
    state: input.state,
    observed_at: input.observedAt,
    ...(input.completionReason ? { completion_reason: input.completionReason } : {}),
  });
}

export function buildSaveRecordedFileRequest(input: RecordedFileInput): RecordVideoWorkflowRequest {
  return workflowRequest(actionDescriptor('saveCapturedMedia'), {
    recording_id: input.recordingId,
    record_id: input.recordedFileId,
    label: input.label,
    recorded_file_id: input.recordedFileId,
    mode: input.mode,
    capture_kind: input.mode,
    source_descriptor_ref: input.sourceDescriptorRef ?? captureSourceDescriptorFor(input.mode).sourceDescriptorRef,
    material_role: input.materialRole ?? captureSourceDescriptorFor(input.mode).materialRole,
    media_type: input.mediaType,
    byte_length: input.byteLength,
    duration_ms: input.durationMs,
    recorded_at: input.recordedAt,
    stored_file_ref: input.storedFileRef,
    artifact_ref: input.sourceRef.artifact_ref,
    source_ref: input.sourceRef,
    ...(input.completionReasonRef ? { completion_reason_ref: input.completionReasonRef } : {}),
    ...(input.completionObservedAt ? { completion_observed_at: input.completionObservedAt } : {}),
    artifact_disposition: input.artifactDisposition,
  });
}

export function buildSaveRecordingErrorRequest(input: RecordingErrorInput): RecordVideoWorkflowRequest {
  return workflowRequest(actionDescriptor('saveRecordingError'), {
    recording_id: input.recordingId,
    record_id: input.recordingId,
    mode: input.mode,
    capture_kind: input.mode,
    source_descriptor_ref: input.sourceDescriptorRef ?? captureSourceDescriptorFor(input.mode).sourceDescriptorRef,
    message: input.message,
    observed_at: input.observedAt,
  });
}

export async function saveRecordingState(input: RecordingStateInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildSaveRecordingStateRequest(input));
}

export async function saveRecordedFile(input: RecordedFileInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildSaveRecordedFileRequest(input));
}

export async function saveRecordingError(input: RecordingErrorInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildSaveRecordingErrorRequest(input));
}

export function buildSetRecordingNameRequest(input: RecordingNameInput): RecordVideoWorkflowRequest {
  return workflowRequest(actionDescriptor('setRecordingName'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
    label: input.label,
  });
}

export function buildRemoveRecordingRequest(input: RemoveRecordingInput): RecordVideoWorkflowRequest {
  return workflowRequest(actionDescriptor('removeRecording'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
  });
}

export type RecordingNotesInput = {
  recordedFileId: string;
  notes: string;
};

export function buildSetRecordingNotesRequest(input: RecordingNotesInput): RecordVideoWorkflowRequest {
  return workflowRequest(actionDescriptor('setRecordingNotes'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
    notes: input.notes,
  });
}

export async function setRecordingName(input: RecordingNameInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildSetRecordingNameRequest(input));
}

export async function setRecordingNotes(input: RecordingNotesInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildSetRecordingNotesRequest(input));
}

export type RecordingSubtitleInput = {
  recordedFileId: string;
  subtitle: string;
};

export function buildSetRecordingSubtitleRequest(input: RecordingSubtitleInput): RecordVideoWorkflowRequest {
  return workflowRequest(actionDescriptor('setRecordingSubtitle'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
    subtitle: input.subtitle,
  });
}

export async function setRecordingSubtitle(input: RecordingSubtitleInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildSetRecordingSubtitleRequest(input));
}

export async function removeRecording(input: RemoveRecordingInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildRemoveRecordingRequest(input));
}
