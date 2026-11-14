// packages/motion-analysis/do-work/process-scripts/match/test_browser_video_frame_source.mjs
//
// Pure-core gate for the browser <video> frame source (browser_video_frame_source.mjs).
// Proves the two DOM-free cores: RGBA→BGR packing (the cv2-parity byte layout) and the frame
// sample schedule. The createVideoFrameSource generator is DOM-gated (needs a real <video>) and
// is exercised in-browser; here we prove the correctness-critical pure pieces with plain node.
//
//   node test_browser_video_frame_source.mjs
// =============================================================================
import { packBgrFromImageData, frameSampleSchedule } from "./browser_video_frame_source.mjs";

let pass = 0, fail = 0;
const T = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

console.log("browser_video_frame_source — pure cores\n");

// --- packBgrFromImageData: the cv2-parity byte layout ---
// 2 pixels RGBA: px0 = R10 G20 B30 A255, px1 = R40 G50 B60 A255
{
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
  const { width, height, bgr } = packBgrFromImageData({ width: 2, height: 1, data: rgba });
  T("output length = w*h*3 (alpha dropped)", bgr.length === 2 * 1 * 3 && width === 2 && height === 1);
  T("pixel 0 packed as B,G,R (30,20,10) — cv2 byte order, not RGB",
    bgr[0] === 30 && bgr[1] === 20 && bgr[2] === 10);
  T("pixel 1 packed as B,G,R (60,50,40)",
    bgr[3] === 60 && bgr[4] === 50 && bgr[5] === 40);
  T("BGR != RGB (channel swap actually happened)", !(bgr[0] === 10 && bgr[2] === 30));
}

// alpha is dropped regardless of its value; only RGB→BGR matters
{
  const rgba = new Uint8ClampedArray([1, 2, 3, 7]);   // alpha 7 must not appear
  const { bgr } = packBgrFromImageData({ width: 1, height: 1, data: rgba });
  T("alpha byte never appears in BGR output", bgr.length === 3 && !Array.from(bgr).includes(7) && bgr[0] === 3 && bgr[2] === 1);
}

// fail-closed on an undersized buffer
{
  let threw = 0;
  try { packBgrFromImageData({ width: 4, height: 4, data: new Uint8ClampedArray(8) }); } catch { threw++; }
  T("fail-closed: throws on RGBA buffer too small for width*height", threw === 1);
}

// larger buffer: every pixel independently swapped (property check over 100 px)
{
  const N = 100;
  const data = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) { data[i * 4] = i % 256; data[i * 4 + 1] = (i * 2) % 256; data[i * 4 + 2] = (i * 3) % 256; data[i * 4 + 3] = 255; }
  const { bgr } = packBgrFromImageData({ width: N, height: 1, data });
  let ok = true;
  for (let i = 0; i < N; i++) {
    if (bgr[i * 3] !== (i * 3) % 256 || bgr[i * 3 + 1] !== (i * 2) % 256 || bgr[i * 3 + 2] !== i % 256) { ok = false; break; }
  }
  T("every pixel independently B,G,R over 100 px", ok);
}

// --- frameSampleSchedule ---
{
  const ts = frameSampleSchedule({ durationSec: 1, fps: 30 });
  T("1s @ 30fps → 30 timestamps, first 0, ascending by 1/fps",
    ts.length === 30 && ts[0] === 0 && Math.abs(ts[1] - 1 / 30) < 1e-12 && ts[29] < 1);
}
{
  const ts = frameSampleSchedule({ durationSec: 10, fps: 30, maxFrames: 12 });
  T("maxFrames caps the schedule (12 of 300)", ts.length === 12);
}
{
  T("zero/invalid duration or fps → empty schedule (fail-closed)",
    frameSampleSchedule({ durationSec: 0, fps: 30 }).length === 0
    && frameSampleSchedule({ durationSec: 5, fps: 0 }).length === 0
    && frameSampleSchedule({ durationSec: NaN, fps: 30 }).length === 0);
}
{
  // matches stream_frames(max_frames) "one per source frame up to max": floor(dur*fps)
  const ts = frameSampleSchedule({ durationSec: 2.5, fps: 24 });
  T("count = floor(durationSec*fps) (2.5s@24 → 60)", ts.length === 60);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
