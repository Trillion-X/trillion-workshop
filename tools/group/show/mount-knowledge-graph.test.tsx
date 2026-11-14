// readInputs is a surface input contract; mounting/DOM qualification runs separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from './mount-knowledge-graph';

test('resolves the maintained records feed from surfaceInput and safe nonempty fallbacks', () => {
  assert.deepEqual(readInputs({ surfaceInput: { records_input: 'recs' } }), { recordsInput: 'recs' });
  assert.deepEqual(readInputs({ records_input: 'top' }), { recordsInput: 'top' });
  assert.deepEqual(readInputs({}), { recordsInput: 'knowledge-graph-records' });
  assert.equal(readInputs({ surfaceInput: { records_input: '' } }).recordsInput, 'knowledge-graph-records');
  assert.equal(readInputs({ surfaceInput: { records_input: '' }, records_input: 'top' }).recordsInput, 'top');
});
