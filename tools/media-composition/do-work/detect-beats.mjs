/**
 * #217 OFFLINE beat detector (the headless twin of detect-scenes.mjs / detect-silence.mjs): extract a mono PCM
 * channel from ANY audio/video FILE via ffmpeg, run the SHARED energy-flux onset picker (beat-onset-picker.mjs),
 * and emit the beat-time list that read-data/beat-sync.ts turns into timeline SPLIT points. This is the
 * autonomous export path (no browser AudioBuffer, no librosa install) so a headless pipeline can cut a montage
 * to the music with zero human review. Same beat-time DATA contract as the browser picker and the librosa
 * producer (L069: third blind source, one contract), so the compositor stays blind to how beats were found.
 *
 * A beat-cut reuses the existing `split` fold primitive (one split per chosen beat), so there is ZERO new render
 * code: this producer only WRITES the beat DATA; beat-sync.ts (everyNth / minGap / phase downsampling) chooses
 * which beats become cuts, and video-compose concatenates the resulting hard-cut segments as it already does.
 */
import { execFileSync } from 'node:child_process';
import { detectBeatsFromChannel } from './beat-onset-picker.mjs';

/** Analysis sample rate for onset detection (mono). Lower is fine and fast; onsets are broadband. */
const ANALYSIS_SR = 22050;

/** Extract the whole file as a mono Float64 PCM channel at ANALYSIS_SR (s16le, normalized to [-1,1]). */
export function extractMonoPcm(file, { sampleRate = ANALYSIS_SR } = {}) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-map', 'a:0?', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  const n = Math.floor(raw.length / 2);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i += 1) s[i] = raw.readInt16LE(i * 2) / 32768;
  return { samples: s, sampleRate };
}

/**
 * Detect beats in a file. Returns { beats:[sec...], count, sampleRate, bpm } where bpm is the median-interval
 * estimate (null if under 2 beats). Options pass straight through to the shared picker.
 */
export function detectBeats(file, opts = {}) {
  const { samples, sampleRate } = extractMonoPcm(file, opts);
  const beats = detectBeatsFromChannel(samples, sampleRate, opts);
  let bpm = null;
  if (beats.length >= 2) {
    const gaps = [];
    for (let i = 1; i < beats.length; i += 1) gaps.push(beats[i] - beats[i - 1]);
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    bpm = med > 0 ? Math.round((60 / med) * 10) / 10 : null;
  }
  return { beats, count: beats.length, sampleRate, bpm };
}

// CLI: node detect-beats.mjs <file> [--hop N] [--threshold-k K] [--min-gap S] [--window-frames N]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('usage: detect-beats.mjs <file> [--hop N] [--threshold-k K] [--min-gap S] [--window-frames N]'); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = Number(rest[i + 1]);
    if (k === '--hop') opt.hop = v;
    else if (k === '--threshold-k') opt.thresholdK = v;
    else if (k === '--min-gap') opt.minGap = v;
    else if (k === '--window-frames') opt.windowFrames = v;
  }
  process.stdout.write(JSON.stringify(detectBeats(file, opt)) + '\n');
}
