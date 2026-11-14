import { describe, expect, it } from 'vitest';
import {
  decodeRecordingSession,
  reachedScriptCompletion,
} from './recording-session';

describe('recording session DATA', () => {
  it('decodes final-word stopping without imposing a fallback duration', () => {
    const session = decodeRecordingSession({
      session_id: 'presentation-plan:test',
      sentences: ['First sentence.', 'Final sentence.'],
      capture_mode: 'video',
      auto_start: false,
      countdown_seconds: 0,
      auto_stop_seconds: 0,
      stop_on_final_word: true,
      completion_grace_ms: 250,
      silence_stop_seconds: 3,
      silence_threshold_rms: 0.015,
      minimum_speech_ms: 900,
      completion_reason_refs: {
        manual: 'reason:manual-data',
        speech: 'reason:speech-data',
        silence: 'reason:silence-data',
        duration: 'reason:duration-data',
        provider_end: 'reason:end-data',
        provider_error: 'reason:error-data',
        cancel: 'reason:cancel-data',
      },
    });
    expect(session?.autoStopSeconds).toBe(0);
    expect(session?.stopOnFinalWord).toBe(true);
    expect(session?.completionGraceMs).toBe(250);
    expect(session?.silenceStopSeconds).toBe(3);
    expect(session?.silenceThresholdRms).toBe(0.015);
    expect(session?.minimumSpeechMs).toBe(900);
    expect(session?.completionReasonRefs.manual).toBe('reason:manual-data');
    expect(session?.completionReasonRefs.providerEnd).toBe('reason:end-data');
    expect(reachedScriptCompletion(session!, session!.words.length - 1)).toBe(false);
    expect(reachedScriptCompletion(session!, session!.words.length)).toBe(true);
  });

  it('does not claim completion when final-word stopping is not requested', () => {
    const session = decodeRecordingSession({
      sentences: ['One sentence.'],
      stop_on_final_word: false,
    });
    expect(reachedScriptCompletion(session!, session!.words.length)).toBe(false);
  });
});
