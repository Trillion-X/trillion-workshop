// packages/motion-analysis/do-work/process-scripts/match/match_stream_driver.mjs
//
// GENERIC streaming perception ORCHESTRATOR — the ONE decode-on-demand loop shared by the
// Node probe and the browser on-device runtime.
// =============================================================================
// The streaming loop (per frame: pull → prep model inputs → run both nets → extract the tiny
// per-frame result → discard the heatmap; after the loop: sequence reductions + emit) was
// inlined in `pyodide_stream_probe.mjs`. That made it probe-only: the browser driver would have
// to re-implement the same loop (a second source of truth). This extracts it as ONE orchestrator
// that owns NO frame decode, NO model, NO python, NO cv2, NO <video> — every capability is
// INJECTED (L090 generic handler). The frame SOURCE lives inside the injected `glue.advance()`
// (cv2 generator in the Node probe; a <video>/MediaRecorder-pushed frame in the browser); the
// model FORWARD is the injected `runCourt`/`runBall` (from the canonical EP seam
// `ort_session.mjs` — WebGPU-preferred). So the SAME orchestration runs in both substrates with
// ZERO divergence (SSOT), and adding the browser is a new frame source + glue, not a new loop.
//
// NON-NEGOTIABLE INVARIANTS:
//   - No substrate knowledge here (L090): the orchestrator names no cv2/onnxruntime/pyodide/
//     <video>/court/ball. It calls opaque capabilities. Swapping Node↔browser changes only the
//     injected glue + runners, never this file (L063 category, L089 one code path).
//   - O(1) heatmaps by construction: exactly one court + one ball forward is alive per iteration;
//     `glue.frameExtract` consumes both and discards them before the next iteration. The loop
//     never accumulates model outputs — only `glue` holds the tiny per-frame results.
//   - Serialized, ordered: one frame at a time, awaited in order (decode-on-demand).
//   - Fully testable with zero pyodide/ort/models: inject a mock glue + spy runners.
// =============================================================================

/**
 * Run the streaming perception loop over an injected substrate.
 *
 * @param {object} caps
 * @param {object} caps.glue  the substrate capabilities (all async-or-sync):
 *   - advance(): truthy if a frame was produced (pulls/stages the next raw frame), falsy at end.
 *   - frameInputs(): [courtInputBytes, ballInputBytes] for the CURRENT frame.
 *   - frameExtract(courtOut, ballOut): turn the two model outputs into the tiny per-frame result
 *       and DISCARD the heatmaps.
 *   - reduceEmit(framesProcessed): run the sequence reductions + build_command_output →
 *       {facts, records, summary, ...}. Called once after the loop.
 * @param {(courtInputBytes:any)=>Promise<any>} caps.runCourt  court net forward (EP seam session).
 * @param {(ballInputBytes:any)=>Promise<any>}  caps.runBall   ball net forward (EP seam session).
 * @param {number} [caps.maxFrames]  cap on frames processed (default: until advance() is falsy).
 * @param {(i:number)=>void} [caps.onFrame]  optional progress hook (frame index just finished).
 * @returns {Promise<{framesProcessed:number, result:any}>}
 */
export async function runStreamingPerception(caps = {}) {
  const { glue, runCourt, runBall, onFrame } = caps;
  const maxFrames = caps.maxFrames ?? Infinity;
  if (!glue) throw new Error("runStreamingPerception: glue capability required");
  if (typeof runCourt !== "function" || typeof runBall !== "function")
    throw new Error("runStreamingPerception: runCourt + runBall capabilities required");

  if (typeof glue.setup === "function") await glue.setup();

  let n = 0;
  while (n < maxFrames) {
    const produced = await glue.advance();      // pull/stage next frame (decode-on-demand)
    if (!produced) break;
    const [courtInput, ballInput] = await glue.frameInputs();
    const courtOut = await runCourt(courtInput); // exactly one court forward alive
    const ballOut = await runBall(ballInput);    // exactly one ball forward alive
    await glue.frameExtract(courtOut, ballOut);  // extract tiny result, discard heatmaps
    n++;
    if (typeof onFrame === "function") onFrame(n - 1);
  }

  const result = await glue.reduceEmit(n);       // sequence reductions + emit (once)
  return { framesProcessed: n, result };
}
