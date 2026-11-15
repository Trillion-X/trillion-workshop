// Characterize the original source algorithm with its imports supplied by current owners; no mail service opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes as identity } from '../tools/content-identity/read-data/identity.mjs';
import { friendInvites } from '../tools/invite-friends-by-email/read-data/friend-invites.mjs';
import settings from '../tools/invite-friends-by-email/src/friend-invites.json' with { type: 'json' };

async function sourceOwner(bindings) {
  const name = `heldFriendInvites${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[name] = bindings;
  try {
    const source = readFileSync(new URL('../ports/source-baselines/invite-friends-by-email/friend-invites.mjs.held', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
    return await import(`data:text/javascript;base64,${Buffer.from(`const {${Object.keys(bindings).join(',')}} = globalThis.${name};\n${source}`).toString('base64')}`);
  } finally { delete globalThis[name]; }
}
function fixture() {
  const rows = new Map(), delivered = [], accounts = new Map();
  let referrals = [];
  const env = { APP_KV: {
    async get(key, kind) { const row = rows.get(key); return row === undefined ? null : kind === 'json' ? structuredClone(row) : JSON.stringify(row); },
    async put(key, value) { rows.set(key, JSON.parse(value)); },
    async delete(key) { rows.delete(key); },
    async list({ prefix, limit, cursor }) {
      const keys = [...rows.keys()].filter(key => key.startsWith(prefix)).sort().filter(key => !cursor || key > cursor);
      const page = keys.slice(0, limit);
      return { keys: page.map(name => ({ name })), list_complete: page.length === keys.length, cursor: page.at(-1) };
    },
  } };
  const bindings = {
    settings,
    blake3: bytes => Buffer.from(identity(bytes).slice(3), 'hex'), bytesToHex: bytes => Buffer.from(bytes).toString('hex'),
    normalEmail: value => typeof value === 'string' && value.includes('@') ? value.trim().toLowerCase() : null,
    accountsForEmail: async (_kv, email) => accounts.get(email) ?? [],
    referralSummary: async () => ({ links: ['https://example.invalid/join?ref=synthetic'], friend_gets: { kind: 'percent', percent: 10 } }),
    referralsOf: async () => referrals, day: value => value.slice(0, 10), offWords: () => '10%',
    sendMail: async (_env, _mail, message) => { delivered.push(message); return { sent: true }; },
  };
  return { env, rows, delivered, accounts, bindings, setReferrals(value) { referrals = value; } };
}
const request = { name: '  Cy\n  Example ', email: 'CY@EXAMPLE.COM ', inviter: 'Ana', own_email: 'ana@example.com' };
const activeOwner = f => friendInvites({ ...f.bindings, rowType: 'synthetic-invite', door: {
  async readRecord(type, id) { return f.rows.has(id) ? { type, value: structuredClone(f.rows.get(id)) } : null; },
  async *list({ prefix, type }) { for (const id of [...f.rows.keys()].filter(id => id.startsWith(prefix)).reverse()) yield { id, type }; },
  async write(rows) { for (const { id, value } of rows) if (value === null) f.rows.delete(id); else f.rows.set(id, structuredClone(value)); },
} });
const at = { now: () => new Date('2026-11-07T15:00:00Z') };

for (const [kind, makeOwner] of [['source', f => sourceOwner(f.bindings)], ['port', activeOwner]]) {
test(kind + ' held friend invite sends normalized address and keeps one row only after sender accepts', async () => {
  const f = fixture(), owner = await makeOwner(f);
  assert.deepEqual(await owner.inviteFriend(f.env, 'ana', request, at), { name: 'Cy Example', email: 'cy@example.com', invited_at: '2026-11-07T15:00:00.000Z', times: 1 });
  assert.equal(f.delivered[0].to, 'cy@example.com');
  assert.equal(f.delivered[0].kind, settings.kind);
  assert.match(f.delivered[0].markdown, /10% off/);
  assert.match(f.delivered[0].footer_lines[0], /Ana typed your address/);
  const key = [...f.rows.keys()][0];
  assert.equal(key, `friend-invite:ana:${identity(new TextEncoder().encode('cy@example.com')).slice(3, 35)}`);
  await owner.inviteFriend(f.env, 'ana', { ...request, name: 'Cy' }, at);
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.get(key).times, 2);
});
test(kind + ' held friend invite validates and refuses without saving or dispatching', async () => {
  const f = fixture(), owner = await makeOwner(f);
  for (const change of [{ name: ' ' }, { email: 'broken' }, { email: request.own_email }]) await assert.rejects(owner.inviteFriend(f.env, 'ana', { ...request, ...change }, at), owner.FriendInviteError);
  assert.equal(f.delivered.length, 0);
  await assert.rejects(owner.inviteFriend(f.env, 'ana', request, { ...at, send: async () => ({ sent: false, error: 'synthetic refusal' }) }), /synthetic refusal/);
  assert.equal(f.rows.size, 0);
});
test(kind + ' held friend invite enforces account-specific cap while allowing resend at cap', async () => {
  const f = fixture(), owner = await makeOwner(f);
  await owner.inviteFriend(f.env, 'ana', request, at);
  for (let n = 1; n < settings.max; n++) f.rows.set(`friend-invite:ana:synthetic-${n}`, {});
  await assert.rejects(owner.inviteFriend(f.env, 'ana', { ...request, email: 'dee@example.com' }, at), /already have 500 invites/);
  assert.equal((await owner.inviteFriend(f.env, 'ana', request, at)).times, 2);
  await owner.inviteFriend(f.env, 'bo', { ...request, email: 'dee@example.com' }, at);
  assert.equal(f.delivered.length, 3);
});
test(kind + ' held invite list reads joined and paying facts and excludes inviter account', async () => {
  const f = fixture(), owner = await makeOwner(f);
  for (const [name, email] of [['Cy', 'cy@example.com'], ['Dee', 'dee@example.com'], ['Ana', 'ana@example.com']]) await owner.inviteFriend(f.env, 'ana', { name, email, inviter: 'Ana' }, at);
  f.accounts.set('cy@example.com', ['cy']); f.accounts.set('dee@example.com', ['dee']); f.accounts.set('ana@example.com', ['ana']);
  f.setReferrals([{ friend_id: 'dee', paid_at: '2026-11-07' }]);
  const list = await owner.invitesOf(f.env, 'ana');
  assert.deepEqual(Object.fromEntries(list.invites.map(row => [row.email, row.status.id])), { 'cy@example.com': 'joined', 'dee@example.com': 'paying', 'ana@example.com': 'sent' });
  assert.equal(owner.friendInviteFacts(list).rows.length, 3);
  assert.equal(owner.friendInviteFacts({ invites: [], next: 'a/b c' }).next_open, '/invite?invites_after=a%2Fb%20c');
  assert.equal(owner.friendInviteFacts(null), null);
  assert.equal(await owner.forgetInvite(f.env, 'bo', 'cy@example.com'), false);
  assert.equal(await owner.forgetInvite(f.env, 'ana', 'CY@EXAMPLE.COM'), true);
  assert.equal(await owner.forgetInvite(f.env, 'ana', 'cy@example.com'), false);
});

}

test('port requires real bindings before touching account rows', () => { assert.throws(() => friendInvites({}), /records owner/); });

test('port uses the public records client across short pages and stays within account prefix rights', async t => {
  const { startFakeDoor } = await import('../tools/records-door/test/fake-door.mjs');
  const { openRecordsDoor } = await import('../tools/records-door/read-data/records-door.mjs');
  const type = 'synthetic-invite';
  const records = Array.from({ length: 23 }, (_, n) => ({ type, id: `friend-invite:ana:${String(n).padStart(3, '0')}`, value: { name: `Friend ${n}`, email: `friend${n}@example.com`, times: 1, invited_at: '2026-11-07T15:00:00Z' } }));
  const server = await startFakeDoor({ records, pageCut: 3, rights: [{ kind: type, prefix: 'friend-invite:ana:', operations: ['records:read', 'records:list', 'records:write'] }] });
  t.after(() => server.close());
  const f = fixture();
  const owner = friendInvites({ ...f.bindings, rowType: type, door: openRecordsDoor({ descriptor: server.descriptor }) });
  const first = await owner.invitesOf({}, 'ana');
  assert.equal(first.invites.length, 20);
  const second = await owner.invitesOf({}, 'ana', { after: first.next });
  assert.equal(second.invites.length, 3);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.invites, ...second.invites].map(row => row.email)).size, 23);
  await assert.rejects(owner.invitesOf({}, 'ana', { after: 'friend-invite:bo:000' }), /another account/);
  await assert.rejects(owner.forgetInvite({}, 'bo', 'cy@example.com'), /may not reach/);
  await owner.inviteFriend({}, 'ana', request, at);
  assert.equal(f.delivered.length, 1);
  assert.equal([...server.kept.values()].filter(row => row.type === type).length, 24);
});
