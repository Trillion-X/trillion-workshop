import { describe, expect, it } from 'vitest';
import { advanceSilenceStop, INITIAL_SILENCE_STOP_STATE, rootMeanSquare } from './silence-stop';

const config = {
  thresholdRms: 0.02,
  minimumSpeechMs: 500,
  requiredSilenceMs: 1_000,
  maximumSampleGapMs: 1_000,
};

describe('silence-after-speech completion', () => {
  it('never treats initial silence as a completed take', () => {
    expect(advanceSilenceStop(INITIAL_SILENCE_STOP_STATE, 0, 5_000, config)).toEqual({
      state: { speechMs: 0, silenceMs: 0, heardSpeech: false, observation: 'unknown' },
      shouldStop: false,
      observation: 'unknown',
    });
  });

  it('does not fabricate silence across scheduler or background gaps', () => {
    const afterSpeech = advanceSilenceStop(INITIAL_SILENCE_STOP_STATE, 0.1, 500, config).state;
    const partialSilence = advanceSilenceStop(afterSpeech, 0, 800, config).state;
    const gap = advanceSilenceStop(partialSilence, 0, 5_000, config);
    expect(gap.observation).toBe('unknown');
    expect(gap.shouldStop).toBe(false);
    expect(gap.state.silenceMs).toBe(0);
    const afterGap = advanceSilenceStop(gap.state, 0, 200, config);
    expect(afterGap.shouldStop).toBe(false);
    expect(afterGap.state.silenceMs).toBe(200);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'resets partial silence when the sample clock delta is not measurable: %s',
    (sampleMs) => {
      const afterSpeech = advanceSilenceStop(INITIAL_SILENCE_STOP_STATE, 0.1, 500, config).state;
      const partialSilence = advanceSilenceStop(afterSpeech, 0, 800, config).state;
      const unknown = advanceSilenceStop(partialSilence, 0, sampleMs, config);
      expect(unknown).toMatchObject({ shouldStop: false, observation: 'unknown', state: { silenceMs: 0 } });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('treats invalid RMS %s as unknown', (rms) => {
    const result = advanceSilenceStop(INITIAL_SILENCE_STOP_STATE, rms, 100, config);
    expect(result.observation).toBe('unknown');
    expect(result.shouldStop).toBe(false);
  });

  it('stops only after enough measured speech and trailing silence', () => {
    const firstSpeech = advanceSilenceStop(INITIAL_SILENCE_STOP_STATE, 0.04, 300, config);
    const enoughSpeech = advanceSilenceStop(firstSpeech.state, 0.03, 250, config);
    const shortPause = advanceSilenceStop(enoughSpeech.state, 0.001, 900, config);
    expect(firstSpeech.shouldStop).toBe(false);
    expect(enoughSpeech.state.heardSpeech).toBe(true);
    expect(shortPause.shouldStop).toBe(false);
    expect(advanceSilenceStop(shortPause.state, 0.001, 100, config).shouldStop).toBe(true);
  });

  it('resets trailing silence when speech resumes', () => {
    const speaking = advanceSilenceStop(INITIAL_SILENCE_STOP_STATE, 0.04, 500, config);
    const pause = advanceSilenceStop(speaking.state, 0, 800, config);
    const resumed = advanceSilenceStop(pause.state, 0.04, 100, config);
    expect(resumed.state.silenceMs).toBe(0);
    expect(resumed.shouldStop).toBe(false);
  });

  it('computes RMS from measured waveform samples', () => {
    expect(rootMeanSquare(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rootMeanSquare(new Float32Array())).toBe(0);
  });
});
