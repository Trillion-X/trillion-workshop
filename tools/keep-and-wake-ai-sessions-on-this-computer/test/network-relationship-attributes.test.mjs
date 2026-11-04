// How well you know someone, as always-derived columns of their row (src/list-relationships.mjs, DATA
// src/list-relationships.json): first, last and next interaction, a count and a strength, worked out on every read from
// the messages that mention the row and the arrivals they spoke in, through the real record store's participation index.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localStore } from '../src/local-store.mjs';
import { handleListsRequest, makeLists, readThroughView } from '../../keep-lists-of-rows/lists.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import settings from '../src/lists.json' with { type: 'json' };

const evaluator = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const ruleKinds = new Map(settings.field_kinds.map(kind => [kind.id, kind.ruleKind]));
const views = { filterRows: input => evaluator.filterRowsByRules(input), ruleKindOf: kind => ruleKinds.get(kind) ?? kind };

const DAY = 86_400_000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();
const relationshipFields = [
  { id: 'first', label: 'First', kind: 'relationship', relationship: { attribute: 'first_interaction' } },
  { id: 'last', label: 'Last', kind: 'relationship', relationship: { attribute: 'last_interaction' } },
  { id: 'next', label: 'Next', kind: 'relationship', relationship: { attribute: 'next_interaction' } },
  { id: 'heard', label: 'Heard', kind: 'relationship', relationship: { attribute: 'last_heard' } },
  { id: 'count', label: 'Count', kind: 'relationship', relationship: { attribute: 'interactions' } },
  { id: 'strength', label: 'Strength', kind: 'relationship', relationship: { attribute: 'strength' } },
];

const fresh = async t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  const lists = makeLists({ eeaf: store.eeaf, newId: () => crypto.randomUUID() });
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, ...relationshipFields], views: [
    { id: 'close', label: 'Close', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'count', operator: 'greater_than', params: { value: 2 } }] } },
  ] });
  await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana' } }, { id: 'bo', values: { name: 'Bo' } }, { id: 'cy', values: { name: 'Cy' } }] });
  const rowType = (await lists.read('people', { row_ids: [] })).list.row_type;
  const rowRecord = id => `record:${rowType}:${id}`;
  const mention = (n, who, at) => store.eeaf.write([{ id: `message:${who}-${n}`, type: 'message', value: { id: `message:${who}-${n}`, text: `about ${who}`, at, about: [{ kind: 'record', id: rowRecord(who) }] } }], { actor: { by: 'test' } });
  return { store, lists, mention, rowRecord };
};

test('a person row answers first, last, next, count and strength from the messages naming it and what they said', async t => {
  const { store, lists, mention, rowRecord } = await fresh(t);
  for (let n = 0; n < 4; n += 1) mention(n, 'ana', ago(10 + n * 10));
  mention(9, 'ana', new Date(Date.now() + 2 * DAY).toISOString());
  store.eeaf.write([{ id: 'arrival:a1', type: 'arrival', value: { at: ago(5), speaker_record: rowRecord('ana'), message_id: 'message:ana-0' } }], { actor: { by: 'test' } });
  mention(0, 'bo', ago(400));
  store.eeaf.maintain?.();
  const rows = Object.fromEntries((await lists.read('people', { row_ids: ['ana', 'bo', 'cy'] })).rows.map(row => [row.id, row.values]));
  assert.equal(rows.ana.first.slice(0, 10), ago(40).slice(0, 10));
  assert.equal(rows.ana.last.slice(0, 10), ago(5).slice(0, 10), 'the arrival they spoke in is the last interaction');
  assert.equal(rows.ana.heard.slice(0, 10), ago(5).slice(0, 10));
  assert.ok(rows.ana.next > new Date().toISOString(), 'a future-dated interaction is the next one');
  assert.equal(rows.ana.count, 5, 'four messages and one arrival in the past');
  assert.equal(rows.ana.strength, 'Warm');
  assert.equal(rows.bo.strength, 'Known');
  assert.equal(rows.bo.count, 1);
  assert.deepEqual([rows.cy.first, rows.cy.last, rows.cy.next, rows.cy.count, rows.cy.strength], [null, null, null, 0, null], 'someone never met has no interactions');
  assert.equal(Object.hasOwn(store.eeaf.read(rowRecord('ana')), 'count'), false, 'nothing is kept in the row');
});

test('a relationship field is always derived: a write naming it and an unknown attribute are refused', async t => {
  const { lists } = await fresh(t);
  await assert.rejects(async () => await lists.putRows('people', { rows: [{ id: 'ana', values: { count: 99 } }] }));
  await assert.rejects(async () => await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'x', label: 'X', kind: 'relationship', relationship: { attribute: 'made-up' } }] }), /how well you know someone/);
  const response = await handleListsRequest(lists, new Request('https://person/lists/people', { method: 'POST', body: JSON.stringify({ id: 'people', label: 'People', fields: [{ id: 'x', label: 'X', kind: 'relationship', relationship: { attribute: 'nope' } }] }) }));
  assert.ok(response.status >= 400);
});

test('a saved view filters by a relationship column as the kind its attribute answers', async t => {
  const { store, lists, mention } = await fresh(t);
  for (let n = 0; n < 3; n += 1) mention(n, 'bo', ago(n + 1));
  mention(0, 'ana', ago(1));
  store.eeaf.maintain?.();
  const answer = await readThroughView(lists, 'people', 'close', views);
  assert.deepEqual(answer.rows.map(row => row.id), ['bo']);
});
