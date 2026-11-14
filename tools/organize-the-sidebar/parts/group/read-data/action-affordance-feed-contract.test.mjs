import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../things-to-store-and-run.json', import.meta.url), 'utf8'));

test('Group reads cross-package action affordances by declared payload kind, not address spelling', () => {
  const feed = manifest.things.find((thing) => thing.address === 'package::group::action-affordance-feed');
  assert.ok(feed);
  assert.deepEqual(feed.payload_bytes.rows.match, [
    { path: ['payload', 'kind'], equals: 'action-affordance' },
  ]);
  assert.doesNotMatch(JSON.stringify(feed), /contains.*group/);

  const input = manifest.things.find((thing) => thing.address === 'package::group::input::action-affordance-feed');
  assert.equal(input?.payload?.selected_payload?.value_address_label, 'package::group::action-affordance-feed');
});
