import test from 'node:test';
import assert from 'node:assert/strict';
import * as facade from '../read-data/app-hardening.mjs';
import * as core from '../read-data/app-hardening-core.mjs';

test('the public app-hardening path preserves every core export by identity', () => {
  assert.deepEqual(Object.keys(facade).sort(), Object.keys(core).sort());
  for (const name of Object.keys(core)) assert.strictEqual(facade[name], core[name], `${name} keeps its core identity`);
});
