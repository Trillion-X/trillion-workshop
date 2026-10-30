// The two rows run as the container runs them, against the fake records door with exactly each row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const list = rowOf(rows, 'tool:list-saved-examples');
const remove = rowOf(rows, 'tool:remove-a-saved-example');
const example = (n, added_at) => ({
  id: `example:${String(n).repeat(32)}`, url: `https://example.com/p/${n}`, host: 'example.com', site: null, title: `Post ${n}`,
  words: null, pictures: [], why_it_worked: null, collection: null, added_from: 'ai', added_at, updated_at: added_at,
});
const kept = examples => examples.map(value => ({ id: value.id, type: 'saved-example', value }));

test('the list is every saved example, newest first, with its count', async () => {
  const ran = await runRow(list, {}, { records: kept([1, 2, 3].map(n => example(n, `2026-01-0${n}T00:00:00Z`))) });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.count, 3);
  assert.deepEqual(ran.result.examples.map(item => item.title), ['Post 3', 'Post 2', 'Post 1']);
  assert.deepEqual((await runRow(list, {})).result, { examples: [], count: 0 }, 'nothing exists until something is saved');
});

test('removing an example removes its record, and an unknown id is refused with what to do', async () => {
  const one = example(4, '2026-01-04T00:00:00Z');
  const ran = await runRow(remove, { id: one.id }, { records: kept([one]) });
  assert.deepEqual(ran.result, { id: one.id, removed: true });
  assert.deepEqual(ran.kept, []);
  assert.equal(ran.calls.find(call => call.method === 'records:write').key, `saved-example:remove:${one.id}:${one.updated_at}`);
  const unknown = await runRow(remove, { id: one.id });
  assert.equal(unknown.status, 1);
  assert.match(unknown.error, /There is no saved example example:4{32}\. Read the list for the ids\./);
});

test('the list row may only list saved examples: it cannot write one', async () => {
  assert.deepEqual(list.invoke.records.rights, [{ kind: 'saved-example', operations: ['records:list'] }]);
  assert.equal(list.invoke.internet, false);
});
