// tools/media-composition/do-work/detect-silence.mjs
/**
 * #209 Silence-detect / jump-cut producer (the Descript / AutoPod "remove silence" feature). Runs ffmpeg
 * `silencedetect` over a source's audio and emits, as DATA: the silent intervals AND their complement, the
 * non-silent KEEP spans (source seconds). It is a PRODUCER, exactly like detect-scenes.mjs: it WRITES the
 * span DATA and the compositor stays blind. The caller turns each keep span into a normal TRIMMED segment
 * (`{source, in, out}`), which the existing multi-segment spine renders and concats, so removing silence is
 * PURE DATA (a set of trimmed sub-clips), ZERO new render code (L069 emergence over the trim primitive).
 *
 * Usage: node detect-silence.mjs <video-path> [thresholdDb=-30] [minSilenceSec=0.5] [padSec=0.05]
 * Output (stdout, JSON): { silences:[{start,end}], keep:[{in,out}], duration, threshold_db, min_silence, pad, count }
 *
 * All knobs are DATA and sanitized (clamp + round), so a malformed value can never reach an ffmpeg arg.
 */
import { spawnSync } from 'node:child_process';

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const clamp = (n, lo, hi, d = 0) => { const v = Number.isFinite(Number(n)) ? Number(n) : d; return Math.max(lo, Math.min(hi, v)); };

/** ffprobe a file's audio-or-container duration in seconds. */
export function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = Number(String(r.stdout ?? '').trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Complement of a set of silent intervals over [0, duration] = the KEEP spans. Pure: no I/O. `pad` keeps a
 * little audio around speech (extends each keep span `pad` seconds into the neighbouring silence so word
 * onsets are not clipped). `minKeep` drops keep spans too short to be worth a cut. Overlapping / unsorted
 * silences are merged and clamped, so the output is always a sorted, non-overlapping, in-bounds span list.
 */
export function keepSpansFromSilences(silences, duration, opts = {}) {
  const pad = clamp(opts.pad, 0, 0.5, 0.05);
  const minKeep = clamp(opts.minKeep, 0.001, 10, 0.05);
  const dur = Math.max(0, Number(duration) || 0);
  const sil = (Array.isArray(silences) ? silences : [])
    .map((s) => ({ start: clamp(s?.start, 0, dur, 0), end: clamp(s?.end ?? dur, 0, dur, dur) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of sil) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const keep = [];
  let cursor = 0;
  for (const s of merged) {
    const silStart = Math.min(dur, s.start + pad); // keep a little INTO the silence (protect word onset)
    if (silStart - cursor >= minKeep) keep.push({ in: round3(cursor), out: round3(silStart) });
    cursor = Math.max(cursor, s.end - pad);         // resume a little BEFORE the silence ends
  }
  if (dur - cursor >= minKeep) keep.push({ in: round3(cursor), out: round3(dur) });
  return keep;
}

/**
 * Bridge: turn AUDIO-detected silent intervals into the `CleanupSpan` shape that the SHIPPED transcript
 * auto-cleanup path already consumes (read-data/auto-cleanup.ts -> cleanupSpansInAuthorOrder -> remove-span
 * decisions -> the remove-span fold ripples the timeline closed). This gives transcript-FREE one-click silence
 * removal: auto-cleanup's own silence detection needs word records, this path needs only the raw audio. `pad`
 * keeps breathing room at each edge (same meaning as auto-cleanup's silencePad). Reuses the shipped fold, zero
 * new author/render code (L069 - both silence sources converge on the one remove-span primitive).
 */
export function silencesToCleanupSpans(silences, opts = {}) {
  const pad = clamp(opts.pad, 0, 0.5, 0.1);
  return (Array.isArray(silences) ? silences : [])
    .map((s) => ({ start: round3(clamp(s?.start, 0, Infinity, 0) + pad), end: round3(clamp(s?.end, 0, Infinity, 0) - pad), reason: 'silence' }))
    .filter((s) => s.end > s.start);
}

/**
 * Run ffmpeg silencedetect on a source and return its silent intervals + duration. `thresholdDb` (dBFS below
 * which is "silent") and `minSilenceSec` (a gap must be at least this long to count) are sanitized DATA.
 */
export function detectSilence(videoPath, opts = {}) {
  const thresholdDb = clamp(opts.thresholdDb, -90, -10, -30);
  const minSilenceSec = round3(clamp(opts.minSilenceSec, 0.05, 10, 0.5));
  const res = spawnSync('ffmpeg', [
    '-hide_banner', '-i', videoPath,
    '-af', `silencedetect=n=${thresholdDb}dB:d=${minSilenceSec}`,
    '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const txt = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const duration = probeDuration(videoPath);
  const silences = [];
  let curStart = null;
  for (const line of txt.split('\n')) {
    const ms = line.match(/silence_start:\s*(-?[0-9.]+)/);
    if (ms) { curStart = Math.max(0, Number(ms[1])); continue; }
    const me = line.match(/silence_end:\s*(-?[0-9.]+)/);
    if (me && curStart != null) { silences.push({ start: round3(curStart), end: round3(Number(me[1])) }); curStart = null; }
  }
  if (curStart != null && duration > curStart) silences.push({ start: round3(curStart), end: round3(duration) }); // silence to EOF
  return { silences, duration, thresholdDb, minSilenceSec };
}

// CLI: emit the silence intervals + keep spans as DATA for a caller to build a silence-removed EDL.
if (import.meta.url === `file://${process.argv[1]}`) {
  const videoPath = process.argv[2];
  if (!videoPath) { process.stderr.write('[detect-silence] usage: node detect-silence.mjs <video-path> [thresholdDb] [minSilenceSec] [padSec]\n'); process.exit(2); }
  const thresholdDb = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
  const minSilenceSec = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
  const pad = process.argv[5] !== undefined ? Number(process.argv[5]) : undefined;
  const { silences, duration, thresholdDb: thr, minSilenceSec: minSil } = detectSilence(videoPath, { thresholdDb, minSilenceSec });
  const keep = keepSpansFromSilences(silences, duration, { pad });
  process.stdout.write(`${JSON.stringify({ silences, keep, duration, threshold_db: thr, min_silence: minSil, pad: clamp(pad, 0, 0.5, 0.05), count: keep.length })}\n`);
}
