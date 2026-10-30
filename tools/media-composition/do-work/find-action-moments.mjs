/**
 * file: packages/media-composition/do-work/find-action-moments.mjs
 *
 * PURPOSE: Find the moments where the action happens in a recording (a ball struck, a clap, a jump landing) and say
 * WHEN, in source seconds. It is a PRODUCER: it only measures and ranks; cutting, slowing or captioning around a
 * moment is the render's job (video-compose) driven by the times this returns.
 *
 * Two signals, each one ffmpeg pass over only the stretch asked for:
 *   sound   the positive energy flux of the audio (the ONE shared envelope, beat-onset-picker.mjs frameEnergyFlux):
 *           a hit is a sharp rise in loudness, so each local peak of the flux is a candidate moment.
 *   motion  how much the picture changes per frame (`tblend=difference` then `signalstats` YAVG, the same measure
 *           detect-motion.mjs uses), sampled on a small grey copy of the picture.
 * A candidate's strength is led by its sound: strength = sound x (3/4 + 1/4 x motion). Whole-picture motion cannot see a
 * small or distant subject (a player across a court swings inside the picture's own noise), so it only breaks near-ties:
 * a sharp sound while something moves outranks an equally sharp sound in a still picture, but someone walking past the
 * lens never outranks a clearly sharper sound. Measured on a recorded sports rally: multiplying sound by motion ranked a
 * player walking by the camera first and every real stroke below it; sound-led ranking puts the strokes first.
 * A recording without audio is ranked by its motion peaks alone. Nothing here knows what the action is.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Every time returned is in SOURCE seconds and lies inside [from, to] and inside the recording.
 * 2. The video is any address ffmpeg opens (a web address or a file path); nothing here reads a machine path.
 * 3. No guess: a stretch with no measurable sound or motion returns an empty list and `best: null`.
 * 4. Failures name what was wrong and exit non-zero.
 *
 * Usage: node find-action-moments.mjs VIDEO [--from S] [--to S] [--count N] [--min-gap S]
 * Output (stdout, JSON): { duration, from, to, moments: [{ time, strength, sound, motion }], best: { time } | null }
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { frameEnergyFlux } from './beat-onset-picker.mjs';

export const SAMPLE_RATE = 22050;
export const HOP = 256;
const MOTION_FPS = 12;
/** The share of a sound's strength it keeps when nothing moves: motion breaks near-ties and never decides alone. */
const MOTION_FLOOR = 0.75;
const round3 = value => Math.round(value * 1000) / 1000;

export function probe(video) {
  const text = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', video], { encoding: 'utf8' });
  const probed = JSON.parse(text);
  const duration = Number(probed.format?.duration);
  if (!(duration > 0)) throw new Error('The recording has no length ffprobe can read.');
  return { duration, hasAudio: (probed.streams ?? []).some(stream => stream.codec_type === 'audio') };
}

/** The audio of [from, from+length) as mono float samples. */
export function audioSamples(video, from, length) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(length), '-i', video,
    '-map', 'a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const aligned = new Uint8Array(raw.length - (raw.length % 4));
  aligned.set(raw.subarray(0, aligned.length));
  return new Float32Array(aligned.buffer);
}

/** Per-frame picture change over [from, from+length): [{ t (source seconds), value }]. */
export function motionSeries(video, from, length) {
  const ran = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(length), '-i', video, '-an',
    '-vf', `fps=${MOTION_FPS},scale=160:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:file=-`, '-f', 'null', '-'],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (ran.status !== 0) throw new Error(`ffmpeg could not read the picture: ${String(ran.stderr).slice(-300)}`);
  const series = [];
  let time = null;
  for (const line of ran.stdout.split('\n')) {
    const at = /pts_time:([0-9.]+)/.exec(line);
    if (at) { time = Number(at[1]); continue; }
    const value = /signalstats\.YAVG=([0-9.]+)/.exec(line);
    if (value && time !== null) series.push({ t: from + time, value: Number(value[1]) });
  }
  return series;
}

/** Indices of local maxima above `floor`, strongest first, at least `minGap` apart in time. */
export function peaks(values, timeOf, { floor, minGap }) {
  const found = [];
  for (let at = 1; at < values.length - 1; at += 1) {
    if (values[at] > floor && values[at] >= values[at - 1] && values[at] > values[at + 1]) found.push(at);
  }
  found.sort((left, right) => values[right] - values[left]);
  const kept = [];
  for (const at of found) if (kept.every(other => Math.abs(timeOf(other) - timeOf(at)) >= minGap)) kept.push(at);
  return kept;
}

const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};
const meanAndDeviation = values => {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1));
  return { mean, deviation };
};

/** The ranked action moments of one recording between `from` and `to` (source seconds). */
export function findActionMoments(video, { from = 0, to, count = 5, minGap = 1 } = {}) {
  const { duration, hasAudio } = probe(video);
  const start = Math.max(0, Math.min(Number(from) || 0, duration));
  const end = Math.min(Number.isFinite(Number(to)) && Number(to) > start ? Number(to) : duration, duration);
  if (!(end > start)) throw new Error(`The stretch to search must end after it starts; it was ${from} to ${to}.`);
  const motion = motionSeries(video, start, end - start);
  // Motion is scaled by a high percentile, not the single largest frame, so one burst (someone walking past the
  // lens) does not flatten every other moment to nothing.
  const motionScale = percentile(motion.map(point => point.value), 0.95);
  const motionNear = time => {
    const near = motion.filter(point => Math.abs(point.t - time) <= 0.5).map(point => point.value);
    return motionScale > 0 && near.length ? Math.min(1, Math.max(...near) / motionScale) : 0;
  };
  let candidates;
  if (hasAudio) {
    const { flux } = frameEnergyFlux(audioSamples(video, start, end - start), HOP);
    const values = Array.from(flux);
    const fluxPeak = Math.max(0, ...values);
    const { mean, deviation } = meanAndDeviation(values);
    const timeOf = at => start + (at * HOP) / SAMPLE_RATE;
    candidates = fluxPeak > 0
      ? peaks(values, timeOf, { floor: mean + 2 * deviation, minGap }).map(at => {
        const time = timeOf(at);
        const sound = values[at] / fluxPeak;
        const moving = motionNear(time);
        return { time, sound, motion: moving, strength: sound * (MOTION_FLOOR + (1 - MOTION_FLOOR) * moving) };
      })
      : [];
  } else {
    const values = motion.map(point => point.value);
    const { mean, deviation } = meanAndDeviation(values);
    candidates = motionScale > 0
      ? peaks(values, at => motion[at].t, { floor: mean + deviation, minGap })
        .map(at => ({ time: motion[at].t, sound: 0, motion: Math.min(1, values[at] / motionScale), strength: Math.min(1, values[at] / motionScale) }))
      : [];
  }
  const moments = candidates
    .filter(moment => moment.time >= start && moment.time <= end)
    .sort((left, right) => right.strength - left.strength)
    .slice(0, Math.max(1, Math.floor(count)))
    .map(moment => ({ time: round3(moment.time), strength: round3(moment.strength), sound: round3(moment.sound), motion: round3(moment.motion) }));
  return { duration: round3(duration), from: round3(start), to: round3(end), moments, best: moments.length ? { time: moments[0].time } : null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [video, ...rest] = process.argv.slice(2);
  const options = new Map();
  for (let at = 0; at < rest.length; at += 2) options.set(rest[at].replace(/^--/, ''), Number(rest[at + 1]));
  try {
    if (!video) throw new Error('usage: find-action-moments.mjs VIDEO [--from S] [--to S] [--count N] [--min-gap S]');
    process.stdout.write(`${JSON.stringify(findActionMoments(video, {
      from: options.get('from'), to: options.get('to'), count: options.get('count') ?? 5, minGap: options.get('min-gap') ?? 1,
    }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
