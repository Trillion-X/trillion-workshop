/**
 * #221 Visual motion / action PRODUCER (the VISUAL twin of detect-highlights, which measures AUDIO energy).
 * Measures how much the picture CHANGES per window with ffmpeg (`tblend=all_mode=difference` -> `signalstats`
 * YAVG: a difference frame is bright where the image moved, dark where it is still), so the autonomous pipeline
 * can find the ACTION moment in a long clip (the swing, the dunk, the ball contact) and trim to it. It is a
 * PRODUCER: it only MEASURES (the compositor stays blind). Because it emits the SAME `{start,end,energy}` window
 * shape as detect-highlights, the SHIPPED pure scorer (`read-data/highlight-scorer.ts`
 * scoreHighlightWindows / highlightDecisions) ranks the windows and authors the same `remove-span` decisions to
 * trim the recording down to the action, with ZERO new scoring or render code (L069). Splitting measurement
 * (impure ffmpeg, here) from scoring (pure, shared) keeps ONE scorer for the audio and visual producers.
 *
 * `energy` is per-clip max-normalized (the peak-motion window = 1.0), which is what "find the most active moment
 * in THIS clip" wants; an all-static clip yields all-zero. A pose/optical-flow detector is a drop-in producer
 * emitting the SAME window shape (L090).
 */
import { spawnSync } from 'node:child_process';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = Number((r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Mean difference-frame luma (raw motion) over one [start, start+dur) window. */
function rawMotionWindow(file, start, dur) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(dur),
    '-i', file, '-vf', 'tblend=all_mode=difference,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  let sum = 0, n = 0; const re = /signalstats\.YAVG=([0-9.]+)/g; let m;
  while ((m = re.exec(text)) !== null) { sum += Number(m[1]); n += 1; }
  return n ? sum / n : 0;
}

/**
 * Measure per-window visual motion. Returns `{segments:[{start,end,energy}], window_seconds, duration}` where
 * energy is 0..1 (peak-motion window = 1.0), the exact shape highlight-scorer consumes.
 */
export function measureMotion(file, { windowSeconds = 1 } = {}) {
  const duration = probeDuration(file);
  const win = Math.max(0.1, windowSeconds);
  const raw = [];
  for (let t = 0; t < duration - 1e-3; t += win) {
    const end = Math.min(t + win, duration);
    raw.push({ start: Number(t.toFixed(3)), end: Number(end.toFixed(3)), motion: rawMotionWindow(file, t, end - t) });
  }
  const peak = raw.reduce((mx, s) => Math.max(mx, s.motion), 0);
  const segments = raw.map((s) => ({ start: s.start, end: s.end, energy: peak > 0 ? Number(clamp01(s.motion / peak).toFixed(4)) : 0 }));
  return { segments, window_seconds: win, duration: Number(duration.toFixed(3)) };
}

// CLI: node detect-motion.mjs <file> [windowSeconds=1]
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const windowSeconds = Number.isFinite(Number(process.argv[3])) && Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 1;
  if (!file) { console.error('usage: detect-motion.mjs <file> [windowSeconds=1]'); process.exit(2); }
  process.stdout.write(JSON.stringify(measureMotion(file, { windowSeconds })) + '\n');
}
