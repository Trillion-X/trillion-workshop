// The two tool rows that run the person's release rules today, run the way the container runs a row (test-helpers/run-a-row.mjs):
// tool:set-release-rules over the person's setting:release_rules, and tool:plan-storage-release over the items their AI read from the
// files door. The old tool ids (the three descriptors of the older repository's records/workshop-storage-release-tool-records.json at 5dc302be37,
// kept in ../records/) are each answered by a row, a written-and-tested function, or an engine verb named in ../README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const old = read('../records/old-storage-release-tool-descriptors.json').records.map(row => row.payload.id);
const rows = read('../tool-rows.json').records.map(row => row.payload);
const byId = Object.fromEntries(rows.map(row => [row.id, row]));
const setRow = byId['tool:set-release-rules'];
const planRow = byId['tool:plan-storage-release'];
const last = run => JSON.parse(run.stdout.trim().split('\n').at(-1));
const group = (field, operator, params) => ({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field, operator, params }] });
const item = (id, bytes, days, extra = {}) => ({ id, label: id, state: 'deleted', byte_length: bytes, set_aside_at: new Date(Date.parse('2026-11-10T09:00:00Z') - days * 86400000).toISOString(), due_at: null, where: '/', by: 'me', name_count: 1, folder: false, names: [`/${id}`], ...extra });

test('the three old tool ids are known and each is answered', () => {
  assert.deepEqual(old.sort(), ['tool:read-storage', 'tool:release-deleted-files', 'tool:set-release-rules']);
  assert.ok(setRow && planRow);
  assert.match(planRow.description, /queue_release/);
});

test('set release rules checks the list, keeps it as setting:release_rules and hands back the rules and what a rule can name', async () => {
  const rules = [{ id: 'big', label: 'Big files', when: group('size', 'greater_than', { value: 1e9 }), after_days: 7 }];
  const run = await runRow(setRow, { rules }, { records: [{ id: 'setting:release_rules', type: 'setting', value: { value: [], label: 'mine' } }] });
  assert.equal(run.code, 0, run.stderr);
  const { result } = last(run);
  assert.deepEqual(result.rules.map(row => [row.id, row.on, row.after_days, row.order]), [['big', true, 7, 'oldest']]);
  assert.ok(result.item_facts.some(fact => fact.id === 'size') && result.orders.length === 2 && result.choices.after_days.length);
  assert.deepEqual(result.keep, [{ id: 'setting:release_rules', type: 'setting', value: { value: result.rules, label: 'mine' } }]);
  const none = last(await runRow(setRow, { rules }, { records: [] })).result;
  assert.equal(none.keep[0].id, 'setting:release_rules');
  const same = last(await runRow(setRow, {}, { records: [{ id: 'setting:release_rules', type: 'setting', value: { value: rules.map(row => ({ ...row, on: true, storage_above_bytes: null, order: 'oldest' })) } }] })).result;
  assert.equal(same.keep, undefined);
  assert.equal(same.rules[0].id, 'big');
});

test('rows that cannot be used are refused with words and nothing is written', async () => {
  for (const rules of [[{ id: 'a', when: null }], [{ when: null, after_days: -1 }], [{ id: 'a', when: null, after_days: 1 }, { id: 'a', when: null, after_days: 2 }], [{ when: null, after_days: 1, order: 'sideways' }], 'nope']) {
    const run = await runRow(setRow, { rules }, { records: [] });
    assert.equal(run.code, 1, JSON.stringify(rules));
    assert.ok(last(run).error.length > 10);
  }
});

test('plan says what leaves now and when the rest leaves, by the saved rules or by rules given for one run', async () => {
  const items = [item('big.zip', 50e9, 6), item('note.md', 10, 6), item('film.mov', 20e9, 1)];
  const saved = { id: 'setting:release_rules', type: 'setting', value: { value: [{ id: 'big', when: group('size', 'greater_than', { value: 10e9 }), after_days: 5 }] } };
  const run = await runRow(planRow, { items, kept_bytes: 80e9, now: '2026-11-10T09:00:00Z' }, { records: [saved] });
  assert.equal(run.code, 0, run.stderr);
  const { result } = last(run);
  assert.deepEqual(result.now, ['big.zip']);
  assert.equal(result.kept_after, 30e9);
  assert.deepEqual(result.items.map(row => [row.id, row.because]), [['big.zip', 'big'], ['note.md', null], ['film.mov', 'big']]);
  assert.equal(result.items[2].leaves_at, '2026-11-14T09:00:00.000Z');
  assert.equal(result.leaving.length, 30);
  const once = last(await runRow(planRow, { items, kept_bytes: 80e9, now: '2026-11-10T09:00:00Z', rules: [{ id: 'room', when: null, storage_above_bytes: 50e9, order: 'largest' }] }, { records: [saved] })).result;
  assert.deepEqual(once.now, ['big.zip']);
  assert.equal(once.rules[0].id, 'room');
});

test('a rule with no comparison refuses the whole plan; items without sizes are refused', async () => {
  const bad = last(await runRow(planRow, { items: [item('a', 1, 1)], kept_bytes: 1, rules: [{ id: 'empty', when: { kind: 'group', combinator: 'and', negate: false, rules: [] }, after_days: 0 }] }, { records: [] }));
  assert.match(bad.error, /no comparison/);
  const run = await runRow(planRow, { items: [{ id: 'z' }], kept_bytes: 1 }, { records: [] });
  assert.equal(run.code, 1);
});
