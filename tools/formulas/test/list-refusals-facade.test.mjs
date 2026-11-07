import test from 'node:test';
import assert from 'node:assert/strict';
import * as facade from '../read-data/list-refusals.mjs';
import * as core from '../read-data/list-refusals-core.mjs';

test('the public list-refusals path preserves every core export and class identity', () => {
  assert.deepEqual(Object.keys(facade).sort(), Object.keys(core).sort());
  for (const name of Object.keys(core)) assert.strictEqual(facade[name], core[name], `${name} keeps its core identity`);
  assert.strictEqual(new facade.ListsError('refused').constructor, core.ListsError);
});
