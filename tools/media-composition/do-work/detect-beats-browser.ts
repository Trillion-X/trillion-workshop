/**
 * In-browser beat detector: an energy-flux onset picker over decoded PCM samples. This is the
 * live-editing path for beat-synced cuts (the "Cut to beat" button), running on the AudioBuffer
 * the panel already decodes (same path as decode-audio-peaks). The motion-analysis librosa
 * producer (audio.beat.track) is the higher-quality / export path; both emit the same beat-time
 * list that read-data/beat-sync.ts turns into timeline splits, so the compositor stays blind to
 * how the beats were found.
 *
 * Method (deterministic, no deps): frame the mono signal, take per-frame RMS energy, compute the
 * positive energy flux (increase over the previous frame), then pick local maxima that clear an
 * adaptive mean+k*std threshold and respect a minimum inter-beat gap. Percussive material yields
 * clean beats; the adaptive threshold keeps it tempo-agnostic.
 */

// The picker itself is the ONE shared leaf `beat-onset-picker.mjs` (imported by the offline node producer too),
// so the live-edit and offline paths can never diverge. This file is the browser ENTRY (it owns getting PCM off
// the decoded AudioBuffer), re-exporting the identical picker + its option type so the panel's import is unchanged.
export { detectBeatsFromChannel } from './beat-onset-picker.mjs';

export type BeatDetectOptions = {
  /** Analysis hop in samples (default 512). Frame size is 2x hop. */
  hop?: number;
  /** Adaptive threshold = localMean + thresholdK * localStd (default 1.3). */
  thresholdK?: number;
  /** Minimum seconds between accepted beats (default 0.18 ~= 330 BPM ceiling). */
  minGap?: number;
  /** Half-width (in frames) of the adaptive-threshold window (default 16). */
  windowFrames?: number;
};
