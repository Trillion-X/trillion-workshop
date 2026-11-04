// packages/screen-recording/do-work/screen-recording-requests.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Workflow action request builders for screen recording. Mirrors
// record-audio/record-video-requests.ts but adapted for screen capture.
// Supports recording modes: screen-only, screen-with-audio.
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';

import type { ContentMediaSourceRef } from '../../content-media-evidence/do-work/content-media-work-loop';
import type { LocalPlaybackFileRef } from './recorded-file-store';

export type ScreenCaptureMode = 'screen' | 'screen-with-audio';

export type ScreenCaptureSourceDescriptor = {
  id: string;
  value: ScreenCaptureMode;
  sourceDescriptorRef: string;
  materialRole: string;
  defaultMediaType: string;
  labelPrefix: string;
  displayName: string;
};

type BackendActionDescriptor = {
  id: string;
  definitionId: string;
  target: 'slot::workflow';
};

export const SCREEN_RECORDING_BACKEND_DESCRIPTOR = {
  id: 'record-action-projection:screen-recording:media-capture',
  recordIdPrefix: 'screen-record',
  captureOptions: {
    screen: {
      value: 'screen' as const,
      sourceDescriptorRef: 'package::screen-recording::source-descriptor::browser-screen',
      materialRole: 'stored-screen',
      defaultMediaType: 'video/webm',
      labelPrefix: 'Screen Recording',
      displayName: 'Screen only',
    },
    screenWithAudio: {
      value: 'screen-with-audio' as const,
      sourceDescriptorRef: 'package::screen-recording::source-descriptor::browser-screen-audio',
      materialRole: 'stored-screen-with-audio',
      defaultMediaType: 'video/webm',
      labelPrefix: 'Screen Recording (with audio)',
      displayName: 'Screen + system audio',
    },
  },
  actions: {
    saveRecordingState: {
      id: 'save-recording-state',
      definitionId: 'action:screen-recording:save-recording-state',
      target: 'slot::workflow',
    },
    saveCapturedMedia: {
      id: 'save-captured-media',
      definitionId: 'action:screen-recording:save-recorded-file',
      target: 'slot::workflow',
    },
    saveRecordingError: {
      id: 'save-recording-error',
      definitionId: 'action:screen-recording:save-recording-error',
      target: 'slot::workflow',
    },
    setRecordingName: {
      id: 'set-recording-name',
      definitionId: 'action:screen-recording:set-recording-name',
      target: 'slot::workflow',
    },
    removeRecording: {
      id: 'remove-recording',
      definitionId: 'action:screen-recording:remove-recording',
      target: 'slot::workflow',
    },
  },
} as const;

export type ScreenRecordingActionId =
  typeof SCREEN_RECORDING_BACKEND_DESCRIPTOR.actions[keyof typeof SCREEN_RECORDING_BACKEND_DESCRIPTOR.actions]['definitionId'];

function actionDescriptor(key: keyof typeof SCREEN_RECORDING_BACKEND_DESCRIPTOR.actions): BackendActionDescriptor {
  return SCREEN_RECORDING_BACKEND_DESCRIPTOR.actions[key];
}

export type RecordingStateInput = {
  recordingId: string;
  mode: ScreenCaptureMode;
  sourceDescriptorRef?: string;
  state: string;
  observedAt: string;
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
  mode: ScreenCaptureMode;
  sourceDescriptorRef?: string;
  materialRole?: string;
  mediaType: string;
  byteLength: number;
  durationMs: number;
  recordedAt: string;
  storedFileRef: LocalPlaybackFileRef;
  sourceRef: ContentMediaSourceRef;
};

export type RecordingErrorInput = {
  recordingId: string;
  mode: ScreenCaptureMode;
  sourceDescriptorRef?: string;
  message: string;
  observedAt: string;
};

export type ScreenRecordingWorkflowRequest = {
  target: 'slot::workflow';
  payload: {
    operation: 'execute_definition';
    definition_id: ScreenRecordingActionId;
    include_steps: false;
    include_output: false;
    input: Record<string, unknown>;
  };
};

function workflowRequest(
  descriptor: BackendActionDescriptor,
  input: Record<string, unknown>,
): ScreenRecordingWorkflowRequest {
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
        backend_descriptor_id: SCREEN_RECORDING_BACKEND_DESCRIPTOR.id,
      },
    },
  };
}

export function createScreenRecordingId(prefix = SCREEN_RECORDING_BACKEND_DESCRIPTOR.recordIdPrefix): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function captureSourceDescriptorFor(mode: ScreenCaptureMode): ScreenCaptureSourceDescriptor {
  const descriptors = Object.values(SCREEN_RECORDING_BACKEND_DESCRIPTOR.captureOptions);
  const matched = descriptors.find((descriptor) => descriptor.value === mode);
  return (matched ?? descriptors[0]) as ScreenCaptureSourceDescriptor;
}

export function buildSaveRecordingStateRequest(input: RecordingStateInput): ScreenRecordingWorkflowRequest {
  return workflowRequest(actionDescriptor('saveRecordingState'), {
    recording_id: input.recordingId,
    record_id: input.recordingId,
    mode: input.mode,
    capture_kind: input.mode,
    source_descriptor_ref: input.sourceDescriptorRef ?? captureSourceDescriptorFor(input.mode).sourceDescriptorRef,
    state: input.state,
    observed_at: input.observedAt,
  });
}

export function buildSaveRecordedFileRequest(input: RecordedFileInput): ScreenRecordingWorkflowRequest {
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
  });
}

export function buildSaveRecordingErrorRequest(input: RecordingErrorInput): ScreenRecordingWorkflowRequest {
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

export function buildSetRecordingNameRequest(input: RecordingNameInput): ScreenRecordingWorkflowRequest {
  return workflowRequest(actionDescriptor('setRecordingName'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
    label: input.label,
  });
}

export async function setRecordingName(input: RecordingNameInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildSetRecordingNameRequest(input));
}

export function buildRemoveRecordingRequest(input: RemoveRecordingInput): ScreenRecordingWorkflowRequest {
  return workflowRequest(actionDescriptor('removeRecording'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
  });
}

export async function removeRecording(input: RemoveRecordingInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildRemoveRecordingRequest(input));
}
