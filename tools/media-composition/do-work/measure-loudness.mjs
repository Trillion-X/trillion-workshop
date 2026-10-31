/**
 * #223 Loudness QC PRODUCER (publish-readiness gate). The autonomous pipeline posts reels to IG / YouTube, which
 * expect a target integrated loudness (~-14 LUFS) and no true-peak clipping; a reel that is too loud gets turned
 * down by the platform (and sounds worse) and one that clips distorts. This MEASURES a finished file's real
 * integrated loudness (LUFS), loudness range (LRA), and true peak (dBFS) with ffmpeg `ebur128`, and a pure gate
 * decides whether it is publish-ready. It is a PRODUCER: it only MEASURES; the FIX is the existing master
 * loudnorm (#93 `master_loudnorm`), so there is ZERO new render code (L069). Measure (impure ffmpeg) is split
 * from the gate (pure, unit-tested), so the same gate serves the producer and the UI.
 */
import { spawn, spawnSync } from 'node:child_process';

const lastMatch = (text, re) => { let m, last = null; while ((m = re.exec(text)) !== null) last = m[1]; return last; };

/**
 * The ffmpeg arguments that measure one file's loudness (ebur128 with true peak, no output file). `from` and `seconds`
 * measure one stretch of it; `channels` measures it as heard at that channel count (a mono voice heard in stereo is
 * 3 LU louder than its one channel).
 */
export const loudnessArgs = (file, { from, seconds, channels } = {}) => [
  '-hide_banner', '-nostats',
  ...(Number.isFinite(from) && from > 0 ? ['-ss', String(from)] : []),
  ...(Number.isFinite(seconds) && seconds > 0 ? ['-t', String(seconds)] : []),
  '-i', file, '-vn', ...(Number.isInteger(channels) && channels > 0 ? ['-ac', String(channels)] : []),
  '-af', 'ebur128=peak=true', '-f', 'null', '-',
];

/**
 * PURE: read ffmpeg's ebur128 SUMMARY (the last I:/LRA:/Peak: lines) into `{ integrated_lufs, lra_lu,
 * true_peak_dbfs }`; each is a number, or null when -inf / unmeasurable (e.g. silence, no audio).
 */
export function readLoudnessSummary(text) {
  const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
  return {
    integrated_lufs: num(lastMatch(text, /I:\s*(-?[0-9.]+|-inf)\s*LUFS/g)),
    lra_lu: num(lastMatch(text, /LRA:\s*(-?[0-9.]+)\s*LU/g)),
    true_peak_dbfs: num(lastMatch(text, /Peak:\s*(-?[0-9.]+|-inf)\s*dBFS/g)),
  };
}

/** Measure a file's loudness (or one stretch of it, see loudnessArgs), blocking. Returns the `readLoudnessSummary` shape. */
export function measureLoudness(file, stretch = {}) {
  const r = spawnSync('ffmpeg', loudnessArgs(file, stretch), { encoding: 'utf8', maxBuffer: 1 << 26 });
  return readLoudnessSummary(`${r.stdout || ''}${r.stderr || ''}`);
}

/**
 * Measure a file's loudness without blocking the caller's thread. `command` lets a host run ffmpeg under a
 * scheduler (e.g. `['taskpolicy', '-b']` for background I/O on macOS); `signal` stops the measurement.
 * Resolves the `readLoudnessSummary` shape; rejects when ffmpeg cannot start or exits non-zero.
 */
export function measureLoudnessAsync(file, { command = [], signal } = {}) {
  return new Promise((resolve, reject) => {
    const [program, ...prefix] = [...command, 'ffmpeg'];
    const child = spawn(program, [...prefix, ...loudnessArgs(file)], { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let tail = '';
    child.stderr.setEncoding('utf8');
    // The summary is at the very end; keep only the last 64 KB of progress output.
    child.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-65536); });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(readLoudnessSummary(tail)) : reject(new Error(`ffmpeg exited ${code} measuring loudness`))));
  });
}

/**
 * PURE publish-readiness gate. `ok` iff the integrated loudness is within `tolerance` LU of `targetLufs` AND the
 * true peak does not exceed `maxTruePeak` dBFS. Returns `{ ok, reasons:[...] }` naming every failure (too loud /
 * too quiet / clipping / unmeasured), so the caller can decide to re-normalize (bump master_loudnorm) or post.
 */
export function loudnessGate(m, { targetLufs = -14, tolerance = 1, maxTruePeak = -1 } = {}) {
  const reasons = [];
  if (m.integrated_lufs === null || m.integrated_lufs === undefined) reasons.push('loudness-unmeasured');
  else if (m.integrated_lufs > targetLufs + tolerance) reasons.push('too-loud');
  else if (m.integrated_lufs < targetLufs - tolerance) reasons.push('too-quiet');
  if (m.true_peak_dbfs !== null && m.true_peak_dbfs !== undefined && m.true_peak_dbfs > maxTruePeak) reasons.push('true-peak-clipping');
  return { ok: reasons.length === 0, reasons };
}

/** Convenience: measure a file and gate it in one call. */
export function checkPublishLoudness(file, opts = {}) {
  const m = measureLoudness(file);
  return { ...m, ...loudnessGate(m, opts) };
}

// CLI: node measure-loudness.mjs <file> [--target L] [--tolerance T] [--max-peak P]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('usage: measure-loudness.mjs <file> [--target L] [--tolerance T] [--max-peak P]'); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = Number(rest[i + 1]);
    if (k === '--target') opt.targetLufs = v;
    else if (k === '--tolerance') opt.tolerance = v;
    else if (k === '--max-peak') opt.maxTruePeak = v;
  }
  process.stdout.write(JSON.stringify(checkPublishLoudness(file, opt)) + '\n');
}
