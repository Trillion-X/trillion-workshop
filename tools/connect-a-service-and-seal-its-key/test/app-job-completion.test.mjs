import assert from 'node:assert/strict';
import test from 'node:test';
import { completedAppResult, useAnAppHere } from '../../media-composition/do-work/use-an-app-here.mjs';
import { runOnAgent } from '../../hand-off-jobs-between-agents/src/agent-tool-runs.mjs';
import { buildInvocation, schemaProblems } from '../../keep-and-wake-ai-sessions-on-this-computer/src/workshop.mjs';
import records from '../from-old-trillion/records/workshop-tool-records.json' with { type: 'json' };

const answer = value => ({ structuredContent: value });
const rule = { status_field: 'status', done: 'completed', failed: ['failed', 'cancelled'], timeout_seconds: 1, interval_ms: 100,
  poll: { operation: 'get_job', arguments: { job_id: { reply: 'job_id' } } }, cancel: { operation: 'cancel_job', arguments: { job_id: { reply: 'job_id' } } } };

test('one initialized MCP session stays alive until the output job completes', async () => {
  const calls = []; let stopped = false; let reads = 0;
  const result = await useAnAppHere({ app: 'renderer', operation: 'generate', rows: { protocol_version: '2025-06-18', client: {}, answer_seconds: 2,
    apps: [{ id: 'renderer', label: 'Renderer', start: ['renderer'], completion: { generate: rule } }] },
    startImpl: () => ({ tell() {}, stop() { stopped = true; }, async ask(method, input) {
      assert.equal(stopped, false, 'the worker is still alive'); calls.push({ method, input });
      if (method === 'initialize') return {};
      if (input.name === 'generate') return answer({ job_id: 'owned-job', status: 'queued' });
      assert.deepEqual(input.arguments, { job_id: 'owned-job' });
      return answer({ result: { job_id: 'owned-job', status: ++reads === 2 ? 'completed' : 'running', output_path: 'hero.png' } });
    } }) });
  assert.equal(result.ok, true); assert.equal(result.answer.status, 'completed'); assert.equal(stopped, true);
  assert.equal(calls.filter(call => call.method === 'initialize').length, 1);
});

test('failed jobs never pass as successful images', async () => {
  const failed = await completedAppResult({ ask: async () => answer({ status: 'failed', error: 'model unavailable' }) }, rule, answer({ job_id: 'j', status: 'queued' }), { sleep: async () => {} });
  assert.equal(failed.isError, true);
});

test('an unsupported computer never starts or installs the image runtime', async () => {
  await assert.rejects(useAnAppHere({ app: 'renderer', platform: 'linux', arch: 'x64',
    rows: { apps: [{ id: 'renderer', label: 'Renderer', platforms: ['darwin-arm64'] }] },
    startImpl: () => { throw new Error('must not start'); } }), /does not run on this computer/);
});

test('completion timeout cancels the exact submitted job and rejects', async () => {
  let clock = 0; const calls = [];
  await assert.rejects(completedAppResult({ async ask(method, input) { calls.push(input); return answer({ status: 'running' }); } }, rule, answer({ job_id: 'owned-job', status: 'queued' }),
    { now: () => clock, sleep: async ms => { clock += ms; } }), /did not finish/);
  assert.deepEqual(calls.at(-1), { name: 'cancel_job', arguments: { job_id: 'owned-job' } });
  await assert.rejects(completedAppResult({}, rule, answer({ status: 'queued' })), /gave no job_id/);
});

test('computer tools receive the DATA-bound app job, with unchanged ordinary inputs', async () => {
  for (const mapped of [true, false]) {
    let handed;
    const input = { brief: 'An original image' }; const jobInput = { app: 'renderer', operation: 'generate', arguments: { prompt: input.brief } };
    const agents = { reach: () => true, cardOf: () => null,
      handOff: row => { handed = row; return { handoff: { handoff_id: 'job' } }; }, read: () => ({ handoff: { state: 'finished', result: { ok: true } } }) };
    await runOnAgent({ agents, placement: { settings: { agent_id: 'computer' } }, tool: { id: 'image', label: 'Image' },
      invocation: { tool_id: 'app-job', ...(mapped ? { input: jobInput } : {}) }, input, task: { task_id: 'task_image' } });
    assert.deepEqual(handed.input, { tool_id: 'app-job', input: mapped ? jobInput : input });
  }
});

test('published image tools bind the brief and saved input file without sending absent options', async () => {
  const identity = `1f:${'a'.repeat(64)}`;
  for (const id of ['tool:generate-local-image', 'tool:edit-local-image']) {
    const tool = records.records.find(row => row.payload.id === id).payload;
    const input = { brief: 'A person untangling a thread, without words', model: 'flux2-klein-4b', ...(id.includes('edit') ? { image: identity } : {}) };
    assert.deepEqual(schemaProblems(input, tool.input_schema), []);
    const concrete = JSON.parse(JSON.stringify(await buildInvocation(tool.invoke, { input, task: {} })));
    assert.equal(concrete.input.arguments.prompt, input.brief);
    assert.equal(concrete.input.arguments.model, input.model);
    assert.equal(Object.hasOwn(concrete.input.arguments, 'steps'), false);
    if (id.includes('edit')) assert.equal(concrete.input.files.inputs[0].identity, identity);
    assert.deepEqual(schemaProblems({ ok: true, files: [{ identity, bytes: 100, media_type: 'image/png' }] }, tool.output_schema), []);
  }
});
