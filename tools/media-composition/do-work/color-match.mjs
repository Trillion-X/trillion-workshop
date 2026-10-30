/**
 * #211 Color-match producer (clip-to-clip color consistency). Measures a SOURCE clip's and a REFERENCE clip's
 * per-channel colour distribution and emits the linear transfer that makes the source's colours match the
 * reference (the classic Reinhard mean/std transfer: out = (in - srcMean) * (refStd/srcStd) + refMean, i.e. a
 * per-channel gain+offset). This is the capability that makes footage shot on DIFFERENT cameras / lighting look
 * like ONE coherent video when auto-assembled - essential for the autonomous multi-source edit. It is a
 * PRODUCER (like detect-silence / detect-scenes): it WRITES the transfer as DATA; the transfer is applied as an
 * ordinary `grade` filter (lutrgb), so it rides the EXISTING grade seam with zero new render code (L069).
 *
 * Usage: node color-match.mjs <source-path> <reference-path>
 * Output (stdout, JSON): { transfer:{r:{gain,off},g,b}, grade:"<lutrgb ...>", srcStats, refStats }
 *
 * The emitted `grade` is numeric-only (gains round3, offsets round1, clip(...) bounds), so no measured value can
 * ever malform the ffmpeg filter (injection-safe).
 */
import { spawnSync } from 'node:child_process';

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const clamp = (n, lo, hi, d = 0) => { const v = Number.isFinite(Number(n)) ? Number(n) : d; return Math.max(lo, Math.min(hi, v)); };

/**
 * Measure a clip's per-channel mean + standard deviation (0..255) over one decoded frame at `ss` seconds.
 * Pure w.r.t. its inputs apart from the one ffmpeg decode; returns { r:{mean,std}, g, b }.
 */
export function channelStats(file, opts = {}) {
  const ss = clamp(opts.ss, 0, Infinity, 0);
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file,
    '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28, timeout:30000 });
  const buf = res.stdout ?? Buffer.alloc(0);
  if(res.error||res.status!==0||buf.length<3||buf.length%3!==0)throw new Error('Could not measure a video frame for color matching.');
  const n = Math.floor(buf.length / 3);
  const sum = [0, 0, 0], sumSq = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { const v = buf[i * 3 + c]; sum[c] += v; sumSq[c] += v * v; }
  }
  const stat = (c) => {
    const mean = n > 0 ? sum[c] / n : 0;
    const variance = n > 0 ? Math.max(0, sumSq[c] / n - mean * mean) : 0;
    return { mean: round1(mean), std: round1(Math.sqrt(variance)) };
  };
  return { r: stat(0), g: stat(1), b: stat(2) };
}

/**
 * Pure: the per-channel linear transfer that maps src colour stats onto ref colour stats.
 * gain = refStd / srcStd (clamped so a near-flat source can't explode), off = refMean - srcMean*gain.
 */
export function computeColorTransfer(srcStats, refStats) {
  const chan = (k) => {
    const s = srcStats?.[k] ?? { mean: 0, std: 1 };
    const r = refStats?.[k] ?? { mean: 0, std: 1 };
    const gain = clamp((r.std || 0) / (s.std || 1), 0.2, 5, 1);
    const off = round1((r.mean || 0) - (s.mean || 0) * gain);
    return { gain: round3(gain), off };
  };
  return { r: chan('r'), g: chan('g'), b: chan('b') };
}

/** Pure: render the transfer as an injection-safe lutrgb grade string (per-channel clipped affine). */
export function colorMatchFilter(transfer) {
  const ch = (t) => `clip(val*${round3(t.gain)}${t.off >= 0 ? '+' : ''}${round1(t.off)},0,255)`;
  return `lutrgb=r='${ch(transfer.r)}':g='${ch(transfer.g)}':b='${ch(transfer.b)}'`;
}

// CLI: measure both clips and emit the transfer + ready-to-apply grade as DATA.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, ref] = [process.argv[2], process.argv[3]];
  if (!src || !ref) { process.stderr.write('[color-match] usage: node color-match.mjs <source-path> <reference-path>\n'); process.exit(2); }
  const srcStats = channelStats(src,{ss:process.argv[4]});
  const refStats = channelStats(ref,{ss:process.argv[5]});
  const transfer = computeColorTransfer(srcStats, refStats);
  process.stdout.write(`${JSON.stringify({ transfer, grade: colorMatchFilter(transfer), srcStats, refStats })}\n`);
}
