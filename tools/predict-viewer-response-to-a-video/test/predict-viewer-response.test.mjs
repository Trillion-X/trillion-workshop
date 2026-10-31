// Runs test_response_curve.py: the response curve, its spikes and its flat zones on synthetic predictions, with no model
// and no video. Skips, saying why, when python3 or numpy is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const here = import.meta.dirname;
const numpy = spawnSync('python3', ['-I', '-m', 'pip', 'show', 'numpy'], { encoding: 'utf8' });
const ready = numpy.status === 0;

test('the curve is time ordered and z-scored; spikes and flat zones follow the thresholds', { skip: !ready && 'python3 with numpy is needed' }, () => {
  const done = spawnSync('python3', [join(here, 'test_response_curve.py')], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /4 passed/);
});
