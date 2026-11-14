// packages/motion-analysis/do-work/process-scripts/match/test_match_stream_driver.mjs
//
// Gate for the generic streaming perception orchestrator (match_stream_driver.mjs).
// Proves the assembly wiring (per-frame court+ball forwards, tiny-result extraction, one
// reduce+emit, maxFrames cap, input threading, fail-closed) with a MOCK glue + spy runners —
// ZERO pyodide, ort, models, or browser. Runs with plain node from anywhere.
//
//   node test_match_stream_driver.mjs
// =============================================================================
import { runStreamingPerception } from "./match_stream_driver.mjs";

let pass = 0, fail = 0;
const T = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

console.log("match_stream_driver — generic streaming perception orchestrator\n");

// A mock substrate: a fixed-length frame source + a trace of the exact call sequence. The glue
// stands in for the pyodide python glue (Node) or the browser glue — the orchestrator can't tell.
function makeMock(frameCount) {
  const trace = [];
  let idx = -1;                       // current staged frame
  const glue = {
    async setup() { trace.push("setup"); },
    async advance() {
      idx++;
      const produced = idx < frameCount;
      trace.push(`advance:${produced ? idx : "END"}`);
      return produced;
    },
    async frameInputs() {
      trace.push(`inputs:${idx}`);
      return [`court-in-${idx}`, `ball-in-${idx}`]; // opaque input tokens for this frame
    },
    async frameExtract(courtOut, ballOut) {
      trace.push(`extract:${idx}(${courtOut},${ballOut})`);
    },
    async reduceEmit(nFrames) {
      trace.push(`reduceEmit:${nFrames}`);
      return { facts: new Array(nFrames * 2).fill(0), records: [], summary: { frames: nFrames } };
    },
  };
  const courtCalls = [], ballCalls = [];
  const runCourt = async (inp) => { courtCalls.push(inp); return `court-out-${courtCalls.length - 1}`; };
  const runBall = async (inp) => { ballCalls.push(inp); return `ball-out-${ballCalls.length - 1}`; };
  return { glue, runCourt, runBall, trace, courtCalls, ballCalls };
}

// 1. Processes every frame until advance() is falsy; setup + reduceEmit fire exactly once.
{
  const m = makeMock(3);
  const { framesProcessed, result } = await runStreamingPerception({ glue: m.glue, runCourt: m.runCourt, runBall: m.runBall });
  T("processes all 3 frames, returns framesProcessed=3", framesProcessed === 3);
  T("setup once at start, reduceEmit once at end with n=3",
    m.trace[0] === "setup" && m.trace.filter(t => t === "setup").length === 1
    && m.trace[m.trace.length - 1] === "reduceEmit:3");
  T("result is the reduceEmit output (command-output shape)", result.summary.frames === 3 && result.facts.length === 6);
}

// 2. Exact per-frame call order: advance → inputs → (court, ball) → extract, for each frame.
{
  const m = makeMock(2);
  await runStreamingPerception({ glue: m.glue, runCourt: m.runCourt, runBall: m.runBall });
  const expected = [
    "setup",
    "advance:0", "inputs:0", "extract:0(court-out-0,ball-out-0)",
    "advance:1", "inputs:1", "extract:1(court-out-1,ball-out-1)",
    "advance:END", "reduceEmit:2",
  ];
  T("exact call sequence: advance→inputs→court→ball→extract per frame, reduceEmit last",
    JSON.stringify(m.trace) === JSON.stringify(expected));
}

// 3. Input threading: each frame's [courtIn, ballIn] reach runCourt/runBall in order.
{
  const m = makeMock(3);
  await runStreamingPerception({ glue: m.glue, runCourt: m.runCourt, runBall: m.runBall });
  T("court runner gets each frame's court input in order",
    JSON.stringify(m.courtCalls) === JSON.stringify(["court-in-0", "court-in-1", "court-in-2"]));
  T("ball runner gets each frame's ball input in order",
    JSON.stringify(m.ballCalls) === JSON.stringify(["ball-in-0", "ball-in-1", "ball-in-2"]));
}

// 4. O(1) heatmaps by construction: exactly one court + one ball forward per frame (never batched).
{
  const m = makeMock(5);
  const r = await runStreamingPerception({ glue: m.glue, runCourt: m.runCourt, runBall: m.runBall });
  T("exactly one court + one ball forward per processed frame (O(1), not batched)",
    m.courtCalls.length === r.framesProcessed && m.ballCalls.length === r.framesProcessed && r.framesProcessed === 5);
}

// 5. maxFrames caps processing even when the source has more frames.
{
  const m = makeMock(10);
  const r = await runStreamingPerception({ glue: m.glue, runCourt: m.runCourt, runBall: m.runBall, maxFrames: 4 });
  T("maxFrames=4 caps to 4 frames though source has 10", r.framesProcessed === 4 && m.courtCalls.length === 4);
}

// 6. onFrame progress hook fires per finished frame, in order.
{
  const m = makeMock(3);
  const seen = [];
  await runStreamingPerception({ glue: m.glue, runCourt: m.runCourt, runBall: m.runBall, onFrame: (i) => seen.push(i) });
  T("onFrame hook fires per finished frame in order", JSON.stringify(seen) === JSON.stringify([0, 1, 2]));
}

// 7. Empty stream: zero frames → no forwards, reduceEmit(0) still called (honest empty).
{
  const m = makeMock(0);
  const r = await runStreamingPerception({ glue: m.glue, runCourt: m.runCourt, runBall: m.runBall });
  T("empty stream → 0 frames, no forwards, reduceEmit(0) called (honest empty)",
    r.framesProcessed === 0 && m.courtCalls.length === 0 && m.trace.includes("reduceEmit:0"));
}

// 8. Fail-closed API: missing glue or runners throws.
{
  let threw = 0;
  try { await runStreamingPerception({ runCourt: async () => {}, runBall: async () => {} }); } catch { threw++; }
  try { await runStreamingPerception({ glue: {}, runBall: async () => {} }); } catch { threw++; }
  T("fail-closed: throws without glue and without runners", threw === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
