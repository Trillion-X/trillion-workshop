import { describe, expect, it, vi } from 'vitest';
import {
  automaticTranscriptResultRef,
  completeRecordedEvidence,
  recordAudioEvidenceResult,
} from './evidence-completion';

const completionTarget = {
  target: 'coordination-session.intake-evidence-completion',
  correlation: {
    form_id: 'interaction-match-intake',
    respondent_id: 'person:one',
    draft_id: 'submission:one',
    submission_id: 'submission:one',
    question_id: 'evidence.voice',
  },
};

describe('record audio evidence completion', () => {
  it('returns only source and optional transcript refs', async () => {
    const sourceRef = { role: 'stored-audio', relation_ref: 'relation:audio-one' };
    const transcriptRef = { relation_ref: 'relation:transcript-one' };
    expect(recordAudioEvidenceResult({ sourceRef, transcriptRef })).toEqual({
      source_ref: sourceRef,
      transcript_ref: transcriptRef,
    });
    const dispatch = vi.fn(async (request) => ({ payload: request.payload.result }));
    await completeRecordedEvidence({ completionTarget, sourceRef }, dispatch);
    expect(dispatch).toHaveBeenCalledWith({
      target: completionTarget.target,
      payload: {
        correlation: completionTarget.correlation,
        result: { source_ref: sourceRef },
      },
    });
  });

  it('attaches the exact deterministic auto-transcription result reference', async () => {
    const sourceRef = { role: 'stored-audio', relation_ref: 'relation:audio-one' };
    const recordedFileId = 'recorded-file:one';
    const transcriptRef = 'package::audio-transcription::result::auto:recorded-file:one';
    expect(automaticTranscriptResultRef(recordedFileId)).toBe(transcriptRef);
    const dispatch = vi.fn(async (request) => ({ payload: request.payload.result }));
    await completeRecordedEvidence({ completionTarget, sourceRef, recordedFileId }, dispatch);
    expect(dispatch).toHaveBeenCalledWith({
      target: completionTarget.target,
      payload: {
        correlation: completionTarget.correlation,
        result: { source_ref: sourceRef, transcript_ref: transcriptRef },
      },
    });
  });

  it('fails closed without a durable source ref', () => {
    expect(() => recordAudioEvidenceResult({ sourceRef: null })).toThrow(/source reference/i);
    expect(() => recordAudioEvidenceResult({ sourceRef: {}, transcriptRef: {} })).toThrow(/source reference/i);
    expect(() => automaticTranscriptResultRef('../escape')).toThrow(/invalid/i);
  });
});
