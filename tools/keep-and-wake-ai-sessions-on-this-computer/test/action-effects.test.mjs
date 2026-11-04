// What a tool's run changes, declared once on its row (parts/ai-tool-catalog/read-data/declared-effects.ts): the catalog
// decoder refuses a malformed list, one reader resolves a phase's effects for a call, merges never change what they are
// given, and a completed Workshop run answers its resolved `changes` to every caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admitToolDescriptor } from '../../ai-tool-catalog/read-data/read-ai-tool-catalog.ts';
import { applyMerge, effectReads, effectsAt } from '../../ai-tool-catalog/read-data/declared-effects.ts';
import { readToolData, makeWorkshop } from '../src/workshop.mjs';

const effects = [
  { on: 'mutate', action: 'update', read: ['/work/api/lists/', { from: 'input', path: ['list_id'] }], merge: { at: ['rows'], op: 'append', value: { from: 'input', path: ['row'] } } },
  { on: 'success', action: 'update', read: ['/work/api/lists/', { from: 'input', path: ['list_id'] }], merge: { at: ['rows'], op: 'replace', match: 'id', value: { from: 'output', path: ['row'] } } },
  { on: 'success', action: 'invalidate', read: ['/work/api/activity'] },
];
const tool = {
  kind: 'ai-tool-descriptor', id: 'tool:add-row', label: 'Add a row', job: 'Add a row to a list',
  input_schema: { type: 'object', required: ['list_id', 'row'], properties: { list_id: { type: 'string' }, row: { type: 'object' } } },
  output_schema: { type: 'object', required: ['row'], properties: { row: { type: 'object' } } },
  verify: [{ kind: 'sample-run', input: { list_id: 'l', row: { id: 'r' } }, output_selector: '$.row.id', contains: 'r' }],
  invoke: { kind: 'model', model: 'rows', input: { row: { fill: { from: 'input', field: 'row' } } } },
  licence_class: 'licence:own', placements: ['placement:model'], effects,
};

test('the catalog keeps well-formed effects and refuses malformed ones with the reader\'s words', () => {
  assert.deepEqual(admitToolDescriptor(tool).item.effects, effects);
  const refused = bad => admitToolDescriptor({ ...tool, effects: bad }).refused?.reason;
  assert.match(refused([]), /effects must be a list/);
  assert.match(refused([{ on: 'later', action: 'update', read: ['/x'] }]), /on \(mutate or success\)/);
  assert.match(refused([{ on: 'success', action: 'invalidate', read: ['work/api/x'] }]), /beginning with \//);
  assert.match(refused([{ on: 'success', action: 'invalidate', read: ['/x/{input.id}', 'y'], merge: { at: [], op: 'set', value: { value: 1 } } }]), /no merge/);
  assert.match(refused([{ on: 'success', action: 'update', read: ['/x'], merge: { at: ['rows'], op: 'remove', value: { value: 'a' } } }]), /match/);
  assert.match(refused([{ on: 'success', action: 'invalidate', read: ['/x', { from: 'elsewhere', path: ['a'] }] }]), /literal text/);
});

test('a phase resolves its reads from the call, encoding values; an effect missing a value is left out', () => {
  const mutate = effectsAt(effects, 'mutate', { input: { list_id: 'to do/now', row: { id: 'r1', title: 'Draft' } } });
  assert.deepEqual(mutate, [{ action: 'update', read: '/work/api/lists/to%20do%2Fnow', merge: { at: ['rows'], op: 'append', value: { id: 'r1', title: 'Draft' } } }]);
  assert.deepEqual(effectsAt(effects, 'mutate', { input: { row: { id: 'r1' } } }), []);
  const success = effectsAt(effects, 'success', { input: { list_id: 'l' }, output: { row: { id: 'r1', title: 'Saved' } } });
  assert.deepEqual(effectReads(success), ['/work/api/lists/l', '/work/api/activity']);
  assert.deepEqual(effectReads(undefined), []);
});

test('merges set, append, replace and remove without changing what they are given', () => {
  const answer = Object.freeze({ list: { rows: Object.freeze([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]) } });
  assert.deepEqual(applyMerge(answer, { at: ['list', 'rows'], op: 'append', value: { id: 'c' } }).list.rows.map(row => row.id), ['a', 'b', 'c']);
  assert.deepEqual(applyMerge(answer, { at: ['list', 'rows'], op: 'replace', match: 'id', value: { id: 'b', n: 9 } }).list.rows, [{ id: 'a', n: 1 }, { id: 'b', n: 9 }]);
  assert.deepEqual(applyMerge(answer, { at: ['list', 'rows'], op: 'remove', match: 'id', value: 'a' }).list.rows, [{ id: 'b', n: 2 }]);
  assert.deepEqual(applyMerge(answer, { at: ['list', 'title'], op: 'set', value: 'New' }).list.title, 'New');
  assert.equal(applyMerge(answer, { at: ['missing', 'rows'], op: 'append', value: 1 }), answer);
  assert.deepEqual(answer.list.rows, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
});

test('a completed Workshop run answers its resolved changes to every caller', async () => {
  const tasks = new Map();
  const workshop = makeWorkshop({
    host: 'hosted',
    data: async () => readToolData([
      { kind: 'tool-placement', id: 'placement:model', label: 'Trillion', executor: 'model-runtime', reachable_from: ['hosted'] },
      { kind: 'tool-licence-class', id: 'licence:own', label: 'Own', licences: ['MIT'], allowed_placements: ['placement:model'], store_bytes: true },
      tool,
    ].map(payload => ({ payload }))),
    store: {
      readTask: async id => tasks.get(id) ?? null, writeTask: async task => { tasks.set(task.task_id, structuredClone(task)); },
      dueTasks: async () => [], nextDueAt: async () => null, lastCompleted: async () => null, taskCards: async () => [],
      readSavedTools: async () => [], writeSavedTool: async () => {}, putBytes: async () => {}, readBytes: async () => null, readEffect: async () => null, writeEffect: async () => {},
    },
    pool: { recordRun: async () => {}, recordReport: async () => {}, stats: async ids => Object.fromEntries(ids.map(id => [id, { runs: 0, contract_passed: 0, reported_met: 0, reported_failed: 0 }])) },
    executors: { 'model-runtime': async ({ invocation }) => ({ row: { ...invocation.input.row, saved: true } }) },
  });
  const ran = await workshop.run({ tool_id: 'tool:add-row', input: { list_id: 'todo', row: { id: 'r1', title: 'Call Ana' } }, request_key: 'add-1' });
  assert.equal(ran.state, 'completed');
  assert.deepEqual(ran.changes, [
    { action: 'update', read: '/work/api/lists/todo', merge: { at: ['rows'], op: 'replace', match: 'id', value: { id: 'r1', title: 'Call Ana', saved: true } } },
    { action: 'invalidate', read: '/work/api/activity' },
  ]);
  assert.deepEqual((await workshop.read({ task_id: ran.task_id })).changes, ran.changes);
});
