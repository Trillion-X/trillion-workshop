// package-set://bitfield-studio/packages/media-composition/do-work/detect-scenes-browser.ts
/**
 * #97 Scene-detect (browser): the client-side twin of the ffmpeg `detect-scenes.mjs` producer, in the
 * SAME shape as `detectBeatsFromChannel` (#71). A PURE core detector over raw per-frame data, plus a
 * thin browser shell that gathers that data from a <video> element via a canvas. The pure core is
 * offline-unit-testable; the shell is browser-only. A detected cut becomes a `split` edit-decision
 * (the fold op the timeline already has), so a long recording auto-segments into shots (L069).
 */

/** A per-frame signature: a small fixed-length vector (e.g. a downsampled luma grid) whose distance to
 *  the previous frame's signature spikes at a hard cut. */
export type FrameSignature = number[];

export interface SceneDetectOptions {
  /** Cut when the normalized 0..1 inter-frame distance exceeds this (higher = fewer/harder cuts). */
  threshold?: number;
  /** Minimum seconds between cuts (debounce, so one hard cut is not double-counted). */
  minGap?: number;
}

/**
 * PURE scene-cut detector. Given per-frame signatures sampled at `fps` (one entry per sampled frame,
 * in order), return the times (seconds) where the frame changes hard. The distance is the mean
 * absolute per-component difference normalized to 0..1 (signatures are assumed 0..255 per component);
 * a distance over `threshold` is a cut. The first frame is never a cut. Deterministic, no I/O.
 */
export function detectCutsFromFrameSignatures(
  signatures: FrameSignature[],
  fps: number,
  opts: SceneDetectOptions = {},
): number[] {
  const threshold = Number.isFinite(opts.threshold) ? (opts.threshold as number) : 0.3;
  const minGap = Number.isFinite(opts.minGap) ? (opts.minGap as number) : 0.2;
  const rate = fps > 0 ? fps : 24;
  const cuts: number[] = [];
  let lastCut = -Infinity;
  for (let i = 1; i < signatures.length; i += 1) {
    const a = signatures[i - 1];
    const b = signatures[i];
    const n = Math.min(a.length, b.length);
    if (n === 0) continue;
    let sum = 0;
    for (let k = 0; k < n; k += 1) sum += Math.abs(a[k] - b[k]);
    const dist = sum / n / 255; // normalize per-component 0..255 to 0..1
    const t = i / rate;
    if (dist > threshold && t - lastCut >= minGap) {
      cuts.push(Number(t.toFixed(3)));
      lastCut = t;
    }
  }
  return cuts;
}

/** Convert detected cut times into `split` edit-decisions for a given source, in order. Each split is
 *  the exact DATA the `split` fold op consumes (`parameters.time` plus the source ref). Pure. */
export function splitDecisionsFromCuts(
  cuts: number[],
  sourceRef: Record<string, unknown>,
  createdAt: string,
): Array<{ action: 'split'; label: string; source_ref: Record<string, unknown>; created_at: string; parameters: { time: number } }> {
  return cuts
    .filter((t) => Number.isFinite(t) && t > 0)
    .map((t) => ({
      action: 'split' as const,
      label: `Scene cut ${t.toFixed(2)}s`,
      source_ref: sourceRef,
      created_at: createdAt,
      parameters: { time: Number(t) },
    }));
}

/**
 * Browser shell: sample a <video> element's frames to a small canvas and build per-frame signatures,
 * then run the pure detector. Browser-only (uses document/canvas); not unit-tested. `stepMs` is the
 * sampling interval; `grid` is the signature grid size (grid x grid luma cells).
 */
export async function detectScenesFromVideo(
  video: HTMLVideoElement,
  opts: SceneDetectOptions & { stepMs?: number; grid?: number } = {},
): Promise<number[]> {
  const stepMs = Number.isFinite(opts.stepMs) ? (opts.stepMs as number) : 100;
  const grid = Number.isFinite(opts.grid) ? (opts.grid as number) : 8;
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const canvas = document.createElement('canvas');
  canvas.width = grid; canvas.height = grid;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const signatures: FrameSignature[] = [];
  const seekTo = (t: number) => new Promise<void>((resolve) => {
    const on = () => { video.removeEventListener('seeked', on); resolve(); };
    video.addEventListener('seeked', on);
    video.currentTime = Math.min(t, duration - 0.001);
  });
  for (let t = 0; t < duration; t += stepMs / 1000) {
    await seekTo(t);
    ctx.drawImage(video, 0, 0, grid, grid);
    const { data } = ctx.getImageData(0, 0, grid, grid);
    const sig: number[] = [];
    // RGB per cell (not luma-only) so a hard cut between similar-brightness colors still triggers.
    for (let p = 0; p < data.length; p += 4) { sig.push(data[p], data[p + 1], data[p + 2]); }
    signatures.push(sig);
  }
  const effFps = 1000 / stepMs;
  return detectCutsFromFrameSignatures(signatures, effFps, opts);
}
