// tools/social-posts: the by_input variants of tool:send-a-post and tool:check-a-connection are exactly what the
// place rows (read-data/post-places.json) declare, so a place row is the one owner and a new place is a row.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import places from '../read-data/post-places.json' with { type: 'json' };
import { checkVariants, sendVariants, slugOf, withVariants } from '../read-data/place-variants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(HERE, '..', 'tool-rows.json'), 'utf8');

test('tool-rows.json holds the variants the place rows make (node read-data/place-variants.mjs --write)', () => {
  assert.equal(withVariants(text), text);
});

test('a place with no check has no check variant and every place has a send variant', () => {
  assert.deepEqual(Object.keys(sendVariants()).sort(), places.places.map(slugOf).sort());
  assert.deepEqual(Object.keys(checkVariants()).sort(), places.places.filter(place => place.check).map(slugOf).sort());
  assert.ok(Object.keys(checkVariants()).length < Object.keys(sendVariants()).length);
});

test('a new place row makes its variants with no code naming it', () => {
  const added = { id: 'post-place:example-place', connection_vendor: 'example-vendor', options: { auth: { token: { held: 'api_key' }, other: { held: 'secret' } } },
    check: { url: 'https://api.example.test/me', query: { fields: 'id' }, field_id: 'api_key', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' }, timeout_seconds: 10 } };
  assert.deepEqual(sendVariants([added])['example-place'], { connection: { vendor: 'example-vendor', from_input: 'account_id' }, credential_mounts: [{ field_id: 'api_key', fd: 4 }, { field_id: 'secret', fd: 5 }] });
  assert.deepEqual(checkVariants([added])['example-place'].credential_injections, [{ hosts: ['api.example.test'], field_id: 'api_key', placement: added.check.placement }]);
});
