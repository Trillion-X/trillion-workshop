// package-set://bitfield-studio/packages/media-composition/do-work/detect-track-browser.ts
/**
 * #101 Motion tracking (browser): the client-side twin of the ffmpeg `detect-track.mjs` producer, in
 * the SAME shape as the #97 scene-detect pair. A PURE core that finds the subject centroid in a frame
 * (a normalized 0..1 point = the brightness-weighted center of the frame's high-luma pixels), plus a
 * thin browser shell that samples a <video> to a grid canvas and builds the per-frame track. A tracked
 * path `[{t,x,y}]` becomes an overlay's `track` binding, so a label/emoji/blur FOLLOWS the subject via
 * the SAME piecewise position expression the render already uses (L069, zero new render primitive).
 */

/** A per-frame signature: a grid of luma cells (0..255), row-major, gridW x gridH. */
export type LumaGrid = number[];

export interface TrackOptions {
  /** Cells dimmer than this 0..255 are ignored (isolate the bright subject from a dark background). */
  threshold?: number;
}

/**
 * PURE. The subject centroid in a single luma grid: the brightness-weighted mean position of all cells
 * above `threshold`, returned as a normalized 0..1 {x,y}. When no cell passes, returns the frame center
 * {0.5,0.5}. Deterministic, no I/O. Works for any high-contrast subject (a face lit against a backdrop,
 * a ball, a bright object); WHERE a smarter detector's grid comes from is the producer's concern.
 */
export function centroidFromLumaGrid(
  grid: LumaGrid,
  gridW: number,
  gridH: number,
  opts: TrackOptions = {},
): { x: number; y: number } {
  const threshold = Number.isFinite(opts.threshold) ? (opts.threshold as number) : 128;
  let sw = 0; let sx = 0; let sy = 0;
  for (let r = 0; r < gridH; r += 1) {
    for (let c = 0; c < gridW; c += 1) {
      const v = grid[r * gridW + c];
      if (!Number.isFinite(v) || v < threshold) continue;
      const w = v - threshold;
      sw += w;
      sx += w * (c + 0.5);
      sy += w * (r + 0.5);
    }
  }
  if (sw <= 0) return { x: 0.5, y: 0.5 };
  return { x: Number((sx / sw / gridW).toFixed(4)), y: Number((sy / sw / gridH).toFixed(4)) };
}

/** PURE. Turn a sequence of per-frame luma grids (sampled at `fps`) into a subject track `[{t,x,y}]`. */
export function trackFromFrameGrids(
  grids: LumaGrid[],
  gridW: number,
  gridH: number,
  fps: number,
  opts: TrackOptions = {},
): Array<{ t: number; x: number; y: number }> {
  const rate = fps > 0 ? fps : 24;
  return grids.map((g, i) => {
    const c = centroidFromLumaGrid(g, gridW, gridH, opts);
    return { t: Number((i / rate).toFixed(3)), x: c.x, y: c.y };
  });
}

/**
 * Browser shell: sample a <video> element's frames to a small grid canvas, build luma grids, and run
 * the pure tracker. Browser-only (uses document/canvas); not unit-tested. `stepMs` is the sample
 * interval; `grid` the tracking grid size (grid x grid luma cells).
 */
export async function trackSubjectFromVideo(
  video: HTMLVideoElement,
  opts: TrackOptions & { stepMs?: number; grid?: number } = {},
): Promise<Array<{ t: number; x: number; y: number }>> {
  const stepMs = Number.isFinite(opts.stepMs) ? (opts.stepMs as number) : 150;
  const grid = Number.isFinite(opts.grid) ? (opts.grid as number) : 16;
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const canvas = document.createElement('canvas');
  canvas.width = grid; canvas.height = grid;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const grids: LumaGrid[] = [];
  const seekTo = (t: number) => new Promise<void>((resolve) => {
    const on = () => { video.removeEventListener('seeked', on); resolve(); };
    video.addEventListener('seeked', on);
    video.currentTime = Math.min(t, duration - 0.001);
  });
  for (let t = 0; t < duration; t += stepMs / 1000) {
    await seekTo(t);
    ctx.drawImage(video, 0, 0, grid, grid);
    const { data } = ctx.getImageData(0, 0, grid, grid);
    const lg: number[] = [];
    for (let p = 0; p < data.length; p += 4) {
      // Rec.601 luma from RGB.
      lg.push(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
    }
    grids.push(lg);
  }
  const effFps = 1000 / stepMs;
  return trackFromFrameGrids(grids, grid, grid, effFps, opts);
}
