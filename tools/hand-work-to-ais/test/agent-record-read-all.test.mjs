import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRecordStore } from '../agent-records.mjs';
import { keepContentJson } from '../../serialized-content/do-work/content-json.mjs';

const card = (id, extra = {}) => ({ agent_id: id, delivery: { url: `https://${id}.example/events` }, ...extra });
const job = id => ({ handoff_id: id, handed_at: '2026-10-12T01:00:00Z', state: 'finished',
  details: { values: [1, 2] }, result_record: `agent-handoff-result:${id}`, found_by: { private: true } });
function fixture({ batch = true, legacy = [] } = {}) {
  const values = new Map([
    ['agent-card:a', card('a')], ['agent-card:b', card('b')],
    ['agent-handoff:h', job('h')], ['agent-handoff-result:h', { json: '{"answer":[1,2]}' }],
  ]);
  let failure = null;
  const point = [], grouped = [];
  const records = {
    read: id => { point.push(id); return structuredClone(values.get(id) ?? null); },
    scan: (type, name) => type === 'agent-card' ? [{ id: 'agent-card:b' }, { id: 'agent-card:gone' }, { id: 'agent-card:a' }]
      : [{ id: 'agent-handoff:h' }, { id: 'agent-handoff:gone' }],
    ...(batch ? { readMany: ids => {
      grouped.push([...ids]);
      if (failure) throw failure;
      return new Map([...new Set(ids)].map(id => [id, structuredClone(values.get(id) ?? null)]));
    } } : {}),
  };
  const store = agentRecordStore({ records, firstRows: table => table === 'agent_cards' ? legacy.map(value => ({ value })) : [] });
  return { store, point, grouped, fail: value => { failure = value; } };
}

test('selected card hydration preserves index order, missing roots and legacy rows through the existing batch owner', () => {
  const f = fixture({ legacy: [card('old'), { agent_id: 'unreachable' }] });
  const actual = f.store.reachableCards();
  assert.deepEqual(actual.map(row => row.agent_id), ['b', 'a', 'old']);
  assert.deepEqual(f.grouped, [['agent-card:b', 'agent-card:gone', 'agent-card:a']]);
  assert.deepEqual(f.point, []);
  actual[0].delivery.url = 'caller mutation';
  assert.equal(f.store.reachableCards()[0].delivery.url, 'https://b.example/events');
});

test('overlapping message indexes preserve duplicate outward objects and saved content expansion', () => {
  const f = fixture();
  const actual = f.store.fromMessage('message');
  assert.equal(actual.length, 2);
  assert.deepEqual(actual.map(row => row.handoff_id), ['h', 'h']);
  assert.deepEqual(actual[0].result, { answer: [1, 2] });
  assert.equal('result_record' in actual[0], false);
  assert.equal('found_by' in actual[0], false);
  actual[0].details.values[0] = 99;
  actual[0].result.answer[0] = 99;
  assert.deepEqual(actual[1].details.values, [1, 2]);
  assert.deepEqual(actual[1].result.answer, [1, 2]);
  assert.deepEqual(f.grouped, [['agent-handoff:h', 'agent-handoff:gone', 'agent-handoff:h', 'agent-handoff:gone'],
    ['agent-handoff-result:h']]);
  assert.deepEqual(f.point, [], 'selected saved content uses the same grouped record owner');
});

test('hosts without grouped reads retain scalar owner and legacy bridge semantics', () => {
  const f = fixture({ batch: false, legacy: [card('old')] });
  assert.deepEqual(f.store.reachableCards().map(row => row.agent_id), ['b', 'a', 'old']);
  assert.deepEqual(f.point, ['agent-card:b', 'agent-card:gone', 'agent-card:a']);
  assert.deepEqual(f.grouped, []);
});

test('grouped refusal remains an atomic failure and the same store retries without an extra scalar fallback', () => {
  const f = fixture();
  const error = new Error('the store was reset');
  f.fail(error);
  assert.throws(() => f.store.reachableCards(), caught => caught === error);
  assert.deepEqual(f.point, []);
  f.fail(null);
  assert.deepEqual(f.store.reachableCards().map(row => row.agent_id), ['b', 'a']);
});


test('selected reads preserve the current transaction values before commit and discard a refused transaction', () => {
  const values = new Map();
  const selections = [];
  const records = {
    scan: () => [{ id: 'agent-handoff:h', values: [1, 'mac'] }],
    typeOf: id => values.has(id) ? 'agent-handoff' : null,
    read: id => structuredClone(values.get(id) ?? null),
    readMany: ids => { selections.push([...ids]); return new Map(ids.map(id => [id, structuredClone(values.get(id) ?? null)])); },
    write: rows => { for (const row of rows) { if (row.value === null) values.delete(row.id); else values.set(row.id, structuredClone(row.value)); } },
  };
  const transaction = fn => {
    const previous = new Map(values);
    try { return fn(); }
    catch (error) { values.clear(); for (const [id, value] of previous) values.set(id, value); throw error; }
  };
  const store = agentRecordStore({ records, transaction, heldSummaryReady: () => false });
  store.transaction(() => {
    store.putHandoff({ ...job('h'), result_record: undefined, state: 'open', to_agent: 'mac', job: 'new transaction value' });
    assert.equal(store.openAddressedTo('mac')[0].job, 'new transaction value');
  });
  assert.throws(() => store.transaction(() => {
    store.putHandoff({ ...store.handoff('h'), job: 'refused value' });
    assert.equal(store.openAddressedTo('mac')[0].job, 'refused value');
    throw new Error('stop');
  }), /stop/);
  assert.equal(store.openAddressedTo('mac')[0].job, 'new transaction value');
  assert.ok(selections.length >= 3);
});


test('batched handoff roots retain exact compressed saved results and refuse missing content', () => {
  const result = { text: 'saved original '.repeat(700), values: [1, 2, 3] };
  const payload = keepContentJson(JSON.stringify(result));
  assert.equal(payload.json_encoding, 'json-gzip-base64/v1');
  let available = true;
  const saved = id => id === 'agent-handoff:h' ? job('h')
    : id === 'agent-handoff-result:h' && available ? structuredClone(payload) : null;
  const records = {
    scan: () => [{ id: 'agent-handoff:h' }],
    readMany: ids => new Map(ids.map(id => [id, saved(id)])),
    read: saved,
  };
  const store = agentRecordStore({ records });
  assert.deepEqual(store.fromMessage('message')[0].result, result);
  available = false;
  assert.throws(() => store.fromMessage('message'), /Saved handoff content is unavailable/);
  available = true;
  assert.deepEqual(store.fromMessage('message')[0].result, result);
});
