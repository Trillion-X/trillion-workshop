import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

const clone = value => structuredClone(value);

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function valueAt(next, step) {
  const pick = max => Math.floor(next() * max);
  const words = ['amber', 'birch', 'cobalt', 'dune', 'elm', 'flint'];
  return {
    title: `${words[pick(words.length)]}-${step}`,
    score: pick(1000),
    details: { active: Boolean(pick(2)), note: words[pick(words.length)] },
    tags: Array.from({ length: pick(4) }, () => words[pick(words.length)]),
    events: Array.from({ length: pick(3) }, (_, index) => ({ kind: words[pick(words.length)], at: step * 10 + index })),
  };
}

function compare(store, model, context) {
  const ids = [...model.keys()].filter(id => model.get(id) !== null).sort();
  assert.deepEqual(store.ids('case'), ids, `${context}: all ids`);
  assert.deepEqual(store.ids('case', { prefix: 'case:a' }), ids.filter(id => id.startsWith('case:a')), `${context}: prefix ids`);
  for (const id of model.keys()) {
    const value = model.get(id);
    assert.deepEqual(store.read(id), value, `${context}: read ${id}`);
    assert.equal(store.typeOf(id), value === null ? null : 'case', `${context}: type ${id}`);
    const withoutEvents = value === null ? null : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'events'));
    assert.deepEqual(store.readOwn(id, ['events']), withoutEvents, `${context}: omitted read ${id}`);
  }
}

function initialValue() {
  return { title: 'created', score: 0, details: { active: false, note: 'created' }, tags: [], events: [] };
}

function applyModel(store, model, operation) {
  const { id } = operation;
  if (operation.kind === 'write') {
    store.write([{ id, type: 'case', value: clone(operation.value) }]);
    model.set(id, clone(operation.value));
  } else if (operation.kind === 'delete') {
    store.write([{ id, type: 'case', value: null }]);
    model.set(id, null);
  } else if (operation.kind === 'writeOwn') {
    if (model.get(id) === undefined || model.get(id) === null) {
      const initial = initialValue();
      store.write([{ id, type: 'case', value: clone(initial) }]);
      model.set(id, initial);
    }
    store.writeOwn(id, 'case', clone(operation.value), ['events']);
    const before = model.get(id);
    model.set(id, { ...before, ...clone(operation.value), events: before.events });
  } else if (operation.kind === 'member') {
    if (model.get(id) === undefined || model.get(id) === null) {
      const initial = initialValue();
      store.write([{ id, type: 'case', value: clone(initial) }]);
      model.set(id, initial);
    }
    const before = model.get(id);
    if (!Array.isArray(before.events)) {
      const initial = { ...before, events: [] };
      store.write([{ id, type: 'case', value: clone(initial) }]);
      model.set(id, initial);
    }
    const current = model.get(id);
    const ordinal = operation.ordinal ?? current.events.length;
    store.writeMember(id, 'case', 'events', ordinal, clone(operation.value));
    const events = current.events.slice();
    events[ordinal] = clone(operation.value);
    model.set(id, { ...current, events });
  } else if (operation.kind === 'read') {
    assert.deepEqual(store.read(id), model.get(id) ?? null, `read operation ${id}`);
  } else {
    throw new Error(`Unknown operation: ${operation.kind}`);
  }
}

test('seeded EEAF public operation sequences agree with a plain JSON reference model', t => {
  const totals = { write: 0, delete: 0, writeOwn: 0, append: 0, replace: 0, read: 0 };
  for (const seed of [0x51a7, 0xc0ffee, 0x1ee7]) {
    const host = sqliteHost(':memory:');
    const store = eeafStore(host.sql, { transaction: host.transaction, hash: text => `model:${text}` });
    const model = new Map();
    const next = random(seed);
    let step = 0;
    const run = operation => {
      applyModel(store, model, operation);
      compare(store, model, `seed=${seed} step=${step} ${operation.kind} ${operation.id}`);
      step += 1;
    };

    run({ kind: 'write', id: 'case:a', value: valueAt(next, step) });
    run({ kind: 'write', id: 'case:ab', value: valueAt(next, step) });
    run({ kind: 'member', id: 'case:a', value: { kind: 'first', at: step } });
    run({ kind: 'member', id: 'case:a', ordinal: 0, value: { kind: 'replaced', at: step } });
    run({ kind: 'writeOwn', id: 'case:a', value: { title: 'partial', score: step, details: { active: true, note: 'kept-list' }, tags: ['partial'] } });
    run({ kind: 'delete', id: 'case:ab' });
    run({ kind: 'read', id: 'case:ab' });
    totals.write += 2;
    totals.append += 1;
    totals.replace += 1;
    totals.writeOwn += 1;
    totals.delete += 1;
    totals.read += 1;

    for (let index = 0; index < 90; index += 1) {
      const id = next() < 0.5 ? 'case:a' : 'case:ab';
      const current = model.get(id);
      const action = Math.floor(next() * 6);
      if (action === 0) {
        run({ kind: 'write', id, value: valueAt(next, step) });
        totals.write += 1;
      } else if (action === 1) {
        run({ kind: 'delete', id });
        totals.delete += 1;
      } else if (action === 2) {
        run({ kind: 'writeOwn', id, value: { title: `own-${step}`, score: Math.floor(next() * 500), details: { active: Boolean(Math.floor(next() * 2)), note: 'own' }, tags: ['own'] } });
        totals.writeOwn += 1;
      } else if (action === 3) {
        run({ kind: 'member', id, value: { kind: `event-${step}`, at: step } });
        totals.append += 1;
      } else if (action === 4 && current?.events?.length) {
        run({ kind: 'member', id, ordinal: Math.floor(next() * current.events.length), value: { kind: `replacement-${step}`, at: step } });
        totals.replace += 1;
      } else {
        run({ kind: 'read', id });
        totals.read += 1;
      }
    }
    host.db.close();
  }
  assert.ok(totals.write > 0 && totals.delete > 0 && totals.writeOwn > 0 && totals.append > 0 && totals.replace > 0 && totals.read > 0,
    `seeded run missed an operation family: ${JSON.stringify(totals)}`);
  t.diagnostic(`Three fixed seeds checked ${3 * 97} operation boundaries, including replacement, deletion, omitted fields and ordered list members.`);
});

test('the model comparison rejects a deliberately broken public read adapter', () => {
  const host = sqliteHost(':memory:');
  const store = eeafStore(host.sql, { transaction: host.transaction, hash: text => `model:${text}` });
  const model = new Map([['case:mutant', { title: 'present', score: 1, details: { active: true, note: 'x' }, tags: [], events: [] }]]);
  store.write([{ id: 'case:mutant', type: 'case', value: clone(model.get('case:mutant')) }]);
  const mutant = { ...store, read: () => null };
  assert.throws(() => compare(mutant, model, 'deliberate read mutation'), assert.AssertionError);
  host.db.close();
});
