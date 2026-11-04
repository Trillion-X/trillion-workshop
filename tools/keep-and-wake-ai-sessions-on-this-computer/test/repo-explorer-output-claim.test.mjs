import test from 'node:test';
import assert from 'node:assert/strict';
import { runFrozen } from '../src/repo-explorer.mjs';

test('a host that lost its completed-output claim cannot publish the result', async () => {
  let checks = 0;
  let stopped = 0;
  const sandbox = {
    outcome: async () => ({ state: 'done', code: 0, stdout: new TextEncoder().encode('ready'), stderr: new Uint8Array() }),
    begin: async () => { throw new Error('the completed run must not start again'); },
    claimOutcome: async () => ({ claimed: true, token: 'first-host' }),
    renewOutcomeClaim: async () => { checks += 1; return false; },
    stop: async () => { stopped += 1; },
  };
  const lost = await runFrozen({ sandbox, bytes: new Uint8Array([1]), argv: ['render'], deferStop: true }).catch(error => error);
  assert.equal(lost.retryable, true);
  assert.match(lost.message, /Another host is finishing/);
  assert.equal(checks, 1);
  assert.equal(stopped, 0, 'the losing host leaves the container for the claim winner');
});

test('a kept output keeps the results its row names, each from the input it was made with', async () => {
  const { keptResults } = await import('../src/repo-explorer.mjs');
  const output = { name: 'video', results: [{ kind: 'caption-style', from: 'style', otherwise: {} }, { kind: 'bad' }] };
  assert.deepEqual(keptResults({ output, input: { style: 'white-words-light-up' }, identity: '1f:x', producedBy: 'tool:add-captions' }),
    [{ identity: '1f:x', kind: 'caption-style', value: 'white-words-light-up', produced_by: 'tool:add-captions' }]);
  assert.deepEqual(keptResults({ output, input: {}, identity: '1f:x' }), [{ identity: '1f:x', kind: 'caption-style', value: {} }]);
  assert.deepEqual(keptResults({ output: { name: 'video' }, input: {}, identity: '1f:x' }), []);
  assert.deepEqual(keptResults({ output, input: {}, identity: undefined }), []);
});
