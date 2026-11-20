import { test } from 'node:test';
import assert from 'node:assert/strict';
import record from '../records/hq-sharing.json' with { type: 'json' };
import { createHQSharing } from '../read-data/hq-sharing.mjs';

test('the kept sharing record defaults activity on and content off, and a new account is written with that default', () => {
  assert.deepEqual(record.default, { activity: true, content: false });
  assert.equal(record.key_prefix, 'hq-sharing:');
  const choices = createHQSharing(record);
  assert.deepEqual(choices.sharingOf(null), { activity: true, content: false, set_at: null, via: 'default' });
  assert.deepEqual(choices.defaultSharing({ account: 'member', signedIn: 'member', kept: null, now: new Date('2026-11-01T00:00:00Z') }), {
    key: 'hq-sharing:member', value: { activity: true, content: false, set_at: '2026-11-01T00:00:00.000Z', via: 'sign_up' } });
});
