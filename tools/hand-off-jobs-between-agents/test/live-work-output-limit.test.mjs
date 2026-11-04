import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { liveWork, LiveWorkError } from '../src/live-work.mjs';

test('a result over the limit leaves the job taken so the AI can retry with the complete answer', () => {
  const host = sqliteHost(':memory:');
  const work = liveWork({ sql: host.sql, result_max: 10 });
  work.put({ asked_id: 'job-1', job: 'Answer the question' });
  work.take({ handoff_id: 'job-1', agent_id: 'agent-1' });

  assert.throws(() => work.finish({ handoff_id: 'job-1', agent_id: 'agent-1', result: 'eleven chars' }), error =>
    error instanceof LiveWorkError && /at most 10 characters/.test(error.message));
  assert.equal(work.list()[0].state, 'taken');
  assert.equal(work.list()[0].result, null);

  assert.throws(() => work.finish({ handoff_id: 'job-1', agent_id: 'agent-1', result: { long: 'value' } }),
    /at most 10 characters/);
  assert.equal(work.list()[0].state, 'taken');

  const finished = work.finish({ handoff_id: 'job-1', agent_id: 'agent-1', result: { x: 1 } });
  assert.equal(finished.handoff.state, 'finished');
  assert.deepEqual(finished.handoff.result, { x: 1 });
});

test('an oversized summary cannot finish a job with partial words', () => {
  const host = sqliteHost(':memory:');
  const work = liveWork({ sql: host.sql });
  work.put({ asked_id: 'job-2', job: 'Report the result' });
  work.take({ handoff_id: 'job-2', agent_id: 'agent-1' });

  assert.throws(() => work.finish({ handoff_id: 'job-2', agent_id: 'agent-1', result: 'done', summary: 'x'.repeat(2001) }),
    /summary is too long/);
  assert.equal(work.list()[0].state, 'taken');
  assert.equal(work.list()[0].result, null);

  const finished = work.finish({ handoff_id: 'job-2', agent_id: 'agent-1', result: 'done', summary: 'Brief result' });
  assert.equal(finished.handoff.state, 'finished');
  assert.equal(finished.handoff.summary, 'Brief result');
});
