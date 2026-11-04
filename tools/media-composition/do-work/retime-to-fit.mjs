// package-set://bitfield-studio/packages/media-composition/do-work/retime-to-fit.mjs
/**
 * #214 Retime-to-fit producer (fit a clip to an EXACT target duration). The TIME-dimension counterpart to
 * color-match (#211) and auto-crop (#212) for autonomous multi-source assembly: to drop a clip into a fixed
 * slot (a music beat, a template gap, a fixed-length reel cell) it must be exactly that long. This measures the
 * source duration and emits the constant SPEED factor that makes it fit (speed = srcDur / targetDur; > 1 speeds
 * up / shortens, < 1 slows down / lengthens). The caller sets it as the clip's `speed`, which video-compose
 * already applies (setpts + atempo), so retime-to-fit rides the EXISTING speed primitive with zero new render
 * code (L069). Producer pattern (like detect-silence / color-match / detect-crop).
 *
 * Usage: node retime-to-fit.mjs <video-path> <target-seconds> [minSpeed=0.25] [maxSpeed=8]
 * Output (stdout, JSON): { speed, achievable, requestedSpeed, sourceDuration, targetDuration }
 * `achievable` is false when the exact fit would need a speed outside [minSpeed,maxSpeed] (clamped); the caller
 * then knows the clip can't fully fill / fit the slot at an acceptable speed and can pad / trim instead.
 */
import { spawnSync } from 'node:child_process';

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const clamp = (n, lo, hi, d = 0) => { const v = Number.isFinite(Number(n)) ? Number(n) : d; return Math.max(lo, Math.min(hi, v)); };

/** ffprobe a file's duration in seconds (0 when unknown). */
export function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = Number(String(r.stdout ?? '').trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Pure: the constant speed factor that maps `sourceDuration` onto `targetDuration`, clamped to a sane range.
 * Returns { speed, achievable, requestedSpeed }. A non-positive source or target is a safe no-op (speed 1).
 */
export function speedToFitDuration(sourceDuration, targetDuration, opts = {}) {
  const min = clamp(opts.minSpeed, 0.01, 100, 0.25);
  const max = clamp(opts.maxSpeed, min, 100, 8);
  const src = Number(sourceDuration) || 0;
  const tgt = Number(targetDuration) || 0;
  if (src <= 0 || tgt <= 0) return { speed: 1, achievable: false, requestedSpeed: 1 };
  const requested = src / tgt;
  const speed = clamp(requested, min, max, 1);
  return { speed: round3(speed), achievable: speed === round3(requested) || Math.abs(speed - requested) < 1e-9, requestedSpeed: round3(requested) };
}

/** Measure the source and emit the fit result. */
export function fitToDuration(file, targetDuration, opts = {}) {
  const sourceDuration = probeDuration(file);
  const r = speedToFitDuration(sourceDuration, targetDuration, opts);
  return { ...r, sourceDuration: round3(sourceDuration), targetDuration: round3(Number(targetDuration) || 0) };
}

// CLI: measure the clip and emit the speed factor to set as the clip's `speed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const target = Number(process.argv[3]);
  if (!file || !Number.isFinite(target)) { process.stderr.write('[retime-to-fit] usage: node retime-to-fit.mjs <video-path> <target-seconds> [minSpeed] [maxSpeed]\n'); process.exit(2); }
  const minSpeed = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
  const maxSpeed = process.argv[5] !== undefined ? Number(process.argv[5]) : undefined;
  process.stdout.write(`${JSON.stringify(fitToDuration(file, target, { minSpeed, maxSpeed }))}\n`);
}
