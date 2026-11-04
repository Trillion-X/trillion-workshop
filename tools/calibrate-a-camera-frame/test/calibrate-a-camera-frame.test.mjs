// tools/calibrate-a-camera-frame/test/calibrate-a-camera-frame.test.mjs: the tool's run over made-up input, and each row run the way the runner runs it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { answerOf, rowOf, select } from '../../../test-helpers/run-a-row.mjs';
import { calibrateACameraFrame } from '../do-work/calibrate-a-camera-frame.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));

test('a sure detection stands, an unsure one falls back to the manual corners, and each failure is handed back', async () => {
  const corners = [[100, 50], [500, 80], [540, 400], [60, 380]];
  const auto = await calibrateACameraFrame({ min_confidence: 0.8, detected: { corners, confidence: 0.95 }, points: [[540, 400]] });
  assert.equal(auto.state, 'calibrated');
  assert.equal(auto.source, 'auto');
  assert.deepEqual(auto.failures, []);
  assert.ok(Math.abs(auto.points[0][0] - 1) < 1e-9 && Math.abs(auto.points[0][1] - 1) < 1e-9);
  const manual = await calibrateACameraFrame({ min_confidence: 0.8, detected: { corners, confidence: 0.4 }, manual_corners: corners });
  assert.equal(manual.source, 'manual');
  assert.equal(manual.confidence, 0.4, 'the confidence seen is said, never presented as good');
  assert.deepEqual(manual.failures.map(failure => failure.reason), ['low_confidence']);
  const none = await calibrateACameraFrame({ min_confidence: 0.8 });
  assert.equal(none.state, 'needs_manual');
  assert.deepEqual(none.failures.map(failure => failure.reason), ['nothing_detected']);
  await assert.rejects(calibrateACameraFrame({ min_confidence: 0.8, manual_corners: [[0, 0], [1, 1], [2, 2], [3, 3]] }), /do not form a frame/);
});

test('tool:calibrate-a-camera-frame runs as the container runner runs it, on its own sample', async () => {
  const row = rowOf(rows, 'tool:calibrate-a-camera-frame');
  const ran = await answerOf(row, row.verify[0].input);
  assert.equal(ran.status, 0, JSON.stringify(ran.error));
  assert.match(JSON.stringify(select(ran, row.result_selector + row.verify[0].output_selector.slice(1))), new RegExp(row.verify[0].contains));
});
