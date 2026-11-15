// The workflow engine ported from bitfield-packages (crates/workflow-core), built as the WebAssembly module a Worker
// loads (crates/workflow-engine, `web` shape, as src/tools-in-this-worker.mjs starts it), running a definition whose
// steps Trillion's host answers from JavaScript. src/workflows.mjs runs every workflow on it (test/workflows.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrateForAWebHost } from '../build/build-crate-for-a-web-host.mjs';
import { workflowEngineForTests } from './workflow-engine-for-tests.mjs';

test('the ported workflow engine runs in WebAssembly and asks the JavaScript host for each step, in order', { timeout: 900_000 }, async () => {
  const built = await buildCrateForAWebHost({ crate: 'workflow-engine', bindgenTarget: 'web' });
  assert.deepEqual(built.importModules.filter(name => name.startsWith('slots:') || name.startsWith('$root')), [], 'no slot-world imports reach a web module');
  const engine = await workflowEngineForTests();
  const asked = [];
  const definitions = [{
    id: 'draft-then-count', name: 'Draft then count', kind: 'workflow', is_active: true, version: 1,
    steps: [
      { id: 'draft', kind: 'ask', config: { name: 'tool:draft', input: { topic: 'tennis' } } },
      { id: 'count', kind: 'ask', config: { name: 'tool:count-words', input: {} } },
    ],
    edges: [{ from: 'draft', to: 'count', kind: 'always' }],
  }];
  const ask = async (name, payload) => {
    asked.push(name);
    await new Promise(resolve => setTimeout(resolve, 5));
    return new TextEncoder().encode(JSON.stringify({ answered: name, bytes: payload.length }));
  };
  const read = async () => new TextEncoder().encode('{}');
  // An answer that is not there yet pauses the run at that step; nothing after it runs.
  const paused = JSON.parse(await engine.run(JSON.stringify(definitions), 'draft-then-count', '{}', 'person:test', 'example', async name => new TextEncoder().encode(JSON.stringify(name === 'tool:count-words' ? { $kind: 'not-answered-yet' } : { text: 'x' })), read));
  assert.equal(paused.status, 'paused');
  assert.equal(paused.execution_context.steps.count.status, 'paused');
  const run = JSON.parse(await engine.run(JSON.stringify(definitions), 'draft-then-count', '{}', 'person:test', 'example', ask, read));
  assert.equal(run.status, 'completed', JSON.stringify(run).slice(0, 400));
  assert.deepEqual(asked, ['tool:draft', 'tool:count-words']);
  // A host that cannot answer is a failed run the engine reports, never a hang or a silent success.
  const failed = JSON.parse(await engine.run(JSON.stringify(definitions), 'draft-then-count', '{}', 'person:test', 'example', async () => { throw new Error('the Mac is asleep'); }, read));
  assert.equal(failed.status, 'failed');
  assert.match(JSON.stringify(failed), /the Mac is asleep/);
});
