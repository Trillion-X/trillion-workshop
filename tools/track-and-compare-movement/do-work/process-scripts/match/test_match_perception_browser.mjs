// packages/motion-analysis/do-work/process-scripts/match/test_match_perception_browser.mjs
//
// Gate for the browser driver's push↔pull frame-bridge glue (match_perception_browser.mjs).
// Proves the one-behind async lag + edge-null signalling + O(1) frames + EOF flush with a MOCK
// frame source + MOCK py ops — ZERO Pyodide/ort/models/browser. The real in-browser run is the
// terminal proof; this proves the LOCKSTEP is correct (frame i+1 decoded before window i emitted,
// windows byte-identical to ball_window_stream's clamp sequence via window_preps).
//
//   node test_match_perception_browser.mjs
// =============================================================================
import { makeVideoStreamGlue } from "./match_perception_browser.mjs";
import { runStreamingPerception } from "./match_stream_driver.mjs";

let pass = 0, fail = 0;
const T = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

console.log("match_perception_browser — push↔pull frame-bridge glue\n");

// A mock <video> frame source: yields N sentinel BGR frames, recording decode order + peak alive.
function mockSource(n) {
  const decoded = [];
  let i = 0;
  return {
    decoded,
    async next() {
      if (i >= n) return { done: true, value: undefined };
      const frame = { index: i, width: 4, height: 4, bgr: new Uint8Array(48) };
      decoded.push(i);
      i++;
      return { done: false, value: frame };
    },
  };
}

// Mock py ops: prep returns a token, stageWindow records the (prev,cur,next,rawIndex) it received.
function mockPy() {
  const prep = [], stage = [];
  let inputs = 0, extract = 0, reduce = 0;
  return {
    calls: { prep, stage, get inputs() { return inputs; }, get extract() { return extract; }, get reduce() { return reduce; } },
    prepFrame: (f) => { prep.push(f.index); return `p${f.index}`; },
    stageWindow: (prevP, curP, nextP, raw) => { stage.push([prevP, curP, nextP, raw ? raw.index : null]); },
    frameInputs: () => { inputs++; return [`court`, `ball`]; },
    frameExtract: () => { extract++; },
    reduceEmit: () => { reduce++; return { facts: [], records: [], summary: { frames: stage.length } }; },
  };
}

// 1. THREE frames: exact one-behind window sequence with edge nulls (prev=null@0, next=null@last),
//    matching ball_window_stream's (0→prev=cur, mid=neighbours, last→next=cur) after window_preps.
{
  const py = mockPy();
  const glue = makeVideoStreamGlue({ frameSource: mockSource(3), py });
  const seq = [];
  for (;;) { const ok = await glue.advance(); seq.push(ok); if (!ok) break; }
  T("advance sequence for 3 frames = [true,true,true,false]", JSON.stringify(seq) === JSON.stringify([true, true, true, false]));
  T("3 windows staged with one-behind edge-null clamp inputs",
    JSON.stringify(py.calls.stage) === JSON.stringify([
      [null, "p0", "p1", 0],   // frame 0: no prev
      ["p0", "p1", "p2", 1],   // frame 1: neighbours
      ["p1", "p2", null, 2],   // frame 2: no next
    ]));
}

// 2. LOOKAHEAD: frame i+1 is decoded (and prepped) BEFORE window i is staged.
{
  const py = mockPy();
  const src = mockSource(3);
  const glue = makeVideoStreamGlue({ frameSource: src, py });
  await glue.advance(); // emits window 0
  T("before window 0 is staged, frames 0 AND 1 were decoded (lookahead)", src.decoded.slice(0, 2).join() === "0,1");
  T("prep called for frame 1 before window 0 staged (prep[0,1] present, 1 stage)",
    py.calls.prep.join() === "0,1" && py.calls.stage.length === 1);
}

// 3. O(1) frames: liveHandles stays bounded (<=5 = 2 raw + 3 preps) regardless of clip length.
{
  const py = mockPy();
  const glue = makeVideoStreamGlue({ frameSource: mockSource(200), py });
  let peak = 0, n = 0;
  for (;;) { const ok = await glue.advance(); if (!ok) break; peak = Math.max(peak, glue.liveHandles()); n++; }
  T("200-frame clip → 200 windows, liveHandles peak ≤ 5 (O(1), not O(N))", n === 200 && peak <= 5);
}

// 4. SINGLE frame: one window, prev=null AND next=null (both clamp to cur in window_preps).
{
  const py = mockPy();
  const glue = makeVideoStreamGlue({ frameSource: mockSource(1), py });
  const seq = [];
  for (;;) { const ok = await glue.advance(); seq.push(ok); if (!ok) break; }
  T("single frame → [true,false], one window (null,'p0',null,0)",
    JSON.stringify(seq) === JSON.stringify([true, false])
    && JSON.stringify(py.calls.stage) === JSON.stringify([[null, "p0", null, 0]]));
}

// 5. EMPTY stream: advance() → false immediately, no windows.
{
  const py = mockPy();
  const glue = makeVideoStreamGlue({ frameSource: mockSource(0), py });
  const ok = await glue.advance();
  T("empty stream → advance false, zero windows", ok === false && py.calls.stage.length === 0);
}

// 6. End-to-end through the real orchestrator: glue drives runStreamingPerception, one court+ball
//    forward per frame, reduceEmit once, command-output returned.
{
  const py = mockPy();
  const glue = makeVideoStreamGlue({ frameSource: mockSource(4), py });
  const courtRuns = [], ballRuns = [];
  const { framesProcessed, result } = await runStreamingPerception({
    glue,
    runCourt: async (u8) => { courtRuns.push(u8); return "court-out"; },
    runBall: async (u8) => { ballRuns.push(u8); return "ball-out"; },
  });
  T("orchestrator over the glue → 4 frames, 4 court + 4 ball forwards, reduceEmit once",
    framesProcessed === 4 && courtRuns.length === 4 && ballRuns.length === 4 && py.calls.reduce === 1);
  T("command-output threaded back from reduceEmit", result && result.summary.frames === 4);
}

// 7. Fail-closed API.
{
  let threw = 0;
  try { makeVideoStreamGlue({ py: mockPy() }); } catch { threw++; }
  try { makeVideoStreamGlue({ frameSource: mockSource(1) }); } catch { threw++; }
  T("fail-closed: throws without frameSource and without py ops", threw === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
