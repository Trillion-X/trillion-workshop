// packages/motion-analysis/do-work/process-scripts/match/browser_video_frame_source.mjs
//
// Browser <video> FRAME SOURCE — the cv2 swap for the on-device streaming driver.
// =============================================================================
// The canonical native pipeline decodes with cv2 (`wasb_infer.stream_frames` →
// `cv2.VideoCapture.read()`), which yields BGR uint8 frames (H×W×3). To emit BYTE-IDENTICAL
// perception, the browser must hand the SAME .py leaves the SAME BGR uint8 frames. A browser
// `<video>` + canvas `getImageData` yields RGBA — so this packs it to contiguous **BGR** H×W×3
// (channel-swapped, alpha dropped): the exact cv2 memory layout. Feeding RGB would silently
// diverge every downstream number, so the BGR order is a correctness invariant, not a style choice.
//
// The frame source is GENERIC (L090): it yields opaque `{index, width, height, bgr}` frames and
// knows NOTHING about court/ball/perception. It is the browser peer of `wasb_infer.stream_frames`
// (cv2) — both feed the SAME `wasb_infer.ball_window_stream(frame_iter, cfg)` (the edge-clamped
// 3-prep windowing stays SSOT in Python; this never re-implements it, L093).
//
// Split for testability: the two PURE cores (`packBgrFromImageData`, `frameSampleSchedule`) run
// with plain node (zero DOM); the `createVideoFrameSource` async generator is the thin DOM
// wiring (seek → drawImage → getImageData → pack), browser-runtime-gated.
// =============================================================================

/**
 * Pack a canvas ImageData (RGBA, Uint8ClampedArray) into a contiguous **BGR** H×W×3 Uint8Array —
 * the exact layout cv2 hands the native leaves (so browser perception is byte-identical). Pure.
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} imageData
 * @returns {{width:number, height:number, bgr:Uint8Array}}
 */
export function packBgrFromImageData(imageData) {
  const { width, height, data } = imageData;
  const px = width * height;
  if (data.length < px * 4) throw new Error(`packBgrFromImageData: RGBA buffer too small (${data.length} < ${px * 4})`);
  const bgr = new Uint8Array(px * 3);
  for (let p = 0, o = 0; o < bgr.length; p += 4, o += 3) {
    bgr[o] = data[p + 2];     // B  (from RGBA byte 2)
    bgr[o + 1] = data[p + 1]; // G  (from RGBA byte 1)
    bgr[o + 2] = data[p];     // R  (from RGBA byte 0); alpha (byte 3) dropped
  }
  return { width, height, bgr };
}

/**
 * The video timestamps (seconds) to sample, given fps + an optional frame cap. Pure.
 * Mirrors `stream_frames(video_path, max_frames)`'s "one frame per source frame up to max".
 *
 * @param {{durationSec:number, fps:number, maxFrames?:number}} opts
 * @returns {number[]} timestamps, ascending, length = min(floor(durationSec*fps), maxFrames)
 */
export function frameSampleSchedule({ durationSec, fps, maxFrames = Infinity }) {
  if (!(durationSec > 0) || !(fps > 0)) return [];
  const total = Math.floor(durationSec * fps + 1e-9);
  const n = Math.max(0, Math.min(total, maxFrames));
  const ts = new Array(n);
  for (let i = 0; i < n; i++) ts[i] = i / fps;
  return ts;
}

// Seek a <video> to `t` seconds and resolve once the frame is ready (browser-gated).
function seekVideo(video, t) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(`video seek failed at ${t}s`)); };
    const cleanup = () => { video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError); };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = t;
  });
}

/**
 * Async generator yielding BGR frames from a `<video>`, one at a time (decode-on-demand → O(1)
 * frames). Browser-runtime-gated (needs a real `<video>` + canvas). The caller feeds each yielded
 * frame's `bgr` into the Pyodide `ball_window_stream` frame iterator.
 *
 * @param {HTMLVideoElement} video  a loaded, seekable <video> (readyState >= HAVE_METADATA)
 * @param {{fps?:number, maxFrames?:number, canvas?:any, ctx?:any}} [opts]
 * @yields {{index:number, width:number, height:number, bgr:Uint8Array}}
 */
export async function* createVideoFrameSource(video, opts = {}) {
  const fps = opts.fps ?? 30;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const schedule = frameSampleSchedule({ durationSec: video.duration, fps, maxFrames: opts.maxFrames });
  const canvas = opts.canvas ?? (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : null);
  if (!canvas) throw new Error("createVideoFrameSource: a canvas is required (no OffscreenCanvas available)");
  const ctx = opts.ctx ?? canvas.getContext("2d", { willReadFrequently: true });
  for (let i = 0; i < schedule.length; i++) {
    await seekVideo(video, schedule[i]);
    ctx.drawImage(video, 0, 0, width, height);
    const img = ctx.getImageData(0, 0, width, height);
    yield { index: i, ...packBgrFromImageData(img) };
  }
}
