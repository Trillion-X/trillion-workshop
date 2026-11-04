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

export const RECORD_AUDIO_BACKEND_DESCRIPTOR = {
  id: 'record-action-projection:record-audio:media-capture',
  recordIdPrefix: 'media-record',
  captureOptions: {
    audio: {
      value: 'audio',
      sourceDescriptorRef: 'package::record-audio::source-descriptor::browser-audio',
      materialRole: 'stored-audio',
      defaultMediaType: 'audio/webm',
      fallbackImportMediaType: 'audio/mpeg',
      labelPrefix: 'Recording',
      browserConstraints: { audio: true, video: false },
    },
  },
  actions: {
    saveRecordingState: {
      id: 'save-recording-state',
      definitionId: 'action:record-audio:save-recording-state',
      target: 'slot::workflow',
    },
    saveCapturedMedia: {
      id: 'save-captured-media',
      definitionId: 'action:record-audio:save-recorded-file',
      target: 'slot::workflow',
    },
    saveRecordingError: {
      id: 'save-recording-error',
      definitionId: 'action:record-audio:save-recording-error',
      target: 'slot::workflow',
    },
    beginRecordingNote: {
      id: 'begin-recording-note',
      definitionId: 'action:record-audio:begin-recording-note',
      target: 'slot::workflow',
    },
    setRecordingName: {
      id: 'set-recording-name',
      definitionId: 'action:record-audio:set-recording-name',
      target: 'slot::workflow',
    },
    setRecordingNotes: {
      id: 'set-recording-notes',
      definitionId: 'action:record-audio:set-recording-notes',
      target: 'slot::workflow',
    },
    setRecordingMeetingContext: {
      id: 'set-recording-meeting-context',
      definitionId: 'action:record-audio:set-recording-meeting-context',
      target: 'slot::workflow',
    },
    clearRecordingMeetingContext: {
      id: 'clear-recording-meeting-context',
      definitionId: 'action:record-audio:clear-recording-meeting-context',
      target: 'slot::workflow',
    },
    setRecordingSubtitle: {
      id: 'set-recording-subtitle',
      definitionId: 'action:record-audio:set-recording-subtitle',
      target: 'slot::workflow',
    },
    removeRecording: {
      id: 'remove-recording',
      definitionId: 'action:record-audio:remove-recording',
      target: 'slot::workflow',
    },
  },
} as const;

export type RecordAudioActionId =
  typeof RECORD_AUDIO_BACKEND_DESCRIPTOR.actions[keyof typeof RECORD_AUDIO_BACKEND_DESCRIPTOR.actions]['definitionId'];

function actionDescriptor(key: keyof typeof RECORD_AUDIO_BACKEND_DESCRIPTOR.actions): BackendActionDescriptor {
  return RECORD_AUDIO_BACKEND_DESCRIPTOR.actions[key];
}

/** Workflow DATA indexes records by record_id; the live recording owner also checks the original file id. */
function recordingIdentityInput(recordedFileId: string) {
  if (!recordedFileId.trim()) throw new TypeError('A recording identity is required.');
  return { record_id: recordedFileId, recorded_file_id: recordedFileId };
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

/** The note a recording has from the moment it starts, before any of its media exists. */
export type BeginRecordingNoteInput = {
  recordedFileId: string;
  label: string;
  mode: CaptureDescriptorValue;
  recordedAt: string;
  meetingEventContext?: import('./meeting-join-recording').MeetingCalendarContext;
  meetingApplicationInputContext?: import('./meeting-application-recording').MeetingApplicationInputContext;
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
  artifactDisposition?: string;
  meetingEventContext?: import('./meeting-join-recording').MeetingCalendarContext;
  meetingApplicationInputContext?: import('./meeting-application-recording').MeetingApplicationInputContext;
};

export type RecordingErrorInput = {
  recordingId: string;
  mode: CaptureDescriptorValue;
  sourceDescriptorRef?: string;
  message: string;
  observedAt: string;
};

export type RecordingMeetingContextChange = {
  recordedFileId: string;
  meetingEventContext: import('./meeting-join-recording').MeetingCalendarContext;
  expectedMeetingContext: import('./meeting-join-recording').MeetingCalendarContext | null;
};

export type RecordAudioWorkflowRequest = {
  target: 'slot::workflow';
  payload: {
    operation: 'execute_definition';
    definition_id: RecordAudioActionId;
    include_steps: false;
    include_output: false;
    input: Record<string, unknown>;
  };
};

function workflowRequest(
  descriptor: BackendActionDescriptor,
  input: Record<string, unknown>,
): RecordAudioWorkflowRequest {
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
        backend_descriptor_id: RECORD_AUDIO_BACKEND_DESCRIPTOR.id,
      },
    },
  };
}

export function createRecordAudioId(prefix = RECORD_AUDIO_BACKEND_DESCRIPTOR.recordIdPrefix): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function captureSourceDescriptorFor(mode: CaptureDescriptorValue): CaptureSourceDescriptor {
  const descriptors = Object.values(RECORD_AUDIO_BACKEND_DESCRIPTOR.captureOptions);
  const matched = descriptors.find((descriptor) => descriptor.value === mode);
  return (matched ?? descriptors[0]) as CaptureSourceDescriptor;
}

export function buildSaveRecordingStateRequest(input: RecordingStateInput): RecordAudioWorkflowRequest {
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

export function buildSaveRecordedFileRequest(input: RecordedFileInput): RecordAudioWorkflowRequest {
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
    ...(input.artifactDisposition ? { artifact_disposition: input.artifactDisposition } : {}),
    ...(input.meetingEventContext ? { meeting_event_context: input.meetingEventContext } : {}),
    ...(input.meetingApplicationInputContext ? { meeting_application_input_context: input.meetingApplicationInputContext } : {}),
  });
}

export function buildSaveRecordingErrorRequest(input: RecordingErrorInput): RecordAudioWorkflowRequest {
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

export function buildSetRecordingMeetingContextRequest(input: RecordingMeetingContextChange): RecordAudioWorkflowRequest {
  return workflowRequest(actionDescriptor('setRecordingMeetingContext'), {
    ...recordingIdentityInput(input.recordedFileId),
    meeting_event_context: input.meetingEventContext,
    expected_meeting_context: input.expectedMeetingContext,
  });
}

export function buildClearRecordingMeetingContextRequest(input: Omit<RecordingMeetingContextChange, 'meetingEventContext'>): RecordAudioWorkflowRequest {
  return workflowRequest(actionDescriptor('clearRecordingMeetingContext'), {
    ...recordingIdentityInput(input.recordedFileId),
    expected_meeting_context: input.expectedMeetingContext,
  });
}

export async function setRecordingMeetingContext(input: RecordingMeetingContextChange): Promise<void> {
  await sendRequestToBitfieldTarget(buildSetRecordingMeetingContextRequest(input));
}

export async function clearRecordingMeetingContext(input: Omit<RecordingMeetingContextChange, 'meetingEventContext'>): Promise<void> {
  await sendRequestToBitfieldTarget(buildClearRecordingMeetingContextRequest(input));
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

export function buildBeginRecordingNoteRequest(input: BeginRecordingNoteInput): RecordAudioWorkflowRequest {
  return workflowRequest(actionDescriptor('beginRecordingNote'), {
    ...recordingIdentityInput(input.recordedFileId),
    label: input.label,
    mode: input.mode,
    recorded_at: input.recordedAt,
    ...(input.meetingEventContext ? { meeting_event_context: input.meetingEventContext } : {}),
    ...(input.meetingApplicationInputContext ? { meeting_application_input_context: input.meetingApplicationInputContext } : {}),
  });
}

export async function beginRecordingNote(input: BeginRecordingNoteInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildBeginRecordingNoteRequest(input));
}

export function buildSetRecordingNameRequest(input: RecordingNameInput): RecordAudioWorkflowRequest {
  return workflowRequest(actionDescriptor('setRecordingName'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
    label: input.label,
  });
}

export function buildRemoveRecordingRequest(input: RemoveRecordingInput): RecordAudioWorkflowRequest {
  return workflowRequest(actionDescriptor('removeRecording'), {
    record_id: input.recordedFileId,
    recorded_file_id: input.recordedFileId,
  });
}

export type RecordingNotesInput = {
  recordedFileId: string;
  notes: string;
};

export function buildSetRecordingNotesRequest(input: RecordingNotesInput): RecordAudioWorkflowRequest {
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

export function buildSetRecordingSubtitleRequest(input: RecordingSubtitleInput): RecordAudioWorkflowRequest {
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
