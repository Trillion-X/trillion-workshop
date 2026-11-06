// Ported from old trillion test/list-field-explanation.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old test booted the retired simulated person for its record store; here
// makeLists (this tool's lists.mjs, old src/lists.mjs) runs over the computer's own store
// (keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs), and each call is awaited. Every assertion is the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../lists.mjs';

test('field explanation survives list creation, reads and unrelated edits', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  const fields = [{ id: 'login', kind: 'text', label: 'Saved login', free_text_because: 'The exact saved login title links to its locked owner.' }];
  await lists.save({ id: 'field-explanation', label: 'Explanation', fields });
  assert.equal((await lists.find('field-explanation')).fields[0].free_text_because, fields[0].free_text_because);
  await lists.save({ id: 'field-explanation', label: 'Renamed' });
  assert.equal((await lists.find('field-explanation')).fields[0].free_text_because, fields[0].free_text_because);
  await assert.rejects(async () => lists.save({ id: 'field-explanation', fields: [{ ...fields[0], free_text_because: 'x'.repeat(1000000) }] }));
  assert.equal((await lists.find('field-explanation')).fields[0].free_text_because, fields[0].free_text_because);
});
