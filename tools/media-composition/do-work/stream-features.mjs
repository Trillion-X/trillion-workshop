/**
 * file: tools/media-composition/do-work/stream-features.mjs
 *
 * PURPOSE: The ENCODER of the stream detector (stream-core.mjs): a recording between `from` and `to` as frames of named
 * features at a fixed step, { t (source seconds), sound (positive loudness rise), motion (picture change) }, the same two measures
 * find-action-moments.mjs ranks, each scaled to its own stretch's high percentile so a loud or busy recording is not a different
 * recording. It judges nothing: the core and the heads decide what a frame means.
 *
 * NON-NEGOTIABLE INVARIANTS: 1. Times are source seconds inside [from, to]. 2. A recording with no sound gives sound 0 on every frame,
 * never a made-up value. 3. Nothing here names an event or a sport.
 */
import { frameEnergyFlux } from './beat-onset-picker.mjs';
import { HOP, SAMPLE_RATE, audioSamples, motionSeries, probe } from './find-action-moments.mjs';

const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};

/** Frames [{ t, sound, motion }] every `step_s` seconds over [from, to]. */
export function featureFrames(video, { from = 0, to, step_s = 0.1 } = {}) {
  const { duration, hasAudio } = probe(video);
  const start = Math.max(0, Math.min(Number(from) || 0, duration));
  const end = Math.min(Number.isFinite(Number(to)) && Number(to) > start ? Number(to) : duration, duration);
  const count = Math.max(0, Math.floor((end - start) / step_s));
  const frames = Array.from({ length: count }, (_, at) => ({ t: Math.round((start + at * step_s) * 1000) / 1000, sound: 0, motion: 0 }));
  if (!frames.length) return frames;
  const place = (time, name, value) => {
    const at = Math.floor((time - start) / step_s);
    if (at >= 0 && at < frames.length && value > frames[at][name]) frames[at][name] = value;
  };
  const motion = motionSeries(video, start, end - start);
  const motionScale = percentile(motion.map(point => point.value), 0.95);
  if (motionScale > 0) for (const point of motion) place(point.t, 'motion', Math.min(1, point.value / motionScale));
  if (hasAudio) {
    const { flux } = frameEnergyFlux(audioSamples(video, start, end - start), HOP);
    const values = Array.from(flux);
    const scale = percentile(values, 0.99) || Math.max(0, ...values);
    if (scale > 0) values.forEach((value, at) => place(start + (at * HOP) / SAMPLE_RATE, 'sound', Math.min(1, value / scale)));
  }
  return frames;
}
