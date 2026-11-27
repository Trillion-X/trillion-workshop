// The read of what a pull kept is the person's own store's job now: no row names the records door, the recipe and kit
// that replace the read validate, and the recipe's expected summary is what the parts assemble to (values in, values out).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { PART_KIND, assemble, readParts, stateId, threadId, itemId } from '../read-data/snapshot.mjs';
import { recipeProblems } from '../../workflows/read-data/recipe-problems.mjs';
import { kitProblems } from '../../workflows/read-data/kit-problems.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const recipe = read('../../workflows/recipes/read-what-i-pulled-from-an-account.json').records[0].payload;
const kit = read('../../workflows/kits/read-what-i-pulled-from-an-account.json');

test('no row of this folder names the records door, and the read tool is gone from the rows', () => {
  const text = JSON.stringify(rows.records.map(record => record.payload));
  assert.doesNotMatch(text, /"records:(read|write|list)"/);
  assert.doesNotMatch(text, /tool:read-what-i-pulled-from-an-account/);
  assert.equal(existsSync(new URL('../do-work/read.mjs', import.meta.url)), false);
  assert.equal(existsSync(new URL('../kits/read-what-i-pulled-from-an-account.json', import.meta.url)), false);
});

test('the recipe that replaces the read is a valid recipe, and its kit is a valid kit for it', () => {
  assert.equal(recipe.id, 'workflow:read-what-i-pulled-from-an-account');
  assert.deepEqual(recipeProblems(recipe), []);
  assert.deepEqual(kitProblems(kit, { recipe }), []);
});

test('the example parts assemble to the summary and the thread the recipe\'s prove step expects', async () => {
  const records = [
    { id: stateId('example-source', 'sample'), type: PART_KIND, value: { kind: 'state', source: 'example-source', account: 'sample', self_id: 'U0BOT', cursor: '1700000200.000300', pulled_at: '2026-10-30T12:00:00Z' } },
    { id: threadId('example-source', 'sample', 'C1'), type: PART_KIND, value: { kind: 'thread', seq: 1, thread: { id: 'C1', title: 'orders', messages: [{ ts: '1', text: 'a' }, { ts: '2', text: 'b' }, { ts: '3', text: 'c' }] } } },
    { id: itemId('example-source', 'sample', 'saved', 'i1'), type: PART_KIND, value: { kind: 'item', seq: 2, collection: 'saved', identity: 'i1', item: { id: 'i1', text: 'x' } } },
  ];
  // A stand-in for the store's list: the same records, filtered by kind and prefix the way the store would.
  const door = { async *list({ type, prefix }) { for (const record of records) if (record.type === type && record.id.startsWith(prefix)) yield record; } };
  const held = await readParts(door, 'example-source', 'sample');
  const snapshot = assemble('example-source', 'sample', held);
  assert.deepEqual(snapshot.threads.map(thread => ({ id: thread.id, title: thread.title, messages: thread.messages.length })), [{ id: 'C1', title: 'orders', messages: 3 }]);
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.collections).map(([name, items]) => [name, items.length])), { saved: 1 });
  assert.equal(snapshot.self_id, 'U0BOT');
  const expected = recipe.steps.find(step => step.id === 'prove').checks[0].values[0][0];
  assert.equal(expected.said, 'Pulled from example-source (sample): 1 conversations, 1 saved.');
  assert.equal(expected.self_id, snapshot.self_id);
  assert.equal(expected.threads[0].messages, snapshot.threads[0].messages.length);
});
