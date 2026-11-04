// package-set://bitfield-studio/packages/media-composition/do-work/detect-highlights.mjs
/**
 * #98 Auto-highlight energy PRODUCER. Measures the REAL per-window audio loudness of a source video
 * with ffmpeg and emits normalized 0..1 energy segments as DATA. It is a PRODUCER: it only MEASURES
 * (the compositor stays blind). The pure `scoreHighlightWindows` + `highlightDecisions` (read-data/
 * highlight-scorer.ts) then rank the windows and author `remove-span` decisions to trim the long
 * recording down to just the highlights (the same fold op the timeline already uses, L069). Splitting
 * measurement (here, real ffmpeg) from scoring (pure, unit-tested) keeps ONE scorer for producer + UI.
 *
 * Usage: node detect-highlights.mjs <video-path> [windowSeconds=1]
 * Output (stdout, JSON): { segments: [{ start, end, energy }], window_seconds, duration }
 */
import { spawnSync } from 'node:child_process';

const videoPath = process.argv[2];
const windowSeconds = Number.isFinite(Number(process.argv[3])) && Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 1;
if (!videoPath) {
  process.stderr.write('[detect-highlights] usage: node detect-highlights.mjs <video-path> [windowSeconds]\n');
  process.exit(2);
}

// Total duration via ffprobe.
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { encoding: 'utf8' });
const duration = Number((probe.stdout ?? '').trim());
if (!Number.isFinite(duration) || duration <= 0) {
  process.stderr.write('[detect-highlights] could not read duration\n');
  process.exit(1);
}

// astats RMS level (dB, roughly -90..0) per window slice -> normalize to 0..1 energy. Silence maps to 0.
const rmsFloorDb = -60;
const measureWindow = (start, len) => {
  const res = spawnSync('ffmpeg', [
    '-hide_banner', '-ss', String(start), '-t', String(len), '-i', videoPath,
    '-map', '0:a?', '-af', 'astats=measure_perchannel=none:measure_overall=RMS_level', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const m = out.match(/RMS level dB:\s*(-?[0-9.]+|-inf)/i);
  if (!m) return 0; // no audio stream / no measurement -> treat as silent
  const db = m[1].toLowerCase() === '-inf' ? rmsFloorDb : Number(m[1]);
  if (!Number.isFinite(db)) return 0;
  const energy = (db - rmsFloorDb) / (0 - rmsFloorDb); // -60dB -> 0, 0dB -> 1
  return Math.max(0, Math.min(1, Number(energy.toFixed(4))));
};

const segments = [];
for (let t = 0; t < duration - 1e-3; t += windowSeconds) {
  const end = Math.min(t + windowSeconds, duration);
  segments.push({ start: Number(t.toFixed(3)), end: Number(end.toFixed(3)), energy: measureWindow(t, end - t) });
}

process.stdout.write(`${JSON.stringify({ segments, window_seconds: windowSeconds, duration: Number(duration.toFixed(3)) })}\n`);
