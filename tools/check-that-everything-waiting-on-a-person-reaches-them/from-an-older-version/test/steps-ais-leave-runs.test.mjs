import test from 'node:test';
import assert from 'node:assert/strict';
import { stepsAisLeaveRuns } from '../src/steps-ais-leave-runs.mjs';
import { weighStepsAisLeft } from '../src/steps-ais-leave.mjs';

const NOW = Date.parse('2026-10-11T23:00:00Z');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const reply = (id, n) => ({ speaker: 'ai', final_reply: true, app: 'Fixture AI', conversation_id: id,
  text: `Reply ${id}`, recorded_at: new Date(NOW - (10 - n) * 60000).toISOString() });

function owner({ waiting = ['w'], ask, keepFailure = null, attention = null, empty = [] } = {}) {
  const messages = new Map(['w', 'a', 'b', 'c'].map((id, n) => [id, reply(id, n)]));
  for (const id of empty) messages.get(id).text = '';
  let kept = { waiting: waiting.map(id => ({ id, recorded_at: messages.get(id).recorded_at })), silent_until: null };
  const runs = [], handed = [];
  let active = 0, maximum = 0;
  const run = stepsAisLeaveRuns(async (messageId, onDecided) => {
    runs.push(messageId); active++; maximum = Math.max(maximum, active);
    try {
      return await weighStepsAisLeft({ messageId, onDecided, fields: { after: () => [] },
        readMessage: id => messages.get(id), ask, attention, kept, keptNow: () => kept,
        keep: value => { if (keepFailure?.()) throw Error('injected keep failure'); kept = value; },
        handOff: job => { handed.push(job.once_per); return { handoff_id: job.once_per }; }, now: () => NOW });
    } finally { active--; }
  }, { readMessage: id => messages.get(id) });
  return { run, runs, handed, messages, kept: () => kept, maximum: () => maximum };
}

test('blocked ask plus two arrivals does not duplicate or restore a decided waiting reply', async () => {
  const entered = deferred(), release = deferred(), asks = [];
  const person = owner({ ask: async input => {
    asks.push(input.state);
    if (asks.length === 1) { entered.resolve(); await release.promise; }
    // The later arrival is unavailable, after the old waiting reply was decided.
    return input.state.includes('Reply b') ? null : 0.9;
  } });
  const a = person.run('a');
  await entered.promise;
  const b = person.run('b');
  const waitingEvent = person.run('w');
  const sweep = person.run();
  assert.equal(asks.length, 1, 'new events wait behind the outstanding ask instead of snapshotting its queue');
  release.resolve();
  const [answerA, answerB, waitingAnswer] = await Promise.all([a, b, waitingEvent, sweep]);
  assert.equal(person.maximum(), 1);
  assert.deepEqual(person.runs, ['a', 'b', null], 'waiting event consumes the successful batch result');
  assert.equal(waitingAnswer, answerA);
  assert.deepEqual(asks.map(text => /Reply (\w)/.exec(text)[1]), ['w', 'a', 'b']);
  assert.deepEqual(person.kept().waiting.map(row => row.id), ['b'], 'unavailable arrival cannot restore decided w');
  assert.equal(answerB.again.message_id, 'b');
  assert.ok(Date.parse(answerB.again.at) > NOW, 'unavailable answer keeps the real retry ladder');
  assert.deepEqual(person.handed, ['steps-ais-leave:w', 'steps-ais-leave:a'], 'each decided positive reply still hands on once');
});

test('a failed keep cannot consume another pending event, and later work/retry remains possible', async () => {
  const entered = deferred(), release = deferred(), asks = [];
  let fail = true;
  const person = owner({ waiting: ['w', 'b'], ask: async input => {
    asks.push(input.state);
    if (asks.length === 1) { entered.resolve(); await release.promise; }
    return 0.1;
  }, keepFailure: () => { const prior = fail; fail = false; return prior; } });
  const first = person.run('a');
  const rejected = assert.rejects(first, /injected keep failure/);
  await entered.promise;
  const b = person.run('b');
  release.resolve();
  await rejected;
  const answer = await b;
  assert.ok(answer.weighed.some(row => row.message_id === 'b'));
  assert.equal(asks.filter(text => text.includes('Reply b')).length, 2, 'failed batch never falsely acknowledges b');
  assert.deepEqual(person.kept().waiting, []);
  await person.run('a');
  assert.equal(person.maximum(), 1);
  assert.ok(person.runs.includes('b'), 'failure does not wedge the queue');
});

test('empty/context outcomes consume pending events only after successful completion', async () => {
  const entered = deferred(), release = deferred();
  const person = owner({ waiting: ['w', 'b'], empty: ['b'], attention: async row => {
    if (row.id === 'w') { entered.resolve(); await release.promise; }
    return { opens: false };
  }, ask: () => assert.fail('context must not ask a classifier') });
  const a = person.run('a'); await entered.promise;
  const w = person.run('w'), b = person.run('b'); release.resolve();
  const result = await a;
  assert.equal(await w, result);
  assert.equal(await b, result);
  assert.deepEqual(person.runs, ['a']);
  assert.deepEqual(person.kept().waiting, []);
  assert.deepEqual(person.handed, []);
});

test('queued sweeps coalesce; arrivals during an active sweep retain one following sweep and fresh reply priority', async () => {
  const entered = deferred(), release = deferred(), calls = [];
  const run = stepsAisLeaveRuns(async id => {
    calls.push(id);
    if (calls.length === 1) { entered.resolve(); await release.promise; }
    return { id };
  }, { readMessage: id => ({ text: id }) });
  const first = run(); await entered.promise;
  const later = run(), duplicate = run(), fresh = run('fresh');
  assert.equal(later, duplicate, 'queued sweeps share one result');
  release.resolve();
  await Promise.all([first, later, duplicate, fresh]);
  assert.deepEqual(calls, [null, 'fresh', null]);
});

test('same-ID edited source arriving during an ask is weighed as new evidence', async () => {
  const entered = deferred(), release = deferred(), asks = [];
  const person = owner({ ask: async input => {
    asks.push(input.state);
    if (asks.length === 1) { entered.resolve(); await release.promise; }
    return 0.1;
  } });
  const first = person.run('a'); await entered.promise;
  person.messages.set('w', { ...person.messages.get('w'), text: 'Edited Reply w', reworded_at: new Date(NOW).toISOString() });
  const edited = person.run('w');
  release.resolve(); await Promise.all([first, edited]);
  assert.deepEqual(person.runs, ['a', 'w'], 'older waiting result cannot consume a new source revision');
  assert.equal(asks.length, 3);
  assert.ok(asks[0].includes('Reply w') && !asks[0].includes('Edited'));
  assert.ok(asks[2].includes('Edited Reply w'));
  assert.deepEqual(person.kept().waiting, []);
});

test('one person blocked does not block another person, and new owner resumes durable waiting', async () => {
  const entered = deferred(), release = deferred();
  const a = owner({ ask: async () => { entered.resolve(); await release.promise; return 0.1; } });
  const pending = a.run('a'); await entered.promise;
  const b = owner({ ask: async () => 0.1 });
  assert.equal((await b.run('b')).weighed.length, 2);
  const reopened = owner({ waiting: ['w', 'c'], ask: async () => 0.1 });
  const recovered = await reopened.run('c');
  assert.deepEqual(recovered.weighed.map(row => row.message_id), ['w', 'c']);
  release.resolve(); await pending;
});

test('an immediate continuation can enqueue behind the current batch without starting a nested classification', async () => {
  const calls = [], continuation = deferred();
  const run = stepsAisLeaveRuns(async id => {
    calls.push(id);
    if (id === 'first') {
      // Workshop wait_seconds:0 accepts the durable next task without awaiting its result.
      const next = run('rest'); next.then(continuation.resolve, continuation.reject);
      return { again: 'rest' };
    }
    return { done: id };
  }, { readMessage: id => ({ text: id }) });
  assert.deepEqual(await run('first'), { again: 'rest' });
  assert.deepEqual(await continuation.promise, { done: 'rest' });
  assert.deepEqual(calls, ['first', 'rest']);
});
