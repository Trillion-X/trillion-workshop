// The old codebase test/catalogue-screen-ai-apps.test.mjs (at commit b6ae0ebf815f): its three read
// assertions, now run against the port in do-work/read-ai-apps.mjs instead of a stand-in gather in the test. The layout
// assertions of the old file are not here: no running code draws tool:ai-apps yet (see the port's handoff row).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAiApps } from '../do-work/read-ai-apps.mjs';
import { grantSignIn } from '../src/ai-reach.mjs';

const FULL_REACH = Object.freeze({ private: true, spaces: 'all' });

// An account with one app signed in twice, one personal key and a pursuit, asked as its owner would be.
function world() {
  return {
    keys: [{ id: 'k1', ending: 'ab12', created_at: '2026-09-10T00:00:00Z' }, { id: 'k2', name: 'Zapier', ending: 'cd34', created_at: '2026-10-02T00:00:00Z' }],
    grants: [
      { id: 'g1', clientId: 'c1', userId: 'u1', createdAt: 1790000000, metadata: { clientName: 'Claude', reach: FULL_REACH, ceiling: FULL_REACH } },
      { id: 'g2', clientId: 'c1', userId: 'u1', createdAt: 1790000100, metadata: { clientName: 'Claude', reach: FULL_REACH, ceiling: FULL_REACH } },
    ],
    idles: { [grantSignIn('g1')]: 30 },
    callsLately: async () => ({ [grantSignIn('g1')]: 12 }),
    spaces: async () => [{ space_id: 'membership_snack', title: 'Snack brand launch' }],
    readHooks: async () => [{ id: 'sub_1', url: 'https://hooks.example.com/a/', name: 'work.stuck', created_at: '2026-10-20T10:00:00Z', delivered: 0 }],
  };
}

test('the read gathers the account\'s apps, keys, pursuits and webhooks, newest key first', async () => {
  const facts = await readAiApps(world());
  assert.deepEqual(facts.apps.map(app => [app.name, app.sign_in_count]), [['Claude', 2]]);
  assert.match(facts.apps[0].reach.line, /^Can reach: Everything · Stops after 30 days unused · Up to [\d,]+ calls a minute · 12 in the last minute$/);
  assert.equal(facts.apps[0].reach.ai_id, 'app:Claude');
  assert.deepEqual(facts.apps[0].reach.fields.find(field => field.name === 'spaces').options, [{ value: 'membership_snack', label: 'Snack brand launch' }]);
  assert.deepEqual(facts.keys.map(key => [key.name, key.ending]), [['Zapier', 'cd34'], [null, 'ab12']]);
  assert.deepEqual(facts.webhooks_section.rows.map(row => row.id).slice(0, 1), ['sub_1']);
  assert.deepEqual(facts.apps[0].grant_ids, ['g1', 'g2'], 'the app\'s button sends both its sign-ins');
});

test('a part that cannot be read says so and never fails the screen', async () => {
  const given = world();
  const facts = await readAiApps({ ...given, spaces: async () => { throw new Error('pursuits are busy'); }, callsLately: async () => { throw new Error('no counts'); }, readHooks: async () => { throw new Error('no webhooks'); } });
  assert.deepEqual(facts.apps[0].reach.fields.find(field => field.name === 'spaces').options, [], 'no pursuits to pick');
  assert.doesNotMatch(facts.apps[0].reach.line, /in the last minute/);
  assert.match(facts.webhooks_section.note, /could not be read/, 'webhooks that could not be read are not an empty list');
  const empty = await readAiApps({ ...given, grants: [], keys: [] });
  assert.deepEqual([empty.apps, empty.keys], [[], []]);
});

test('the read answers only the records it is handed: a key shows its last four characters, never a value', async () => {
  const facts = await readAiApps({ ...world(), keys: [{ id: 'k9', name: 'Ops', ending: 'ZZ99', value: 'sk-secret-value', created_at: '2026-10-05T00:00:00Z' }] });
  assert.deepEqual(facts.keys.map(key => key.ending), ['ZZ99']);
  assert.doesNotMatch(JSON.stringify(facts), /sk-secret-value/);
});
