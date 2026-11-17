// The vendor row split between hearing and channel listing retains every frozen field.
// This cross-tool table contract belongs to the repository's qualification suite.
import assert from 'node:assert/strict';
import test from 'node:test';
import golden from '../tools/run-on-a-persons-computer/test/fixtures/vendor-tables-golden.json' with { type: 'json' };
import { listSettings } from '../tools/run-on-a-persons-computer/list-a-channel.mjs';

test('the channel lister retains the whole frozen vendor row, including its list command', () => {
  assert.deepEqual(listSettings().fetchers, golden.hear_fetchers);
});
