// test/view-as-stop-ends-look.test.mjs
// Revived from the old held test test/view-as.test.mjs.held (old app repository, b6ae0ebf815f): a look is read only and ends
// with its leave, and stopping the leave ends an open look at once, because the owner's directory is asked on every request
// (src/view-as.mjs invariant 3, lookStands). The owner's live directory is not in Workshop yet (README.md, H1): here its
// per-request check is the same lookStands rule over the owner's permission rows, held in memory for this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberAccountEmail } from '../../start-from-any-landing-page/src/sign-in-email.mjs';
import { letLook, looking, lookSessionAllows, lookStands, permissions, startLook, stopLetting, viewAsSettings } from '../src/view-as.mjs';

function memoryKv() {
  const values = new Map();
  return {
    values,
    async get(key, type) { const value = values.get(key); return value === undefined ? null : (type === 'json' ? JSON.parse(value) : value); },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
  };
}

// The owner's permission rows and its account lifecycle, as one directory answers them (same rules as the old one).
function memoryPolicies({ generation = 3, lifecycle = {} } = {}) {
  const rows = new Map();
  const of = owner => ({
    async letLookGrant(row) { rows.set(owner, permissions.grant(rows.get(owner), row)); return row; },
    async letLookStop(who) { const { row, rows: kept } = permissions.stop(rows.get(owner), who); rows.set(owner, kept); return row; },
    async letLooking() { return permissions.live(rows.get(owner)).map(({ who, until }) => ({ who, until })); },
    async letLookPermission(id) { const found = permissions.of(rows.get(owner), id); return found ? { ...found, generation } : null; },
    async acceptsLook(look) {
      return lookStands({ account: { lifecycle: { browser_session_generation: generation, ...lifecycle } }, sign_in_row: null, let_look: rows.get(owner) ?? [] }, look);
    },
  });
  return { of, rows };
}

const owner = 'owner-account';
const viewer = 'viewer-account';
const hash = token => `h-${token}`;
let counter = 0;
const random = () => `token-${counter += 1}`;
const nameOf = async id => (id === owner ? 'Sam' : 'Morgan');
const lookOf = saved => ({ grant: saved.grant, viewer: saved.viewer, issued_at: saved.created_at, browser_generation: saved.browser_generation });

test('a look stands while its leave stands, and stopping the leave ends it at once (the owner checks each request)', async () => {
  const kv = memoryKv();
  await rememberAccountEmail(kv, viewer, 'viewer@example.com');
  await rememberAccountEmail(kv, owner, 'owner@example.com');
  const { of: policyOf } = memoryPolicies();
  const now = Date.now();
  await letLook({ kv, policyOf, owner, email: 'viewer@example.com', days: 1, nameOf, now });
  const { letting_me: [row] } = await looking({ kv, policy: policyOf(viewer), userId: viewer, now });
  const look = await startLook({ kv, policyOf, id: row.id, viewer, hash, random, now });
  assert.equal(look.owner, owner);
  assert.equal(Date.parse(look.until), now + viewAsSettings.look_minutes * 60_000, 'a look is short');
  const saved = await kv.get(`session:${hash(look.token)}`, 'json');
  assert.deepEqual([saved.userId, saved.look_only, saved.viewer, saved.browser_generation, saved.path, saved.grant], [owner, true, viewer, 3, '/', row.id]);

  const at = path => new Request(`https://app.example.test${path}`);
  assert.equal(lookSessionAllows(saved, at('/work/api/waiting-on-you'), now), true);
  assert.equal(lookSessionAllows(saved, new Request('https://app.example.test/work/api/account/sharing', { method: 'POST' }), now), false, 'read only');
  assert.equal(lookSessionAllows(saved, at('/'), Date.parse(look.until) + 1), false, 'it ends');
  assert.equal(await policyOf(owner).acceptsLook(lookOf(saved)), true, 'the owner accepts the look while the leave stands');

  await stopLetting({ kv, policyOf, owner, who: 'viewer@example.com', now });
  assert.equal(await policyOf(owner).acceptsLook(lookOf(saved)), false, 'stopping the leave ends the look open now');
  assert.equal((await looking({ kv, policy: policyOf(viewer), userId: viewer, now })).letting_me.length, 0);
  assert.equal(await startLook({ kv, policyOf, id: row.id, viewer, hash, random, now }), null, 'no new look under the stopped leave');
  assert.equal(await startLook({ kv, policyOf, id: row.id, owner, viewer, hash, random, now }), null, 'even when the caller names the owner');
});

test('lookStands also ends a look when the account is disconnected after it was issued, its browser generation moves, its sign-in ends, or the account is retired', async () => {
  const kv = memoryKv();
  await rememberAccountEmail(kv, viewer, 'viewer@example.com');
  await rememberAccountEmail(kv, owner, 'owner@example.com');
  const now = Date.now();
  const issued = new Date(now - 60_000).toISOString();
  const id = 'd'.repeat(32);
  const rows = permissions.grant([], { who: 'viewer@example.com', until: new Date(now + 86_400_000).toISOString(), entries: [{ id, viewer }] }, now);
  const look = { grant: id, viewer, issued_at: issued, browser_generation: 3 };
  const account = (lifecycle = {}) => ({ lifecycle: { browser_session_generation: 3, ...lifecycle } });
  assert.equal(lookStands({ account: account(), sign_in_row: null, let_look: rows }, look, now), true, 'a look stands with nothing against it');
  assert.equal(lookStands({ account: account({ disconnected_at: new Date(now).toISOString() }), sign_in_row: null, let_look: rows }, look, now), false, 'disconnect after the look was issued ends it');
  assert.equal(lookStands({ account: account({ disconnected_at: new Date(now - 120_000).toISOString() }), sign_in_row: null, let_look: rows }, look, now), true, 'a look issued after a disconnect stands');
  assert.equal(lookStands({ account: { lifecycle: { browser_session_generation: 4 } }, sign_in_row: null, let_look: rows }, look, now), false, 'a moved browser generation ends it');
  assert.equal(lookStands({ account: account(), sign_in_row: { ended_until_ms: now + 1000 }, let_look: rows }, look, now), false, 'an ended sign-in ends it');
  assert.equal(lookStands({ account: account(), sign_in_row: { ended_until_ms: now - 1000 }, let_look: rows }, look, now), true, 'a sign-in ended in the past stands');
  assert.equal(lookStands({ account: account({ retired_into: 'other' }), sign_in_row: null, let_look: rows }, look, now), false, 'a retired account ends it');
  assert.equal(lookStands({ account: account({ deleting_since: new Date(now).toISOString() }), sign_in_row: null, let_look: rows }, look, now), false, 'a deleting account ends it');
  assert.equal(lookStands({ account: account(), sign_in_row: null, let_look: rows }, { ...look, viewer: 'someone-else' }, now), false, 'another viewer is refused');
});
