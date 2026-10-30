/**
 * #219 Clip-quality / take-selection PRODUCER. Auto-picks the usable takes from a pile of raw footage, so the autonomous pipeline
 * never assembles a montage from blurry, out-of-focus, or badly-exposed clips. It MEASURES two real signals per
 * clip with ffmpeg (a PRODUCER, the compositor stays blind): (1) SHARPNESS = mean edge energy (edgedetect ->
 * signalstats YAVG; a sharp/in-focus clip has strong edges, a soft/blurred one does not) and (2) EXPOSURE =
 * mean luma (signalstats YAVG; too dark or blown-out reads badly). A pure scorer ranks the takes; the caller
 * selects the top N and drops the rest into the timeline (the ranking is DATA, the selection reuses the existing
 * clip-choice, zero new render code, L069). Measurement (impure ffmpeg) is split from scoring (pure, unit-tested)
 * so there is ONE scorer for producer and UI, exactly like detect-highlights.
 *
 * The two metrics are directional and re-encode-robust (edge energy and luma survive the aac/h264 path). A
 * smarter drop-in (a face/pose detector, a NIMA aesthetic model) is a producer emitting the SAME {sharpness,
 * brightness} shape, so ranking stays blind to how quality was measured (L090).
 */
import { spawnSync } from 'node:child_process';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round3 = (n) => Math.round(n * 1000) / 1000;

/** Average all `lavfi.signalstats.YAVG=` values ffmpeg prints for the given -vf chain over sampled frames. */
function meanYavg(file, vf, fps) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `fps=${fps},${vf},signalstats,metadata=print:file=-`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  let sum = 0, n = 0;
  const re = /signalstats\.YAVG=([0-9.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) { sum += Number(m[1]); n += 1; }
  return n ? sum / n : null;
}

/**
 * Measure a clip's quality signals. `sharpness` is the mean edge-map luma (0..255, higher = crisper focus);
 * `brightness` is the mean luma (0..255). Returns nulls if the file has no video frames.
 */
export function measureQuality(file, { fps = 4 } = {}) {
  const brightness = meanYavg(file, 'null', fps);
  const sharpness = meanYavg(file, 'edgedetect=low=0.1:high=0.4', fps);
  return {
    sharpness: sharpness === null ? null : round3(sharpness),
    brightness: brightness === null ? null : round3(brightness),
  };
}

/**
 * Pure quality score from the measured signals: sharpness scaled by an exposure-adequacy factor that peaks at
 * `targetBrightness` and falls to 0 as luma approaches full black / full white (a razor-sharp but pitch-black or
 * blown-out clip is not usable). Higher is better. Zero deps, so producer and UI share ONE scorer.
 */
export function scoreQuality({ sharpness, brightness }, { targetBrightness = 128, exposureWindow = 128 } = {}) {
  if (sharpness === null || sharpness === undefined || brightness === null || brightness === undefined) return 0;
  const exposure = clamp01(1 - Math.abs(brightness - targetBrightness) / exposureWindow);
  return round3(Math.max(0, sharpness) * exposure);
}

/**
 * Rank measured takes best-first by quality score. `takes` is `[{file, sharpness, brightness}]` (or the caller's
 * own ids). Returns `[{...take, score}]` sorted descending, ties broken by sharpness then file for determinism.
 */
export function rankTakes(takes, opts = {}) {
  return takes
    .map((t) => ({ ...t, score: scoreQuality(t, opts) }))
    .sort((a, b) => b.score - a.score || (b.sharpness ?? 0) - (a.sharpness ?? 0) || String(a.file).localeCompare(String(b.file)));
}

/** Convenience: measure every file and return the ranking (best-first). */
export function pickBestTakes(files, opts = {}) {
  const measured = files.map((file) => ({ file, ...measureQuality(file, opts) }));
  return rankTakes(measured, opts);
}

// CLI: node detect-quality.mjs <file...> [--fps N]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const files = [];
  const opt = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--fps') { opt.fps = Number(args[i + 1]); i += 1; }
    else files.push(args[i]);
  }
  if (!files.length) { console.error('usage: detect-quality.mjs <file...> [--fps N]'); process.exit(2); }
  process.stdout.write(JSON.stringify(pickBestTakes(files, opt)) + '\n');
}
