export type SilenceStopConfig = {
  thresholdRms: number;
  minimumSpeechMs: number;
  requiredSilenceMs: number;
  maximumSampleGapMs: number;
};

export type SilenceStopState = {
  speechMs: number;
  silenceMs: number;
  heardSpeech: boolean;
  observation: 'measured' | 'unknown';
};

export const INITIAL_SILENCE_STOP_STATE: SilenceStopState = {
  speechMs: 0,
  silenceMs: 0,
  heardSpeech: false,
  observation: 'unknown',
};

/** Initial room silence never completes a take. Enough measured speech must
 * occur first; resumed speech resets the trailing-silence clock. */
export function advanceSilenceStop(
  current: SilenceStopState,
  rms: number,
  sampleMs: number,
  config: SilenceStopConfig,
): { state: SilenceStopState; shouldStop: boolean; observation: 'measured' | 'unknown' } {
  const maximumGapMs = Math.max(0, config.maximumSampleGapMs);
  const measured = Number.isFinite(sampleMs) && sampleMs > 0
    && maximumGapMs > 0 && sampleMs <= maximumGapMs && Number.isFinite(rms);
  if (!measured) {
    return {
      // Trailing silence must be one contiguous measured interval. A scheduler,
      // sleep/wake, device, or clock gap makes the interval unknowable, so none
      // of the silence measured before the gap may count after it.
      state: { ...current, silenceMs: 0, observation: 'unknown' },
      shouldStop: false,
      observation: 'unknown',
    };
  }
  const elapsedMs = sampleMs;
  const threshold = Number.isFinite(config.thresholdRms) && config.thresholdRms > 0
    ? config.thresholdRms
    : 0;
  const speech = Number.isFinite(rms) && rms >= threshold;
  const speechMs = current.speechMs + (speech ? elapsedMs : 0);
  const heardSpeech = current.heardSpeech || speechMs >= Math.max(0, config.minimumSpeechMs);
  const silenceMs = heardSpeech && !speech ? current.silenceMs + elapsedMs : 0;
  const requiredSilenceMs = Math.max(0, config.requiredSilenceMs);
  return {
    state: { speechMs, silenceMs, heardSpeech, observation: 'measured' },
    shouldStop: heardSpeech && requiredSilenceMs > 0 && silenceMs >= requiredSilenceMs,
    observation: 'measured',
  };
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
