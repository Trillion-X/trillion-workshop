// test/frame-and-stream.test.mjs: one-time frame calibration (F-0567).
import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, homographyFromCorners, toFrame } from '../src/frame-calibration.mjs';

test('four corners map to the unit square under perspective, and bad corners are refused', () => {
  const corners = [[100, 50], [500, 80], [540, 400], [60, 380]];
  const h = homographyFromCorners(corners);
  corners.forEach((c, i) => { const [u, v] = toFrame(h, c); assert.ok(Math.abs(u - [0, 1, 1, 0][i]) < 1e-9 && Math.abs(v - [0, 0, 1, 1][i]) < 1e-9); });
  const centre = toFrame(h, [300, 225]);
  assert.ok(centre[0] > 0 && centre[0] < 1 && centre[1] > 0 && centre[1] < 1);
  assert.throws(() => homographyFromCorners([[0, 0], [1, 1], [2, 2], [3, 3]]), error => error.status === 400);
  assert.throws(() => homographyFromCorners([[0, 0]]), error => error.status === 400);
});

test('calibration trusts a confident detection, falls back to manual corners with the failure kept, and says when it needs the person', async () => {
  const good = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const reports = [];
  const report = failure => reports.push(failure.reason);
  const auto = await calibrate({ detect: async () => ({ corners: good, confidence: 0.9 }), report, min_confidence: 0.7 });
  assert.deepEqual([auto.state, auto.source, auto.confidence, reports.length], ['calibrated', 'auto', 0.9, 0]);
  const fallback = await calibrate({ detect: async () => ({ corners: good, confidence: 0.3 }), manual: async () => good, report, min_confidence: 0.7 });
  assert.deepEqual([fallback.state, fallback.source, fallback.confidence, reports], ['calibrated', 'manual', 0.3, ['low_confidence']]);
  const none = await calibrate({ detect: async () => null, report, min_confidence: 0.7 });
  assert.deepEqual([none.state, none.confidence, reports.at(-1)], ['needs_manual', 0, 'nothing_detected']);
  const broken = await calibrate({ detect: async () => ({ corners: [[0, 0], [1, 1], [2, 2], [3, 3]], confidence: 0.99 }), manual: async () => good, report, min_confidence: 0.7 });
  assert.equal(broken.source, 'manual');
  await assert.rejects(calibrate({ detect: async () => null }), error => error.status === 400);
});
