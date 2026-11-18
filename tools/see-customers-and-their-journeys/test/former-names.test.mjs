import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormerNamesCounter } from '../read-data/former-names-count.mjs';

test('the former-name counter keeps only closed-table ids and suppresses repeated names within its interval', () => {
  const counter = createFormerNamesCounter({ formerNames: () => ({ ids: ['old-tool'], note_every_minutes: 1 }), serverEvent: (kind, facts) => ({ kind, facts }) });
  const counted = [{ kind: 'former_id_used', facts: { former_id: 'old-tool' } }];
  assert.deepEqual(counter.countFormerIds(['unregistered-private-input', 'old-tool', 'old-tool'], 100), counted);
  assert.equal(counter.countFormerIds(['old-tool'], 200), null);
  assert.deepEqual(counter.countFormerIds(['old-tool'], 60101), counted);
});
