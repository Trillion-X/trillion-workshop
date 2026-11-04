// tools/calibrate-a-camera-frame/do-work/calibrate-a-camera-frame.mjs
//
// tool:calibrate-a-camera-frame, run as a function (tools/records-door do-work/run-an-export.mjs). The detector and the
// guided manual view run elsewhere (on the person's computer or in the app); this run is handed what they gave and
// answers with src/frame-calibration.mjs unchanged: the frame's projective map, where it came from (auto or manual), the
// confidence seen, each failed automatic attempt (kept by the caller for training data), and the given points mapped
// into the frame.
//
//   calibrateACameraFrame(input) -> { state, source?, confidence, h?, failures, points? }
//   input: { min_confidence, detected?: { corners, confidence } | null, manual_corners?: [[x, y] x4] | null, points?: [[x, y]] }
import { calibrate, toFrame } from '../src/frame-calibration.mjs';

export async function calibrateACameraFrame(input = {}) {
  const { min_confidence, detected = null, manual_corners = null, points = [] } = input ?? {};
  const failures = [];
  const answer = await calibrate({ detect: () => detected, manual: () => manual_corners, report: failure => { failures.push(failure); }, min_confidence });
  return {
    ...answer,
    failures,
    ...(answer.state === 'calibrated' && Array.isArray(points) && points.length ? { points: points.map(point => toFrame(answer.h, point)) } : {}),
  };
}
