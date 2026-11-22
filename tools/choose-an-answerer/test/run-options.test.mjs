import assert from 'node:assert/strict';
import test from 'node:test';
import { runOptions } from '../read-data/launch-a-lane.mjs';

test('no timeout is set when none is given, so a Codex lane runs as long as its job needs', () => {
  const options = runOptions({ cwd: '/work' });
  assert.equal('timeout' in options, false);
  assert.equal(runOptions({ cwd: '/work', timeoutSeconds: 0 }).timeout, undefined);
});

test('--timeout-seconds N sets N seconds as the timeout', () => {
  assert.equal(runOptions({ cwd: '/work', timeoutSeconds: 5 }).timeout, 5000);
});
