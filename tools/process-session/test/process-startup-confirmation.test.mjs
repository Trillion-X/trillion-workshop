import assert from 'node:assert/strict';
import test from 'node:test';
import { runOwnedProcess } from '../do-work/run-owned-process.mjs';

test('a sent IPC message cannot retire the deadline before the owner executes', async () => {
  const stages = [];
  const blocker = 'data:text/javascript,' + encodeURIComponent('await new Promise(resolve => setTimeout(resolve, 60000));');
  await assert.rejects(runOwnedProcess(process.execPath, ['-e', 'process.stdout.write("must not run")'], {
    env: { ...process.env, NODE_OPTIONS: `--import=${blocker}` },
    startupTimeoutMs: 300, timeoutMs: 2000, onStage: stage => stages.push(stage),
  }), error => {
    assert.match(error.message, /startup deadline/);
    assert.equal(error.processStopped, undefined);
    return true;
  });
  assert.ok(stages.includes('start-sent'));
  assert.equal(stages.includes('worker-started'), false);
});

test('an executing owner confirms startup and returns its actual result', async () => {
  const stages = [];
  const result = await runOwnedProcess(process.execPath, ['-e', 'process.stdout.write("started")'], {
    startupTimeoutMs: 3000, timeoutMs: 5000, onStage: stage => stages.push(stage),
  });
  assert.equal(result, 'started');
  assert.ok(stages.includes('worker-started'));
  assert.ok(stages.includes('worker-result'));
});
