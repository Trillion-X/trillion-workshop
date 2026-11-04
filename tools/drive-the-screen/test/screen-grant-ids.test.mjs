// Two grants made in the same millisecond are two grants: each is found, spent and revoked by its own id (the screen-driving-guards test
// "a grant that counts uses..." failed now and then because both took `grant-<ms>` and the first one answered for the second).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantTools, readGrants, screenSettings } from '../read-data/drive-the-screen.mjs';

test('grants made at the same instant have different ids, and revoking one leaves the other', () => {
  const settings = screenSettings();
  const home = mkdtempSync(join(tmpdir(), 'grant-ids-'));
  const tools = grantTools(settings, { home, now: () => Date.parse('2026-10-22T10:00:00.000Z') });
  const looking = tools.grant({ actions: ['look'], minutes: 5 });
  const pressing = tools.grant({ actions: ['press'], uses: 1, minutes: 5 });
  assert.notEqual(looking.grant.id, pressing.grant.id);
  assert.equal(readGrants(settings, home).grants.find(grant => grant.id === pressing.grant.id).uses, 1);
  assert.equal(tools.revoke({ id: pressing.grant.id }).revoked, 1);
  assert.deepEqual(readGrants(settings, home).grants.map(grant => grant.id), [looking.grant.id]);
});
