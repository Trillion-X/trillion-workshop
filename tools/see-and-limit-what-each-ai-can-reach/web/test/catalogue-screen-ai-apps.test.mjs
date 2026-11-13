// Ported from old trillion test/catalogue-screen-ai-apps.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The facts of AI apps & keys are web/src/ai-apps-screen.mjs aiAppsFacts; the old
// gather around it (src/screen-reads.mjs readAiApps over src/ais-of-account.mjs, not carried) is a stand-in below built
// from the owners that remain (ai-reach.mjs withReaches, sign-in-lifetimes.mjs idleDaysOf, sign-in-calls.mjs callsTier),
// and each assertion on the facts is the old one. Left out: the layout tests ('the layout draws every description...',
// the drawn screen's sections and send body, and 'the read chooses no account from its input'): they read
// records/marketplace-screens.json through test/catalogue-screens-for-tests.mjs and test/fixtures/ai-apps-descriptions.json,
// none carried; the rows sit only as a trillion-rust test fixture (tests/fixtures/screen-host/marketplace-screens.json),
// with no running code in the three repos that draws tool:ai-apps or reads tool:read-ai-apps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiAppsFacts } from '../src/ai-apps-screen.mjs';
import { grantSignIn, withReaches } from '../../src/ai-reach.mjs';
import { idleDaysOf } from '../src/sign-in-lifetimes.mjs';
import { callsTier } from '../src/sign-in-calls.mjs';

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

// Stand-in for the old gather: one app per client name with its grants, each AI's reach, idle days and calls, and the
// pursuits and webhooks, a part that cannot be read answering nothing (pursuits, counts) or null (webhooks).
async function gather({ keys, grants, idles, callsLately, spaces, readHooks }) {
  const optional = async (read, fallback) => { try { return await read(); } catch { return fallback; } };
  const apps = [...new Map(grants.map(grant => [grant.metadata.clientName, grant])).keys()].map(name => {
    const own = grants.filter(grant => grant.metadata.clientName === name);
    return { id: own[0].id, name, grant_ids: own.map(grant => grant.id), created_at: new Date(own[0].createdAt * 1000).toISOString(), last_used_at: null };
  });
  const ais = withReaches({ apps, grants, keys, reaches: {} });
  const used = await optional(callsLately, {});
  const callsOf = (ai, caller, approvedBy) => ({ limit: callsTier({ holds: [], caller, approved_by: approvedBy }).limit,
    used: (ai.sign_ins ?? []).reduce((sum, item) => sum + (used[item.sign_in] ?? 0), 0) });
  const idleOf = (ai, approvedBy) => idleDaysOf(approvedBy, idles[ai.sign_ins?.[0]?.sign_in] ?? null);
  return aiAppsFacts({
    apps: ais.apps.map(app => ({ ...app, idle_days: idleOf(app, null), calls: callsOf(app, 'app', null) })),
    keys: ais.keys.map(key => ({ ...key, idle_days: idleOf(key, 'key'), calls: callsOf(key, 'key', 'key') })),
    spaces: await optional(spaces, []), hooks: await optional(readHooks, null),
  });
}

test('the read gathers the account\'s apps, keys, pursuits and webhooks, newest key first', async () => {
  const facts = await gather(world());
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
  const facts = await gather({ ...given, spaces: async () => { throw new Error('pursuits are busy'); }, callsLately: async () => { throw new Error('no counts'); }, readHooks: async () => { throw new Error('no webhooks'); } });
  assert.deepEqual(facts.apps[0].reach.fields.find(field => field.name === 'spaces').options, [], 'no pursuits to pick');
  assert.doesNotMatch(facts.apps[0].reach.line, /in the last minute/);
  assert.match(facts.webhooks_section.note, /could not be read/, 'webhooks that could not be read are not an empty list');
  const empty = await gather({ ...given, grants: [], keys: [] });
  assert.deepEqual([empty.apps, empty.keys], [[], []]);
});
