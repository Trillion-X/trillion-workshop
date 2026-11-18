import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormerNamesCounter } from '../read-data/former-names-count.mjs';

test('the former-name counter keeps only closed-table ids and suppresses repeated names within its interval', async () => {
  const sent = [];
  const counter = createFormerNamesCounter({ formerNames: () => ({ ids: ['old-tool'], note_every_minutes: 1 }), serverEvent: (kind, facts) => ({ kind, facts }), noteInteractions: async (_, events) => sent.push(...events) });
  await counter.countFormerIds({}, ['unregistered-private-input', 'old-tool', 'old-tool'], 100);
  assert.deepEqual(sent, [{ kind: 'former_id_used', facts: { former_id: 'old-tool' } }]);
  assert.equal(counter.countFormerIds({}, ['old-tool'], 200), null);
  await counter.countFormerIds({}, ['old-tool'], 60101);
  assert.equal(sent.length, 2);
});
