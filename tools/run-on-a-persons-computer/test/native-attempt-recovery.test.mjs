import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macTools, MacToolsHttpError } from '../mac-tools.mjs';
import { nativeResultOutbox } from '../native-result-outbox.mjs';

const settings = { agent: { agent_id: 'computer-tools' }, tools: {}, capacity: { max_concurrent: 1 }, take_gap_ms: 0, renew_minutes: 30, live_retry_ms: [] };
const connect = () => ({ addEventListener() {} });
const identity = '1f:' + 'a'.repeat(64);
const job = { handoff: { handoff_id: 'h_attempt', input: { tool_id: 'synthetic-tool', input: { private: 'private-input' } } }, generation: 4 };

async function withOutbox(work) {
  const folder = await mkdtemp(join(tmpdir(), 'native-attempt-'));
  const open = (accountId = 'synthetic-account', origin = 'https://example.test') => nativeResultOutbox({ file: join(folder, 'attempt'), accountId, origin });
  try { await work(open); } finally { await rm(folder, { recursive: true, force: true }); }
}

function offerOnce(other = async path => { throw Error('Unexpected call ' + path); }) {
  let offered = false;
  return async (path, body) => {
    if (path !== '/handoffs/take') return other(path, body);
    if (!offered) { offered = true; return job; }
    return { handoff: null, held: [{ handoff_id: job.handoff.handoff_id, generation: job.generation }] };
  };
}

test('dispatch marker is durable before execution and an interrupted attempt never runs or finishes after restart', async () => {
  await withOutbox(async open => {
    let executed = 0, finished = 0;
    const first = macTools({ settings, connect, resultOutbox: open(), call: offerOnce(async () => { finished++; return {}; }),
      context: { key: 'private-credential' }, execute: async () => {
        executed++;
        const kept = open().get(job.handoff.handoff_id);
        assert.equal(kept.execution.state, 'started');
        assert.equal(kept.generation, 4);
        assert.equal(Object.hasOwn(kept.finish, 'result'), false);
        assert.equal(JSON.stringify(kept).includes('private-input'), false);
        assert.equal(JSON.stringify(kept).includes('private-credential'), false);
        throw Error('simulated process stop');
      } });
    await first.takeAll();
    assert.equal(executed, 1);
    assert.equal(finished, 0);
    assert.equal(open().get(job.handoff.handoff_id).execution.state, 'started');
    for (const generation of [4, 5]) {
      let offered = false;
      const host = macTools({ settings, connect, resultOutbox: open(),
        call: async path => {
          assert.equal(path, '/handoffs/take', 'partial evidence is never a finish');
          if (!offered) { offered = true; return { ...job, generation }; }
          return { handoff: null, held: [{ handoff_id: job.handoff.handoff_id, generation }] };
        }, execute: async () => { executed++; throw Error('uncertain attempt replay'); } });
      for (let revision = 0; revision < 5; revision++) await host.takeAll();
    }
    assert.equal(executed, 1);
    assert.equal(open().get(job.handoff.handoff_id).generation, 4, 'a later lease cannot relabel uncertain evidence');
    assert.deepEqual(open('another-account').list(), []);
    assert.deepEqual(open('synthetic-account', 'https://other.example.test').list(), []);
  });
});

test('partial step history and output identities survive a stop without keeping responses, arguments or workspace paths', async () => {
  await withOutbox(async open => {
    const host = macTools({ settings, connect, resultOutbox: open(), call: offerOnce(), execute: async (_settings, _input, context) => {
      context.recordProgress({ stage: 'app-step-starting', step: 0, total_steps: 2, args: { secret: 'private-input' } });
      context.recordProgress({ stage: 'app-step-returned', step: 0, total_steps: 2, returned_steps: 1, ok: true, answer: { secret: 'private-response' } });
      context.recordProgress({ stage: 'app-output-saved', saved_outputs: 1, file: { identity, bytes: 17, path: '/private/workspace' } });
      context.recordProgress({ stage: 'app-step-starting', step: 1, total_steps: 2, returned_steps: 1 });
      context.recordProgress({ stage: 'app-step-uncertain', step: 1, total_steps: 2, returned_steps: 1, uncertain: true });
      throw Error('simulated process stop');
    } });
    await host.takeAll();
    const kept = open().get(job.handoff.handoff_id);
    assert.deepEqual(kept.execution.steps, [
      { step: 0, stage: 'app-step-returned', ok: true }, { step: 1, stage: 'app-step-uncertain', uncertain: true },
    ]);
    assert.deepEqual(kept.execution.files, [{ identity, bytes: 17 }]);
    assert.equal(kept.execution.uncertain, true);
    assert.equal(JSON.stringify(kept).includes('private-'), false);
    assert.equal(JSON.stringify(kept).includes('/private/workspace'), false);
    assert.equal(Object.hasOwn(kept.finish, 'result'), false);
  });
});

test('an uncertain returned diagnosis does not become a completed result or finish request', async () => {
  await withOutbox(async open => {
    const host = macTools({ settings, connect, resultOutbox: open(), call: offerOnce(), execute: async (_settings, _input, context) => {
      context.recordProgress({ stage: 'app-step-uncertain', step: 0, uncertain: true });
      return { error: 'reply lost', uncertain: true, answer: { private: 'private-response' } };
    } });
    await host.takeAll();
    const kept = open().get(job.handoff.handoff_id);
    assert.equal(kept.execution.state, 'started');
    assert.equal(Object.hasOwn(kept.finish, 'result'), false);
    assert.equal(JSON.stringify(kept).includes('private-response'), false);
  });
});

test('effect settlement is durable before the service call and a lost reply is recovered without finishing or dispatching', async () => {
  await withOutbox(async open => {
    let accept = false, settlements = 0, executed = 0;
    const effect = { effect_id: 'app-job-step:0', state: 'done', receipt: { step: 0, returned: true, ok: true } };
    const call = offerOnce(async (path, body) => {
      assert.equal(path, '/handoffs/effect');
      settlements++;
      assert.deepEqual(open().get(job.handoff.handoff_id).effect_updates[0], body, 'settlement is already on disk');
      if (!accept) throw new MacToolsHttpError(path, 503, 'settlement reply lost');
      return {};
    });
    const host = macTools({ settings, connect, resultOutbox: open(), call, execute: async (_settings, _input, context) => {
      executed++;
      const pending = await context.recordEffect(effect);
      assert.equal(pending.pending, true);
      throw Error('simulated process stop');
    } });
    await host.takeAll();
    assert.ok(settlements >= 1);
    assert.equal(open().get(job.handoff.handoff_id).effect_updates.length, 1);
    accept = true;
    const restarted = macTools({ settings, connect, resultOutbox: open(), call, execute: async () => { executed++; throw Error('do not dispatch again'); } });
    await restarted.takeAll();
    assert.equal(executed, 1);
    assert.deepEqual(open().get(job.handoff.handoff_id).effect_updates, []);
    assert.equal(open().get(job.handoff.handoff_id).execution.state, 'started');
  });
});

test('a complete result still retries delivery after restart and deletes only an accepted answer', async () => {
  await withOutbox(async open => {
    let executed = 0, finished = 0;
    const result = { ok: true, answer: { completed: true } };
    const call = offerOnce(async (path, body) => {
      assert.equal(path, '/handoffs/finish');
      assert.deepEqual(body.result, result);
      if (++finished === 1) throw new MacToolsHttpError(path, 503, 'finish reply lost');
      return {};
    });
    const host = macTools({ settings, connect, resultOutbox: open(), call, execute: async () => { executed++; return result; } });
    await host.takeAll();
    // The host may retry on its own completed take cycle; either path retains the exact answer and never reruns it.
    if (open().get(job.handoff.handoff_id)) {
      assert.equal(open().get(job.handoff.handoff_id).execution.state, 'returned');
      const restarted = macTools({ settings, connect, resultOutbox: open(), call, execute: async () => { executed++; throw Error('completed result replay'); } });
      await restarted.takeAll();
    }
    assert.equal(executed, 1);
    assert.equal(finished, 2);
    assert.deepEqual(open().list(), []);
  });
});

test('failure to persist a dispatch marker prevents execution', async () => {
  let executed = 0;
  const host = macTools({ settings, connect, call: offerOnce(), resultOutbox: {
    list: () => [], get: () => null, put: () => { throw Error('durable storage unavailable'); },
  }, execute: async () => { executed++; return {}; } });
  await host.takeAll();
  assert.equal(executed, 0);
});


test('a swallowed executor error cannot turn an unanswered dispatch into a completed failure', async () => {
  await withOutbox(async open => {
    const host = macTools({ settings, connect, resultOutbox: open(), call: offerOnce(), execute: async (_settings, _input, context) => {
      context.recordProgress({ stage: 'app-step-starting', step: 0, total_steps: 1 });
      return { error: 'the shared executor caught an error before a confirmed reply' };
    } });
    await host.takeAll();
    const kept = open().get(job.handoff.handoff_id);
    assert.equal(kept.execution.state, 'started');
    assert.equal(kept.execution.uncertain, true);
    assert.equal(Object.hasOwn(kept.finish, 'result'), false);
  });
});
