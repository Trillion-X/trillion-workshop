import test from 'node:test';
import assert from 'node:assert/strict';
import * as facade from '../read-data/personal-data.mjs';
import * as core from '../read-data/personal-data-core.mjs';

test('the public personal-data path preserves every core export by identity', () => {
  assert.deepEqual(Object.keys(facade).sort(), Object.keys(core).sort());
  for (const name of Object.keys(core)) assert.strictEqual(facade[name], core[name], `${name} keeps its core identity`);
});
