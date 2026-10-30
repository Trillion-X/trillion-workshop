/**
 * #224 Poster / thumbnail best-frame PRODUCER. `extract-poster.mjs` extracts a frame at a GIVEN timestamp, but
 * the autonomous pipeline had no way to CHOOSE which frame, so a reel's thumbnail was a blind fixed timestamp
 * (often a blurry, mid-blink, or badly-exposed frame). This scans the clip, scores each sampled frame on the
 * SAME quality signals as take-selection (sharpness + exposure, reusing detect-quality's `scoreQuality`, SSOT),
 * and returns the BEST timestamp to hand to extract-poster. The thumbnail is the single biggest CTR lever on
 * YouTube/IG, so picking a crisp, well-exposed frame matters. PRODUCER only: it returns a timestamp (DATA); the
 * FRAME is cut by the existing extract-poster, so ZERO new render code (L069). A face/smile/aesthetic model is a
 * drop-in that emits a better per-frame score with the same argmax (L090).
 */
import { spawnSync } from 'node:child_process';
import { scoreQuality } from './detect-quality.mjs';

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = Number((r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** YAVG of the single frame at time `t` after the given -vf chain (null if unreadable). */
function frameYavg(file, t, vf) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `${vf},signalstats,metadata=print:file=-`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /signalstats\.YAVG=([0-9.]+)/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Score sampled frames across the clip. Returns `[{t, sharpness, brightness, score}]` (score is detect-quality's
 * pure quality score: sharpness scaled by exposure adequacy). `step` seconds between samples (default ~12 frames
 * across the clip, min 0.25s).
 */
export function scoreFrames(file, opts = {}) {
  const duration = probeDuration(file);
  // A live or incomplete WebM can have readable frames without a duration in
  // its container. Probe a bounded opening window instead of choosing frame 0.
  const unknownTimes = [0, 1, 2, 4, 8, 12];
  const step = Number.isFinite(opts.step) && opts.step > 0 ? opts.step : Math.max(0.25, duration / 12);
  const times = duration > 0
    ? Array.from({ length: Math.ceil(duration / step) }, (_, index) => index * step).filter(t => t < duration - 1e-3)
    : unknownTimes;
  const out = [];
  for (const t of times) {
    const tt = Number(t.toFixed(3));
    const measuredSharpness = frameYavg(file, tt, 'edgedetect=low=0.1:high=0.4');
    const measuredBrightness = frameYavg(file, tt, 'null');
    if (measuredSharpness === null || measuredBrightness === null) continue;
    const sharpness = Number(measuredSharpness.toFixed(3));
    const brightness = Number(measuredBrightness.toFixed(3));
    out.push({ t: tt, sharpness, brightness, score: scoreQuality({ sharpness, brightness }, opts) });
  }
  return out;
}

/**
 * The best poster timestamp: the highest-scoring sampled frame (ties broken by the earliest time for
 * determinism). Returns `{ t, score, sharpness, brightness }`, or `{ t: 0, ... }` for an unreadable clip.
 */
export function bestPosterTime(file, opts = {}) {
  const frames = scoreFrames(file, opts);
  if (frames.length === 0) return { t: 0, score: 0, sharpness: 0, brightness: 0 };
  return frames.reduce((best, f) => (f.score > best.score ? f : best), frames[0]);
}

// CLI: node pick-poster-frame.mjs <file> [--step S]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('usage: pick-poster-frame.mjs <file> [--step S]'); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) { if (rest[i] === '--step') opt.step = Number(rest[i + 1]); }
  process.stdout.write(JSON.stringify(bestPosterTime(file, opt)) + '\n');
}
