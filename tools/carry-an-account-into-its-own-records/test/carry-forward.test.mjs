// Carrying a person's earlier store into the EEAF tables keeps every record and every earlier value, each at the
// time it was first written, and refuses to finish when anything would read back differently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { carryForward, earlierWrites } from '../src/carry-forward.mjs';

// An earlier store as both earlier shapes left it: one case written as documents first (changes), then carried
// into entity facts, then changed as facts; a pursuit written only as facts; and settings.
const earlier = {
  changes: [
    { at: '2026-09-20T10:00:00.000Z', case_id: 'source:a', record: JSON.stringify({ id: 'source:a', input: { goal: 'first goal' }, scratchpad: [] }) },
    { at: '2026-09-20T11:00:00.000Z', case_id: 'source:a', record: JSON.stringify({ id: 'source:a', input: { goal: 'second goal' }, scratchpad: [{ text: 'n1' }] }) },
  ],
  links: [
    { entity: 'source:a', of_entity: null, of_attribute: null, position: null },
    { entity: 'source:a/scratchpad/0', of_entity: 'source:a', of_attribute: 'scratchpad', position: 0 },
    { entity: 'source:a/scratchpad/1', of_entity: 'source:a', of_attribute: 'scratchpad', position: 1 },
    { entity: 'pursuit:fit', of_entity: null, of_attribute: null, position: null },
  ],
  facts: [
    { at: '2026-09-21T00:00:00.000Z', entity: 'source:a', attribute: 'id', value: '"source:a"' },
    { at: '2026-09-21T00:00:00.000Z', entity: 'source:a', attribute: 'input', value: '{"goal":"second goal"}' },
    { at: '2026-09-21T00:00:00.000Z', entity: 'source:a/scratchpad/0', attribute: 'text', value: '"n1"' },
    { at: '2026-09-22T00:00:00.000Z', entity: 'source:a/scratchpad/1', attribute: 'text', value: '"n2"' },
    { at: '2026-09-22T00:00:00.000Z', entity: 'pursuit:fit', attribute: 'kind', value: '"pursuit"' },
    { at: '2026-09-22T00:00:00.000Z', entity: 'pursuit:fit', attribute: 'title', value: '"Fit"' },
    { at: '2026-09-23T00:00:00.000Z', entity: 'pursuit:fit', attribute: 'title', value: '"Fitter"' },
  ],
};
const settings = [{ name: 'plan', value: { reads_history: true } }, { name: 'shared:source:a', value: { shared: false, reason: 'off' } }];

test('every record, every earlier value and every setting is carried, each at its original time', () => {
  const store = localStore(':memory:');
  const result = carryForward(store, earlier, settings);
  assert.deepEqual(result, { writes: earlierWrites(earlier).length, records: 2, settings: 2 });
  assert.deepEqual(store.read(), {
    cases: { 'source:a': { id: 'source:a', input: { goal: 'second goal' }, scratchpad: [{ text: 'n1' }, { text: 'n2' }] } },
    pursuits: { 'pursuit:fit': { kind: 'pursuit', title: 'Fitter' } },
  });
  const goal = store.eeaf.valuesAt('source:a', ['input', 'goal']);
  assert.deepEqual(goal.map(row => [row.application_time, row.value]), [['2026-09-20T10:00:00.000Z', 'first goal'], ['2026-09-20T11:00:00.000Z', 'second goal']]);
  const title = store.eeaf.valuesAt('pursuit:fit', ['title']);
  assert.deepEqual(title.map(row => [row.application_time, row.value]), [['2026-09-22T00:00:00.000Z', 'Fit'], ['2026-09-23T00:00:00.000Z', 'Fitter']]);
  assert.deepEqual(store.setting('plan'), { reads_history: true });
  assert.deepEqual(store.settings('shared:').map(item => item.name), ['shared:source:a']);
});

test('a carry that would read back differently is refused, so the earlier store is never removed on a bad copy', () => {
  const store = localStore(':memory:');
  const read = store.eeaf.read;
  store.eeaf.read = id => { const value = read(id); if (value?.scratchpad) value.scratchpad.pop(); return value; };
  assert.throws(() => carryForward(store, earlier, settings), /changed it; the earlier store is kept/);
});
