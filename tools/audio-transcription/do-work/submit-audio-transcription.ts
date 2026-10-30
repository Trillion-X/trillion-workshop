import {
  createContentMediaWorkId,
  submitWorkflowAction,
  type ContentMediaSourceRef,
} from '@/packages/content-media-evidence/do-work/content-media-work-loop';

const TRANSCRIBE_ACTION_ID = 'action:submit-audio-transcription-request';
export const DEFAULT_AUDIO_TRANSCRIPTION_PROFILE_REF =
  'package::audio-transcription::evidence-work-profile::local-whisper';

export type SubmitAudioTranscriptionRequest = {
  requestId?: string;
  source: ContentMediaSourceRef;
  profileRef?: string;
  outputOptions?: Record<string, unknown>;
  requestedAt?: string;
};

export type AudioTranscriptionWorkflowInput = {
  request_id: string;
  source: ContentMediaSourceRef;
  profile_ref: string;
  output_options: Record<string, unknown>;
  requested_at: string;
};

export function buildAudioTranscriptionInput(
  request: SubmitAudioTranscriptionRequest,
): AudioTranscriptionWorkflowInput {
  const requestId = request.requestId ?? createContentMediaWorkId('audio-transcription');
  return {
    request_id: requestId,
    source: request.source,
    profile_ref: request.profileRef ?? DEFAULT_AUDIO_TRANSCRIPTION_PROFILE_REF,
    output_options: request.outputOptions ?? {
      word_timestamps: true,
      segments: true,
      speaker_diarization: false,
    },
    requested_at: request.requestedAt ?? new Date().toISOString(),
  };
}

export async function submitAudioTranscriptionRequest(
  request: SubmitAudioTranscriptionRequest,
): Promise<AudioTranscriptionWorkflowInput> {
  const input = buildAudioTranscriptionInput(request);
  await submitWorkflowAction({
    definitionId: TRANSCRIBE_ACTION_ID,
    input,
    includeSteps: true,
    includeOutput: true,
  });
  return input;
}
