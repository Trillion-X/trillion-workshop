// package-set://bitfield-studio/packages/media-composition/do-work/detect-crop.mjs
/**
 * #212 Auto-crop producer (black-bar / letterbox / pillarbox removal). Runs ffmpeg `cropdetect` over a few
 * frames to find the CONTENT rectangle inside the black borders, and emits it as `{w,h,x,y}` DATA (the exact shape video-compose's `segment.crop` consumes).
 * The caller sets it as the clip's `crop` (video-compose applies `crop=w:h:x:y`, absolute source px), so
 * auto-crop rides the EXISTING geometric-crop seam with zero new render code (L069). Distinct from `letterbox`
 * (which ADDS bars) and `reframe` (aspect retarget) - this REMOVES existing black borders. Producer pattern
 * (like detect-silence / color-match): it WRITES the rect DATA; the compositor stays blind.
 *
 * Usage: node detect-crop.mjs <video-path> [limit=24] [round=2]
 * Output (stdout, JSON): { crop:{w,h,x,y} | null, source:{width,height}, changed }
 * `crop` is null when the detected rect already equals the full frame (nothing to remove) - a safe no-op.
 */
import { spawnSync } from 'node:child_process';

const clampInt = (n, lo, hi, d) => { const v = Math.round(Number.isFinite(Number(n)) ? Number(n) : d); return Math.max(lo, Math.min(hi, v)); };

/** Pure: parse the LAST `crop=w:h:x:y` cropdetect suggestion out of ffmpeg stderr (the settled estimate). */
export function parseCropDetect(text) {
  let last = null;
  for (const m of String(text ?? '').matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
    last = { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
  }
  return last;
}

/** ffprobe the source pixel dimensions. */
export function sourceDimensions(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' });
  const [w, h] = String(r.stdout ?? '').trim().split('x').map(Number);
  return { width: Number.isFinite(w) ? w : 0, height: Number.isFinite(h) ? h : 0 };
}

/**
 * Detect the content crop rect. `limit` (0..255, higher = treats more as black), `round` (crop dims divisible
 * by this even number). Returns { crop:{w,h,x,y}|null, source, changed } - crop is null (no-op) when
 * the content already fills the frame, so applying the result is always safe.
 */
export function detectCrop(file, opts = {}) {
  const limit = clampInt(opts.limit, 0, 255, 24);
  const round = clampInt(opts.round, 2, 16, 2);
  const frames = clampInt(opts.frames, 1, 240, 16);
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', `cropdetect=limit=${limit}:round=${round}:reset=0`, '-frames:v', String(frames), '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const rect = parseCropDetect(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  const source = sourceDimensions(file);
  if (!rect) return { crop: null, source, changed: false };
  const changed = rect.w < source.width || rect.h < source.height || rect.x > 0 || rect.y > 0;
  return { crop: changed ? rect : null, source, changed };
}

// CLI: emit the content crop rect as DATA for a caller to set as the clip's `crop`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { process.stderr.write('[detect-crop] usage: node detect-crop.mjs <video-path> [limit] [round]\n'); process.exit(2); }
  const limit = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
  const round = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
  process.stdout.write(`${JSON.stringify(detectCrop(file, { limit, round }))}\n`);
}
