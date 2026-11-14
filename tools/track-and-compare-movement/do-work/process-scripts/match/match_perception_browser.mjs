// packages/motion-analysis/do-work/process-scripts/match/match_perception_browser.mjs
//
// The SHIPPABLE browser on-device match-perception DRIVER — the final assembly of the four
// proven seams into the customer flow (customer clip → perceived facts → the already-live
// derivation layer).
// =============================================================================
// Composes (owns no new logic — L093):
//   1. ort_session.createPerceptionSession  — WebGPU-preferred model backend (EP seam)
//   2. browser_video_frame_source.createVideoFrameSource — <video> → BGR frames (cv2 swap)
//   3. match_stream_driver.runStreamingPerception        — the ONE decode-on-demand loop
//   4. publish_perception_records.deliverPerceptionCommandOutput — fact delivery via the
//      EXISTING motion-analysis writer action
// plus the Python leaves via Pyodide (prep_frame / window_preps / ball_stack_from_preps /
// court_onnx.detect_courts / emit_match_facts.build_command_output) — the SAME canonical .py the
// native worker runs, byte-identical.
//
// THE PUSH↔PULL FRAME BRIDGE (Codex-converged, cont.164): the async <video> decode cannot feed
// the sync Python `ball_window_stream` generator, and re-deriving the edge clamp in JS would be a
// third clamp impl (L093). So the GLUE owns O(1) window state (prev/cur/next preps + the current
// raw frame) with a ONE-BEHIND async lag — it decodes frame i+1 BEFORE emitting window i — and
// delegates the edge clamp to the SSOT `wasb_infer.window_preps` (via the injected `py.stageWindow`).
// A missing neighbour at a stream edge is signalled as `null`; `window_preps` clamps it to cur, so
// the first window is (cur,cur,next) and the last is (prev,cur,cur) — byte-identical to the cv2
// pull path. O(1) frames: at most 2 raw + 3 preps alive regardless of clip length. The frame
// source caps the schedule (maxFrames) so the last logical frame gets EOF → next clamps to cur
// (NOT a wrongly-decoded extra frame).
//
// Everything Python/DOM/ort is INJECTED (`py`, `runCourt`, `runBall`, `frameSource`, `dispatch`,
// `makeRecords`) so the glue's lockstep is unit-testable with zero Pyodide/browser/models. The
// real in-browser run (Pyodide + <video> + onnxruntime-web + vendored models) + a browser-vs-cv2
// pixel-parity gate (timestamp-seek vs sequential read) are the terminal in-browser proof.
// =============================================================================
import { createPerceptionSession, configureOrtEnv } from "./ort_session.mjs";
import { runStreamingPerception } from "./match_stream_driver.mjs";
import { deliverPerceptionCommandOutput } from "./publish_perception_records.mjs";
import { createVideoFrameSource } from "./browser_video_frame_source.mjs";

/**
 * Build the streaming glue for the orchestrator from a frame source + injected Python ops.
 * Implements the one-behind async lag (decode i+1 before emitting window i), O(1) frames.
 *
 * @param {object} caps
 * @param {AsyncIterable<{index,width,height,bgr}>|AsyncIterator} caps.frameSource
 * @param {object} caps.py  injected Python-backed ops (real: Pyodide runPython; test: mock):
 *   - prepFrame(frame): prep the BGR frame (wasb_infer.prep_frame) → an opaque prep token
 *   - stageWindow(prevPrep|null, curPrep, nextPrep|null, curRawFrame): apply wasb_infer.window_preps
 *       to (prev,cur,next) and stash the window + the raw current frame for this step
 *   - frameInputs(): [courtInputBytes, ballInputBytes] for the staged window
 *   - frameExtract(courtOut, ballOut): extract the tiny per-frame result, discard heatmaps
 *   - reduceEmit(): sequence reductions + build_command_output → {facts,records,summary}
 * @returns {{advance, frameInputs, frameExtract, reduceEmit, liveHandles:()=>number}}
 */
export function makeVideoStreamGlue({ frameSource, py }) {
  if (!frameSource) throw new Error("makeVideoStreamGlue: frameSource required");
  if (!py || typeof py.prepFrame !== "function" || typeof py.stageWindow !== "function")
    throw new Error("makeVideoStreamGlue: py.prepFrame + py.stageWindow required");
  const it = typeof frameSource.next === "function"
    ? frameSource
    : frameSource[Symbol.asyncIterator]();

  let started = false;
  let sawLast = false;                 // true once we've decoded EOF for the frame just emitted
  let prevPrep = null, curPrep = null, curRaw = null, nextPrep = null, nextRaw = null;

  const decode = async () => { const r = await it.next(); return r.done ? null : r.value; };

  return {
    advance: async () => {
      if (!started) {
        started = true;
        const f0 = await decode();
        if (!f0) return false;                       // empty stream
        curRaw = f0; curPrep = py.prepFrame(f0); prevPrep = null; // i=0: no prev → clamp to cur
        const f1 = await decode();                   // LOOKAHEAD before emitting window 0
        if (!f1) { nextRaw = null; nextPrep = null; sawLast = true; }
        else { nextRaw = f1; nextPrep = py.prepFrame(f1); }
        py.stageWindow(prevPrep, curPrep, nextPrep, curRaw);
        return true;
      }
      if (sawLast) return false;                      // the last window (next=cur) was already emitted
      prevPrep = curPrep; curPrep = nextPrep; curRaw = nextRaw; // shift the window forward
      const fN = await decode();                      // lookahead for the new current frame
      if (!fN) { nextRaw = null; nextPrep = null; sawLast = true; } // last: next → clamp to cur
      else { nextRaw = fN; nextPrep = py.prepFrame(fN); }
      py.stageWindow(prevPrep, curPrep, nextPrep, curRaw);
      return true;
    },
    frameInputs: () => py.frameInputs(),
    frameExtract: (courtOut, ballOut) => py.frameExtract(courtOut, ballOut),
    reduceEmit: () => py.reduceEmit(),
    // O(1) witness: raw frames + preps held alive at once (bounded, clip-length-independent).
    liveHandles: () => [prevPrep, curPrep, nextPrep, curRaw, nextRaw].filter((h) => h != null).length,
  };
}

/**
 * Run on-device match perception on a <video> and deliver the perceived facts to the live log.
 * The one shippable entry the ethos match-upload surface calls. Everything runtime-specific is
 * injected so this composition stays generic + testable.
 *
 * @param {object} args
 * @param {HTMLVideoElement} args.video
 * @param {Uint8Array} args.courtModelBytes
 * @param {Uint8Array} args.ballModelBytes
 * @param {object} args.py  the Pyodide-backed ops (see makeVideoStreamGlue)
 * @param {(session,inputBytes)=>Promise<any>} args.runCourt  ort court forward
 * @param {(session,inputBytes)=>Promise<any>} args.runBall   ort ball forward
 * @param {object} args.request     the motion-analysis request ({request_id, sources, ...})
 * @param {(request,commandOutput)=>Promise<{records}>} args.makeRecords  the record-maker (in Pyodide)
 * @param {(dispatch)=>Promise<any>} args.dispatch  the Envelope writer-action sender
 * @param {number} [args.fps] @param {number} [args.maxFrames] @param {string} [args.wasmPaths]
 * @returns {Promise<{provider:string, commandOutput:any, delivery:any}>}
 */
export async function runBrowserMatchPerception(args) {
  const { video, courtModelBytes, ballModelBytes, py, runCourt, runBall,
    request, makeRecords, dispatch, fps, maxFrames, wasmPaths } = args;

  await configureOrtEnv({ numThreads: 1, wasmPaths });
  const { session: courtSess, provider } = await createPerceptionSession(courtModelBytes);
  const { session: ballSess } = await createPerceptionSession(ballModelBytes);

  const frameSource = createVideoFrameSource(video, { fps, maxFrames }); // caps the schedule at source
  const glue = makeVideoStreamGlue({ frameSource, py });

  const { result: commandOutput } = await runStreamingPerception({
    glue,
    runCourt: (u8) => runCourt(courtSess, u8),
    runBall: (u8) => runBall(ballSess, u8),
    maxFrames,
  });

  const delivery = await deliverPerceptionCommandOutput(request, commandOutput, { makeRecords, dispatch });
  return { provider, commandOutput, delivery };
}
