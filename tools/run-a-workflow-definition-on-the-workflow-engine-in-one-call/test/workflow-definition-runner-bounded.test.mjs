import test from 'node:test';
import assert from 'node:assert/strict';
import { BOUNDED_WORKFLOW_API_VERSION, makeWorkflowDefinitionRunner } from '../src/workflow-definition-runner.mjs';
import manifest from '../package.json' with { type: 'json' };

const limits = {
  envelope: {
    max_definitions_json_bytes: 4096, max_input_json_bytes: 1024, max_id_bytes: 128,
    max_partition_bytes: 128, max_definitions: 8, max_total_steps: 32, max_total_edges: 32,
    max_nested_closure_bytes: 4096, max_output_json_bytes: 4096,
  },
  execution: { max_step_attempts: 12, max_loop_iterations: 16, max_action_depth: 4 },
};

const input = {
  workflow_id: 'wf:test', partition: 'person:test', definitions: [{ id: 'wf:test', steps: [] }], input: {},
};

function response(status = 'paused') {
  return JSON.stringify({
    version: BOUNDED_WORKFLOW_API_VERSION,
    usage: { step_attempts: 1, loop_iterations: 0, action_depth: 0 },
    result: {
      id: 'wfi:test', partition_key: 'person:test', workflow_id: 'wf:test', status,
      started_at: null, completed_at: null, error_message: null, start_id: null,
      current_step: 0, execution_context: {},
    },
  });
}

test('bounded hostless runner preserves answer, waiting, and read refusal semantics while forwarding host limits', async () => {
  let received;
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async (...args) => {
      received = args;
      const ask = args[17];
      const reply = JSON.parse(new TextDecoder().decode(await ask('ask:research', new TextEncoder().encode('{"q":1}'), new TextEncoder().encode('{"step_id":"research"}'))));
      assert.equal(reply.$kind, 'not-answered-yet');
      assert.equal(reply.step_id, 'research');
      await assert.rejects(args[18]('records:missing'), /Nothing here answers a read/);
      return response();
    },
  }));

  const run = await runner.runWorkflowDefinitionBounded(input, null, limits);
  assert.equal(run.version, BOUNDED_WORKFLOW_API_VERSION);
  assert.deepEqual(run.result.waiting, [{ step_id: 'research', asks: 'ask:research', input: { q: 1 } }]);
  assert.equal(received[1], 'wf:test');
  assert.equal(received[3], 'person:test');
  assert.equal(received[4], manifest.name, 'the namespace word follows the partition');
  assert.equal(received[5], limits.envelope.max_definitions_json_bytes);
  assert.equal(received[8], limits.envelope.max_partition_bytes);
  assert.equal(received[14], limits.execution.max_step_attempts);
  assert.equal(received[15], limits.execution.max_loop_iterations);
  assert.equal(received[16], limits.execution.max_action_depth);
});

test('bounded runner refuses a missing versioned export without calling legacy run', async () => {
  let legacyCalls = 0;
  const runner = makeWorkflowDefinitionRunner(async () => ({ run: async () => { legacyCalls += 1; } }));
  await assert.rejects(runner.runWorkflowDefinitionBounded(input, null, limits), /FE_BOUNDED_ENGINE_UNSUPPORTED/);
  assert.equal(legacyCalls, 0);
});

test('bounded runner rejects a wrong response version or shape', async () => {
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => JSON.stringify({ version: 'old', usage: {}, result: { status: 'completed' } }),
  }));
  await assert.rejects(runner.runWorkflowDefinitionBounded(input, null, limits), /FE_BOUNDED_RESPONSE_INVALID/);
});

test('bounded runner snapshots limits and request wire values before awaiting the engine loader', async () => {
  const mutableInput = structuredClone(input);
  mutableInput.answers = { research: { value: 'before-loader' } };
  const mutableLimits = structuredClone(limits);
  let received;
  const runner = makeWorkflowDefinitionRunner(async () => {
    mutableLimits.envelope.max_output_json_bytes = 1;
    mutableLimits.execution.max_step_attempts = 1;
    mutableInput.workflow_id = 'mutated-after-call';
    mutableInput.partition = 'mutated-after-call';
    mutableInput.definitions[0].id = 'mutated-after-call';
    mutableInput.answers.research = { value: 'after-loader' };
    return {
      run_bounded_v1: async (...args) => {
        received = args;
        const answer = JSON.parse(new TextDecoder().decode(await args[17](
          'ask:research', new TextEncoder().encode('{}'), new TextEncoder().encode('{"step_id":"research"}'),
        )));
        assert.deepEqual(answer, { value: 'before-loader' });
        return response();
      },
    };
  });

  const run = await runner.runWorkflowDefinitionBounded(mutableInput, null, mutableLimits);
  assert.equal(run.result.workflow_id, 'wf:test');
  assert.equal(received[1], 'wf:test');
  assert.equal(received[3], 'person:test');
  assert.equal(JSON.parse(received[0])[0].id, 'wf:test');
  assert.equal(received[4], manifest.name);
  assert.equal(received[13], limits.envelope.max_output_json_bytes);
  assert.equal(received[14], limits.execution.max_step_attempts);
});

test('bounded runner rejects oversized raw output before trying to parse it', async () => {
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => '{'.repeat(5000),
  }));
  await assert.rejects(
    runner.runWorkflowDefinitionBounded(input, null, limits),
    /raw response exceeds max_output_json_bytes/,
  );
});

test('bounded runner reports malformed in-limit raw output as invalid JSON', async () => {
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => '{',
  }));
  await assert.rejects(
    runner.runWorkflowDefinitionBounded(input, null, limits),
    /engine returned malformed JSON/,
  );
});

test('bounded runner rejects failure strings over 512 UTF-8 bytes before parsing', async () => {
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => { throw '{'.repeat(513); },
  }));
  await assert.rejects(
    runner.runWorkflowDefinitionBounded(input, null, limits),
    /failure envelope exceeds 512 UTF-8 bytes/,
  );
});

test('bounded runner rejects usage that exceeds captured host limits', async () => {
  const overBudget = JSON.parse(response());
  overBudget.usage.step_attempts = limits.execution.max_step_attempts + 1;
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => JSON.stringify(overBudget),
  }));
  await assert.rejects(
    runner.runWorkflowDefinitionBounded(input, null, limits),
    /usage exceeds the captured host limits/,
  );
});

test('bounded runner rejects a response for a different instance identity or invalid step number', async () => {
  const wrongWorkflow = JSON.parse(response());
  wrongWorkflow.result.workflow_id = 'other-workflow';
  const wrongWorkflowRunner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => JSON.stringify(wrongWorkflow),
  }));
  await assert.rejects(
    wrongWorkflowRunner.runWorkflowDefinitionBounded(input, null, limits),
    /result instance has an unexpected shape or identity/,
  );

  const wrongPartition = JSON.parse(response());
  wrongPartition.result.partition_key = 'other-partition';
  const wrongPartitionRunner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => JSON.stringify(wrongPartition),
  }));
  await assert.rejects(
    wrongPartitionRunner.runWorkflowDefinitionBounded(input, null, limits),
    /result instance has an unexpected shape or identity/,
  );

  const negativeStep = JSON.parse(response());
  negativeStep.result.current_step = -1;
  const negativeStepRunner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => JSON.stringify(negativeStep),
  }));
  await assert.rejects(
    negativeStepRunner.runWorkflowDefinitionBounded(input, null, limits),
    /result instance has an unexpected shape or identity/,
  );
});

test('bounded runner retains typed budget refusal and its usage fields', async () => {
  const refusal = JSON.stringify({
    version: BOUNDED_WORKFLOW_API_VERSION,
    error: {
      code: 'FE_RUN_BUDGET_EXCEEDED', dimension: 'step_attempts', attempted: 13, limit: 12,
      step_attempts_used: 12, loop_iterations_used: 3, action_depth_used: 2,
    },
  });
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => { throw refusal; },
  }));
  await assert.rejects(runner.runWorkflowDefinitionBounded(input, null, limits), error => {
    assert.equal(error.code, 'FE_RUN_BUDGET_EXCEEDED');
    assert.equal(error.details.step_attempts_used, 12);
    assert.equal(error.details.loop_iterations_used, 3);
    assert.equal(error.details.action_depth_used, 2);
    return true;
  });
});

test('bounded runner requires explicit positive safe host limits', async () => {
  const runner = makeWorkflowDefinitionRunner(async () => ({ run_bounded_v1: async () => response() }));
  const invalid = { ...limits, execution: { ...limits.execution, max_step_attempts: 0 } };
  await assert.rejects(runner.runWorkflowDefinitionBounded(input, null, invalid), /max_step_attempts/);
  const tooLarge = { ...limits, envelope: { ...limits.envelope, max_input_json_bytes: 0x1_0000_0000 } };
  await assert.rejects(runner.runWorkflowDefinitionBounded(input, null, tooLarge), /positive u32/);
});

const encode = value => new TextEncoder().encode(JSON.stringify(value));
const decode = value => JSON.parse(new TextDecoder().decode(value));
function replayResponse(startedAt, startId) {
  const value = JSON.parse(response());
  value.result.started_at = startedAt || 'engine-time';
  value.result.start_id = startId;
  value.result.execution_context.start = { started_at: startedAt, start_id: startId };
  value.result.runtime_outputs = { '["parent","child"]': { status: 'completed', output: { kept: true } } };
  return JSON.stringify(value);
}

test('legacy timestamp replay still reaches runWithStartedAt with the original call shape', async () => {
  let calls = 0;
  const timestamp = '2026-10-14T16:20:00.000Z';
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run: async () => { throw new Error('legacy fallback must not run'); },
    runWithStartedAt: async (...args) => {
      calls += 1;
      assert.equal(args.length, 8);
      assert.equal(args[4], manifest.name, 'the namespace word follows the partition');
      assert.equal(args[5], timestamp);
      assert.equal(typeof args[6], 'function');
      return JSON.stringify({ status: 'paused', started_at: timestamp });
    },
  }));
  const value = await runner.runWorkflowDefinition({ ...input, started_at: timestamp });
  assert.equal(value.started_at, timestamp);
  assert.equal(calls, 1);
});

test('bounded and legacy hostless asks use identical scoped identities for answers and waiting', async () => {
  const nested = ['parent', 'child'];
  const key = JSON.stringify(nested);
  for (const bounded of [false, true]) {
    const runner = makeWorkflowDefinitionRunner(async () => {
      async function invoke(...args) {
        const ask = args.at(-2);
        assert.deepEqual(decode(await ask('same-name', encode({}), encode({ _runtime_identity: nested, step_id: 'child' }))), { exact: 'nested' });
        assert.deepEqual(decode(await ask('same-name', encode({}), encode({ _runtime_identity: ['single'], step_id: 'authored' }))), { exact: 'authored' });
        assert.deepEqual(decode(await ask('same-name', encode({}), encode({ _runtime_identity: ['fallback'] }))), { exact: 'fallback' });
        const waiting = decode(await ask('same-name', encode({ pending: true }), encode({ _runtime_identity: ['other', 'child'], step_id: 'child' })));
        assert.equal(waiting.step_id, JSON.stringify(['other', 'child']));
        return bounded ? response() : JSON.stringify({ status: 'paused' });
      }
      return { run: invoke, run_bounded_v1: invoke };
    });
    const request = { ...input, answers: { [key]: { exact: 'nested' }, authored: { exact: 'authored' }, fallback: { exact: 'fallback' } } };
    const value = bounded ? (await runner.runWorkflowDefinitionBounded(request, null, limits)).result : await runner.runWorkflowDefinition(request);
    assert.equal(value.waiting.length, 1);
    assert.equal(value.waiting[0].step_id, JSON.stringify(['other', 'child']));
  }
});

test('bounded replay captures both start fields before loading and retains nested runtime outputs', async () => {
  const mutable = { ...input, started_at: '2026-10-14T16:20:00.000Z', start_id: 'evt:original' };
  const timestamp = mutable.started_at;
  const startId = mutable.start_id;
  let count = 0;
  const runner = makeWorkflowDefinitionRunner(async () => {
    mutable.started_at = 'mutated'; mutable.start_id = 'mutated';
    return {
      run_bounded_v1: async () => { throw new Error('must not drop replay metadata'); },
      run_bounded_with_start_v1: async (...args) => {
        count += 1;
        assert.equal(args.length, 21);
        assert.equal(args[4], manifest.name);
        assert.equal(args[17], timestamp);
        assert.equal(args[18], startId);
        assert.equal(typeof args[19], 'function');
        assert.equal(typeof args[20], 'function');
        return replayResponse(timestamp, startId);
      },
    };
  });
  const value = await runner.runWorkflowDefinitionBounded(mutable, null, limits);
  assert.equal(count, 1);
  assert.equal(value.result.execution_context.start.start_id, startId);
  assert.equal(value.result.runtime_outputs['["parent","child"]'].output.kept, true);
});

test('a start id alone uses the replay export without inventing a start timestamp', async () => {
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_with_start_v1: async (...args) => {
      assert.equal(args[17], ''); assert.equal(args[18], 'evt:only');
      return replayResponse('', 'evt:only');
    },
  }));
  const value = await runner.runWorkflowDefinitionBounded({ ...input, start_id: 'evt:only' }, null, limits);
  assert.equal(value.result.execution_context.start.started_at, '');
});

test('replay refuses older bounded modules rather than silently dropping either start field', async () => {
  let oldCalls = 0;
  const runner = makeWorkflowDefinitionRunner(async () => ({
    run_bounded_v1: async () => { oldCalls += 1; return response(); },
    runWithStartedAt: async () => { oldCalls += 1; return '{}'; },
    run: async () => { oldCalls += 1; return '{}'; },
  }));
  for (const metadata of [{ started_at: 'original-time' }, { start_id: 'original-event' }]) {
    await assert.rejects(runner.runWorkflowDefinitionBounded({ ...input, ...metadata }, null, limits), /run_bounded_with_start_v1 is unavailable/);
  }
  assert.equal(oldCalls, 0);
});

test('bounded replay rejects a response that loses or changes the supplied start', async () => {
  const request = { ...input, started_at: 'original-time', start_id: 'original-event' };
  for (const mutation of [
    value => { value.result.started_at = 'changed'; },
    value => { value.result.start_id = 'changed'; },
    value => { value.result.execution_context.start.started_at = 'changed'; },
    value => { delete value.result.execution_context.start; },
  ]) {
    const value = JSON.parse(replayResponse(request.started_at, request.start_id)); mutation(value);
    const runner = makeWorkflowDefinitionRunner(async () => ({ run_bounded_with_start_v1: async () => JSON.stringify(value) }));
    await assert.rejects(runner.runWorkflowDefinitionBounded(request, null, limits), /changed the supplied replay start/);
  }
});

test('bounded replay rejects invalid start types before loading and invalid runtime output maps', async () => {
  let loads = 0;
  const runner = makeWorkflowDefinitionRunner(async () => { loads += 1; return {}; });
  for (const metadata of [{ started_at: 1 }, { start_id: {} }]) {
    await assert.rejects(runner.runWorkflowDefinitionBounded({ ...input, ...metadata }, null, limits), /FE_BOUNDED_REQUEST_INVALID/);
  }
  assert.equal(loads, 0);
  const bad = JSON.parse(response()); bad.result.runtime_outputs = [];
  const badRunner = makeWorkflowDefinitionRunner(async () => ({ run_bounded_v1: async () => JSON.stringify(bad) }));
  await assert.rejects(badRunner.runWorkflowDefinitionBounded(input, null, limits), /unexpected shape or identity/);
});
