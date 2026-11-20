// test/view-as-rules.test.mjs
// The rules of letting someone see your own home (src/view-as.mjs), ported from the old app repository's held tests at
// b6ae0ebf815f2f5271eed34e6e023c7e1767ec04 (test/view-as.test.mjs, test/view-as-looked.test.mjs,
// test/view-as-owner-address.test.mjs): nobody looks without the owner's leave, a look is read only and short, stopping the
// leave ends it, a link works once and keeps only its hash, the Privacy sections, the kept looks, and the look-only gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberAccountEmail } from '../../start-from-any-landing-page/src/sign-in-email.mjs';
import { keepLook, letLook, looking, lookingSections, lookSessionAllows, lookedNotice, makeLookLink, permissions, startLook, stopLetting, takeLookLink, viewAsSaid, viewAsSettings, ViewAsError } from '../src/view-as.mjs';

function memoryKv(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    values,
    async get(key, type) { const value = values.get(key); return value === undefined ? null : (type === 'json' ? JSON.parse(value) : value); },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
  };
}

// Each account's policy directory as its user id reaches it, keeping its permissions with the same `permissions` rules.
function memoryPolicies(generation = 3) {
  const facts = new Map();
  const of = owner => ({
    async letLookGrant(row) { facts.set(owner, permissions.grant(facts.get(owner), row)); return row; },
    async letLookStop(who) { const { row, rows } = permissions.stop(facts.get(owner), who); facts.set(owner, rows); return row; },
    async letLooking() { return permissions.live(facts.get(owner)).map(({ who, until }) => ({ who, until })); },
    async letLookPermission(id) { const found = permissions.of(facts.get(owner), id); return found ? { ...found, generation } : null; },
  });
  return of;
}

const owner = 'owner-account';
const viewer = 'viewer-account';
const hash = token => `h-${token}`;
let counter = 0;
const random = () => `token-${counter += 1}`;
const nameOf = async id => (id === owner ? 'Sam' : 'Morgan');
async function withEmails(kv) {
  await rememberAccountEmail(kv, viewer, 'viewer@example.com');
  await rememberAccountEmail(kv, owner, 'owner@example.com');
  return kv;
}

test('nobody looks without the owner\'s leave: bad, unknown, own and too long leaves are refused', async () => {
  const kv = await withEmails(memoryKv());
  const policyOf = memoryPolicies();
  await assert.rejects(letLook({ kv, policyOf, owner, email: 'not-an-email', days: 1, nameOf }), /Type the email/);
  await assert.rejects(letLook({ kv, policyOf, owner, email: 'nobody@example.com', days: 1, nameOf }), ViewAsError);
  await assert.rejects(letLook({ kv, policyOf, owner, email: 'owner@example.com', days: 1, nameOf }), /your own email/);
  await assert.rejects(letLook({ kv, policyOf, owner, email: 'viewer@example.com', days: 30, nameOf }), /Choose 1, 3 or 7 days/);
  assert.equal(await startLook({ kv, policyOf, id: 'a'.repeat(32), viewer, hash, random }), null, 'a made-up permission opens nothing');
  assert.equal(await startLook({ kv, policyOf, id: 'a'.repeat(32), owner, viewer, hash, random }), null, 'nor one named for a real owner');
  assert.equal(await startLook({ kv, policyOf, id: 'not-hex', owner, viewer, hash, random }), null, 'an id that is not 32 hex characters opens nothing');
});

test('a look is a read-only look-only sign-in of the owner, ends with the leave, and stopping the leave ends it', async () => {
  const kv = await withEmails(memoryKv());
  const policyOf = memoryPolicies();
  const now = Date.now();
  const granted = await letLook({ kv, policyOf, owner, email: 'Viewer@Example.com', days: 1, nameOf, now });
  assert.equal(granted.who, 'viewer@example.com');
  const { letting } = await looking({ kv, policy: policyOf(owner), userId: owner, now });
  assert.deepEqual(letting.map(row => row.who), ['viewer@example.com']);
  const { letting_me: [row] } = await looking({ kv, policy: policyOf(viewer), userId: viewer, now });
  assert.equal(row.name, 'Sam');
  assert.equal(await startLook({ kv, policyOf, id: row.id, viewer: 'someone-else', hash, random, now }), null, 'only the person let look can');
  const look = await startLook({ kv, policyOf, id: row.id, viewer, hash, random, now });
  assert.equal(look.owner, owner);
  assert.equal(Date.parse(look.until), now + viewAsSettings.look_minutes * 60_000, 'a look is short');
  const saved = await kv.get(`session:${hash(look.token)}`, 'json');
  assert.deepEqual([saved.userId, saved.look_only, saved.viewer, saved.browser_generation, saved.path, saved.grant], [owner, true, viewer, 3, '/', row.id]);
  const at = path => new Request(`https://app.example.test${path}`);
  assert.equal(lookSessionAllows(saved, at('/'), now), true);
  assert.equal(lookSessionAllows(saved, at('/work/api/waiting-on-you'), now), true);
  assert.equal(lookSessionAllows(saved, new Request('https://app.example.test/work/api/account/sharing', { method: 'POST' }), now), false, 'read only');
  assert.equal(lookSessionAllows(saved, at('/'), Date.parse(look.until) + 1), false, 'it ends');
  await stopLetting({ kv, policyOf, owner, who: 'viewer@example.com', now });
  assert.equal((await policyOf(owner).letLookPermission(row.id)), null, 'stopping the leave removes the permission at the owner');
  assert.equal((await looking({ kv, policy: policyOf(viewer), userId: viewer, now })).letting_me.length, 0);
  assert.equal(await startLook({ kv, policyOf, id: row.id, viewer, hash, random, now }), null);
  assert.equal(await startLook({ kv, policyOf, id: row.id, owner, viewer, hash, random, now }), null, 'even when the caller names the owner');
});

test('the look-only gate refuses other methods, other paths and a look that has ended; ordinary sessions are not gated', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const saved = { look_only: true, path: '/', expires_at: '2026-11-19T12:30:00Z' };
  const req = (path, method = 'GET') => new Request(`https://app.example.test${path}`, { method });
  assert.equal(lookSessionAllows({ look_only: false }, req('/settings', 'POST'), now), true, 'an ordinary session is not gated here');
  assert.equal(lookSessionAllows(saved, req('/work/api/viewer', 'HEAD'), now), true, 'HEAD of a read is allowed');
  assert.equal(lookSessionAllows(saved, req('/work/api/account/looking/stop', 'POST'), now), false, 'a change is refused');
  assert.equal(lookSessionAllows(saved, req('/settings'), now), false, 'a page other than its own is refused');
  assert.equal(lookSessionAllows(saved, req('/work/api/viewer'), Date.parse('2026-11-19T12:31:00Z')), false, 'an ended look is refused');
});

test('the Privacy sections offer the form, each leave with Stop, who looked, and the homes the person may look at', () => {
  const until = '2026-10-06T12:00:00Z';
  const sections = lookingSections({ letting: [{ who: 'a@example.com', until }], letting_me: [{ id: 'b'.repeat(32), name: 'Morgan', until }], looks: [{ name: 'a@example.com', at: '2026-10-05T12:00:00Z', until }] });
  const [mine, theirs] = sections;
  assert.equal(mine.rows[0].actions[0].send.path, '/work/api/account/looking/let');
  assert.deepEqual(mine.rows[0].fields.map(field => field.name), ['email', 'days']);
  assert.equal(mine.rows[1].actions[0].send.body.who, 'a@example.com');
  assert.equal(mine.rows[0].actions[1].send.path, '/work/api/account/looking/link', 'a link for someone whose email the app does not know');
  assert.ok(mine.rows[1].actions[0].send.confirm, 'stopping asks first');
  assert.match(mine.rows[2].title, /a@example.com looked/);
  assert.equal(theirs.rows[0].actions[0].href, `/view-as/${'b'.repeat(32)}`);
  assert.equal(lookingSections({}).length, 1, 'no homes to look at, no section for them');
});

test('a look link gives leave to the first signed-in person to open it, once, never the owner, and keeps only its hash', async () => {
  const kv = memoryKv();
  const policyOf = memoryPolicies();
  const now = Date.now();
  const code = 'c'.repeat(64);
  const made = await makeLookLink({ kv, owner, days: '3', random: () => code, now });
  assert.equal(made.code, code);
  assert.ok(![...kv.values.keys()].some(key => key.includes(code)), 'only the link\'s hash is kept');
  assert.equal(await takeLookLink({ kv, policyOf, code, viewer: owner, nameOf, now }), null, 'the owner cannot take their own link');
  const taken = await takeLookLink({ kv, policyOf, code, viewer, nameOf, now });
  assert.match(taken.id, /^[0-9a-f]{32}$/);
  assert.equal(taken.owner, owner);
  assert.equal(await takeLookLink({ kv, policyOf, code, viewer: 'third-account', nameOf, now }), null, 'it works once');
  const { letting } = await looking({ kv, policy: policyOf(owner), userId: owner, now });
  assert.deepEqual(letting.map(item => [item.who, Date.parse(item.until) - now]), [['Morgan', 3 * 86_400_000]]);
  const look = await startLook({ kv, policyOf, ...taken, viewer, hash, random, now });
  assert.equal(look.owner, owner);
  await assert.rejects(makeLookLink({ kv, owner, days: '30', random: () => code, now }), ViewAsError);
});

test('the owner is told one notice per look, naming who and for how long; the newest kept looks are kept, names at most 120 characters', () => {
  const notice = lookedNotice({ name: 'Ana', at: '2026-10-18T10:00:00.000Z', until: '2026-10-18T12:30:00.000Z' });
  assert.deepEqual(notice, { key: 'someone-looked:2026-10-18T10:00:00.000Z', kind: viewAsSettings.notice_kind,
    title: viewAsSaid('notice_title', { name: 'Ana' }), body: viewAsSaid('notice_body', { minutes: 150 }), refs: { open: '/settings/privacy' } });
  assert.equal(lookedNotice({ name: 'Ana', at: '2026-10-18T10:00:00.000Z', until: '2026-10-18T10:00:10.000Z' }).body, viewAsSaid('notice_body', { minutes: 1 }), 'at least a minute');
  let looks = [];
  for (let index = 0; index < viewAsSettings.kept_looks + 2; index += 1) looks = keepLook(looks, { name: `Viewer ${index}`, at: `2026-10-18T00:${String(index).padStart(2, '0')}:00.000Z`, until: '2026-10-19T00:00:00.000Z' });
  assert.equal(looks.length, viewAsSettings.kept_looks);
  assert.equal(looks[0].name, 'Viewer 2', 'the oldest are dropped');
  assert.equal(keepLook([], { name: 'x'.repeat(200), at: 'a', until: 'b' })[0].name.length, 120);
});
