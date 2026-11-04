import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords } from '../src/record-engine.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { makeAgents, handoffIdFor } from '../../shared-code/src/agents.mjs';
import { asksForYourAis } from '../../see-and-limit-what-each-ai-can-reach/src/asks-for-your-ais.mjs';

const input = text => ({ messages: [{ role: 'user', content: text }], max_tokens: 100 });
const sender = 'trillion-model-road';
function fixture({ cap = 50, dispatch = null } = {}) {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const store = agentRecordStore({ records, transaction: host.transaction });
  let at = Date.parse('2026-10-07T23:00:00Z'), asks;
  const finished = [], withdrawn = [], dispatchKeys = [];
  const agents = makeAgents({ store, now: () => new Date(at), checkFinish: item => asks.checkFinish(item),
    onFinished: item => finished.push(item), onWithdrawn: item => withdrawn.push(item) });
  const open = () => store.openHandoffs({}).filter(item => item.from_agent === sender);
  const create = () => asks = asksForYourAis(host.sql, { settings: { most_waiting: cap, keep_days: 7 }, now: () => at,
    work: {
      read: key => store.handoff(handoffIdFor(key)),
      create: key => { dispatchKeys.push(key); return dispatch?.(key, agents) ?? agents.handOff({ request_key: key, job: 'Answer all waiting model asks', from_agent: sender }).handoff; },
      retire: handoff_id => agents.withdraw({ handoff_id, by: sender, reason: 'No asks remain', summary: 'No asks remain' }, { only_if_idle: true }),
    } });
  create();
  agents.publish({ agent_id: 'test-ai', name: 'Test AI', description: 'Answers model asks', takes_work: true });
  return { host, store, agents, finished, withdrawn, dispatchKeys, open, create,
    get asks() { return asks; },
    wait: text => { at++; return asks.wait('awareness', input(text)); },
    answerAll: () => { for (const item of asks.waiting(50)) asks.answer(item.id, 'Answer', 'test-ai'); },
    take: () => agents.take({ handoff_id: open()[0].handoff_id, agent_id: 'test-ai' }),
    finish: taken => agents.finish({ handoff_id: taken.handoff.handoff_id, agent_id: 'test-ai', generation: taken.generation, result: 'All pending model asks have been answered.' }),
  };
}

test('one aggregate survives repeated asks, retention-cap churn, and owner restarts', () => {
  const f = fixture(); f.wait('first'); const id = f.open()[0].handoff_id;
  for (let i = 0; i < 100; i++) f.wait('first');
  assert.equal(f.asks.waiting(50).length, 1);
  for (let i = 0; i < 100; i++) { if (i === 40) f.create(); f.wait(`new ${i}`); }
  assert.equal(f.asks.waiting(50).length, 50);
  assert.deepEqual(f.open().map(item => item.handoff_id), [id]);
  assert.equal(f.dispatchKeys.length, 1);
});

test('answering the oldest ask does not create another aggregate when another ask arrives', () => {
  const f = fixture(); f.wait('first'); f.wait('second'); const id = f.open()[0].handoff_id;
  f.asks.answer(f.asks.waiting()[0].id, 'Answer', 'test-ai'); f.wait('third');
  assert.deepEqual(f.open().map(item => item.handoff_id), [id]);
  assert.equal(f.asks.waiting().length, 2);
});

test('a failed or lost dispatch answer retries the same durable batch key', () => {
  let fail = true;
  const f = fixture({ dispatch: (key, agents) => {
    if (fail) { fail = false; throw new Error('dispatch refused'); }
    return agents.handOff({ request_key: key, job: 'Answer all waiting model asks', from_agent: sender }).handoff;
  } });
  assert.throws(() => f.wait('first'), /dispatch refused/);
  const key = f.dispatchKeys[0]; f.create(); f.wait('first');
  assert.deepEqual(f.dispatchKeys, [key, key]); assert.equal(f.open().length, 1);
  let lose = true;
  const g = fixture({ dispatch: (request_key, agents) => {
    const result = agents.handOff({ request_key, job: 'Answer all waiting model asks', from_agent: sender }).handoff;
    if (lose) { lose = false; throw new Error('answer lost'); } return result;
  } });
  assert.throws(() => g.wait('first'), /answer lost/);
  g.create(); g.wait('first'); assert.equal(g.dispatchKeys.length, 1); assert.equal(g.open().length, 1);
});

test('a drained unheld batch is withdrawn truthfully and a later batch has a fresh identity', () => {
  const f = fixture(); f.wait('first'); const first = f.open()[0].handoff_id;
  f.answerAll();
  assert.equal(f.open().length, 0); assert.equal(f.finished.length, 0); assert.equal(f.withdrawn.length, 1);
  assert.equal(f.store.handoff(first).result.state, 'withdrawn');
  f.create(); f.wait('later'); assert.equal(f.open().length, 1); assert.notEqual(f.open()[0].handoff_id, first);
});

test('held work is preserved; new asks during it prevent finish at the shared write boundary', () => {
  const f = fixture(); f.wait('first'); const taken = f.take();
  f.answerAll(); assert.equal(f.store.handoff(taken.handoff.handoff_id).state, 'taken');
  f.wait('arrived while held'); assert.equal(f.open().length, 1);
  assert.throws(() => f.finish(taken), error => error.next_call?.tool === 'model_asks_waiting');
  assert.equal(f.store.handoff(taken.handoff.handoff_id).state, 'taken');
  f.answerAll(); f.finish(taken); assert.equal(f.finished.length, 1);
  f.wait('later batch'); assert.equal(f.open().length, 1); assert.notEqual(f.open()[0].handoff_id, taken.handoff.handoff_id);
});

test('waiting closure cannot bypass the aggregate completion check', () => {
  const f = fixture(); f.wait('still pending'); const id = f.open()[0].handoff_id;
  assert.throws(() => f.agents.closeWaiting({ handoff_id: id, by: 'test-ai', result: 'Done' }), /Model asks still wait/);
  assert.equal(f.store.handoff(id).state, 'open');
});

test('a recovered route retires only its captured pending incarnation', () => {
  const f = fixture({ cap: 1 }); f.wait('same'); const before = f.asks.pending(input('same'));
  f.wait('other'); f.wait('same'); const after = f.asks.pending(input('same'));
  assert.notEqual(before.pending_key, after.pending_key);
  f.asks.resolve(before); assert.equal(f.asks.waiting().length, 1);
  f.asks.resolve(after); assert.equal(f.asks.waiting().length, 0); assert.equal(f.open().length, 0);
});

test('a concurrent subscription answer is not deleted by a later device result', () => {
  const f = fixture(); const first = f.wait('same'), pending = f.asks.pending(input('same'));
  f.asks.answer(first.id, 'Subscription answer', 'test-ai'); f.asks.resolve(pending);
  assert.equal(f.asks.answered(input('same')).reply, 'Subscription answer');
});

test('explicit withdrawal stays closed for unchanged retries and a later new ask can start a new batch', () => {
  const f = fixture(); f.wait('first'); const old = f.open()[0];
  f.agents.withdrawWaiting({ handoff_id: old.handoff_id, revision: old.revision, reason: 'Stop this batch' }, { person: true });
  f.create(); f.wait('first'); assert.equal(f.open().length, 0);
  f.wait('new input'); assert.equal(f.open().length, 1); assert.notEqual(f.open()[0].handoff_id, old.handoff_id);
});

for (const protectedBy of ['effect', 'part', 'dependent', 'named receiver', 'reservation']) test(`idle retirement preserves ${protectedBy}`, () => {
  const f = fixture(); f.wait('first'); const id = f.open()[0].handoff_id;
  if (protectedBy === 'effect') {
    const taken = f.take(); f.agents.recordEffect({ handoff_id: id, agent_id: 'test-ai', generation: taken.generation, effect_id: 'external', state: 'starting' });
    f.agents.release({ handoff_id: id, agent_id: 'test-ai', generation: taken.generation });
  } else if (protectedBy === 'part') f.agents.handOff({ request_key: 'part', job: 'Child work', parent_handoff_id: id });
  else if (protectedBy === 'dependent') f.agents.handOff({ request_key: 'dependent', job: 'Dependent work', depends_on: [id] });
  else if (protectedBy === 'named receiver') f.store.putHandoff({ ...f.store.handoff(id), to_agent: 'test-ai' });
  else f.store.putHandoff({ ...f.store.handoff(id), closing: { token: 'reserved' } });
  f.answerAll(); assert.equal(f.store.handoff(id).state, 'open'); assert.equal(f.withdrawn.length, 0);
});

test('safe retirement retains sender authority and does not touch unlinked legacy lookalikes', () => {
  const f = fixture();
  const legacy = f.agents.handOff({ request_key: 'legacy-model-batch', job: 'Answer all waiting model asks', from_agent: sender }).handoff;
  f.wait('first'); const own = f.open().find(item => item.handoff_id !== legacy.handoff_id);
  assert.throws(() => f.agents.withdraw({ handoff_id: own.handoff_id, by: 'somebody else', reason: 'No asks' }, { only_if_idle: true }), /Only trillion-model-road/);
  f.answerAll(); assert.equal(f.store.handoff(legacy.handoff_id).state, 'open');
  assert.equal(f.store.handoff(own.handoff_id).result.state, 'withdrawn');
});
