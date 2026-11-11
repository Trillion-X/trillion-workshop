// A row's packed module that this checkout does not have (its node_modules not installed) is named as the reason the
// run cannot start, not skipped: the child would otherwise fail on an import with no word of why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow } from '../test-helpers/run-a-row.mjs';

test('a packed module missing from this checkout is named, not silently left out', async () => {
  const row = { id: 'tool:names-a-missing-module', invoke: { argv: ['node', '-e', '0'], files: { package_files: [{ module: 'no-such-module-for-this-test', paths: ['index.js'], at: '/opt/no-such' }] } } };
  await assert.rejects(runRow(row, {}, {}), /no-such-module-for-this-test is not installed in this checkout/);
});
