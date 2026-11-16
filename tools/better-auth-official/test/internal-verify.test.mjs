// tools/better-auth-official/test/internal-verify.test.mjs
//
// The engine checks a personal API key with one call: settings.internal names a loopback listener that answers only
// POST <verify_path> {key} with Better Auth's own verifyApiKey, as {valid, key: {id, userId, metadata}}. The public
// listener (the one Caddy reaches) never answers it. New keys start with settings.api_key.prefix and carry the creating
// party's account in metadata.trillion_account, whatever the request asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const dir = mkdtempSync(join(tmpdir(), 'internal-verify-'));
const [port, internal] = [await freePort(), await freePort()];
const base = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...base, port, base_url: `http://localhost:${port}`, issuer: `http://localhost:${port}`, audience: `http://localhost:${port}`, trusted_origins: [`http://localhost:${port}`], database_path: 'auth.db', email: { outbox: 'outbox.jsonl', command: null }, internal: { ...base.internal, port: internal }, api_key: { ...base.api_key, default_permissions: { trillion: ['records', 'tools'] } } };
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
const env = { ...process.env, BETTER_AUTH_SETTINGS: join(dir, 'settings.json'), BETTER_AUTH_SECRET: 'a-scratch-secret-for-this-test-only-0123456789' };
const tool = new URL('..', import.meta.url).pathname;
const { auth } = await (async () => { process.env.BETTER_AUTH_SETTINGS = env.BETTER_AUTH_SETTINGS; process.env.BETTER_AUTH_SECRET = env.BETTER_AUTH_SECRET; return import('../auth.mjs'); })();
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();
const server = spawn(process.execPath, [join(tool, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
test.after(() => server.kill());
await new Promise(done => { setTimeout(done, 30000); server.stdout.on('data', function wait(chunk) { if (/internal/.test(String(chunk))) { server.stdout.off('data', wait); done(); } }); });

const ACCOUNT = 'cd'.repeat(32);
const ORIGIN = settings.base_url;
const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const up = await post(`${ORIGIN}/api/auth/sign-up/email`, { email: 'keys@example.test', password: 'scratch-password-123', name: 'Scratch' });
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const ctx = await auth.$context;
const user = (await ctx.internalAdapter.findUserByEmail('keys@example.test')).user;
await ctx.internalAdapter.updateUser(user.id, { trillionAccount: ACCOUNT });
const made = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'scratch', metadata: { trillion_account: 'ef'.repeat(32) } }, cookie)).json();
const verify = key => post(`http://127.0.0.1:${internal}${settings.internal.verify_path}`, { key });

test('a new key is the settings prefix and 64 letters, whatever prefix the request asks for', async () => {
  assert.match(made.key ?? '', new RegExp(`^${settings.api_key.prefix}[A-Za-z]{64}$`));
  const asked = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'own prefix', prefix: 'mine_' }, cookie)).json();
  assert.match(asked.key ?? '', new RegExp(`^${settings.api_key.prefix}[A-Za-z]{64}$`));
});

test('the internal listener verifies a key: valid, its id, its user and the creating party\'s account', async () => {
  const answer = await (await verify(made.key)).json();
  assert.deepEqual(answer, { valid: true, key: { id: made.id, userId: user.id, metadata: { trillion_account: ACCOUNT }, permissions: settings.api_key.default_permissions } });
});

test('an altered key, or no key, is not valid', async () => {
  assert.deepEqual(await (await verify(`${made.key.slice(0, -2)}zz`)).json(), { valid: false, key: null });
  assert.equal((await verify('')).status, 400);
});

test('the public listener never answers the verify path, and Better Auth\'s own verify stays server-only', async () => {
  assert.equal((await post(`${ORIGIN}${settings.internal.verify_path}`, { key: made.key })).status, 404);
  assert.equal((await post(`${ORIGIN}/api/auth/api-key/verify`, { key: made.key })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${internal}/api/auth/ok`)).status, 404, 'the internal listener answers nothing else');
});

test('a key stays valid however often the engine checks it (the settings rate limit, not the plugin default of 10 a day)', async () => {
  for (let check = 0; check < 12; check++) assert.equal((await (await verify(made.key)).json()).valid, true, `check ${check + 1}`);
});

// A computer elsewhere: an account key and a computer key made here, the account's own computers row signed with the
// account key (the layout computers.rs signs), and the computer's key-check proof for one key.
const { generateKeyPairSync, sign } = await import('node:crypto');
const { addressOf, keyDigest } = await import('../computer-proof.mjs');
const pair = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { privateKey, hex: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex') }; };
const text = value => { const bytes = Buffer.from(value); const n = Buffer.alloc(4); n.writeUInt32BE(bytes.length); return Buffer.concat([n, bytes]); };
const list = values => { const n = Buffer.alloc(4); n.writeUInt32BE(values.length); return Buffer.concat([n, ...values.map(text)]); };
const proofSettings = settings.computer_proof;
const accountKey = pair(), computer = pair(), stranger = pair();
const address = addressOf(proofSettings, accountKey.hex);
const keptFor = (holders, by = accountKey) => {
  const address = addressOf(proofSettings, by.hex);
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(1n);
  const bytes = Buffer.concat([text(proofSettings.signed_domain), text(address), text(''), revision, list(holders), list(holders), list([])]);
  return { row: { account: address, revision: 1, holders, answering: holders, voters: [], signature: sign(null, bytes, by.privateKey).toString('hex') }, account_key: by.hex };
};
const proofFor = (who, key, at = Date.now()) => {
  const time = Buffer.alloc(8); time.writeBigInt64BE(BigInt(at));
  const bytes = Buffer.concat([text(proofSettings.proof_uses[settings.key_check.use]), text(keyDigest(key)), time]);
  return `trp_${who.hex}_${keyDigest(key)}_${at}_${sign(null, bytes, who.privateKey).toString('hex')}`;
};
const elsewhere = (key, { by = computer, kept = keptFor([computer.hex]), proof = proofFor(by, key) } = {}) =>
  fetch(`${ORIGIN}${settings.key_check.path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${proof}` }, body: JSON.stringify({ key, kept }) });
const second = await post(`${ORIGIN}/api/auth/sign-up/email`, { email: 'elsewhere@example.test', password: 'scratch-password-123', name: 'Scratch' });
const secondUser = (await ctx.internalAdapter.findUserByEmail('elsewhere@example.test')).user;
await ctx.internalAdapter.updateUser(secondUser.id, { trillionAccount: address });
const theirs = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'elsewhere' }, second.headers.getSetCookie().map(c => c.split(';')[0]).join('; '))).json();

test('a computer its account\'s row enrolls checks a key of that account over the public origin with its own proof', async () => {
  const answer = await elsewhere(theirs.key);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { valid: true, key: { id: theirs.id, userId: secondUser.id, metadata: { trillion_account: address }, permissions: settings.api_key.default_permissions } });
});

test('a computer the row does not list, a proof for another key, an old proof or no proof is not admitted', async () => {
  assert.equal((await elsewhere(theirs.key, { by: stranger })).status, 401);
  assert.equal((await elsewhere(theirs.key, { proof: proofFor(computer, made.key) })).status, 401);
  assert.equal((await elsewhere(theirs.key, { proof: proofFor(computer, theirs.key, Date.now() - proofSettings.window_ms - 5000) })).status, 401);
  assert.equal((await elsewhere(theirs.key, { proof: '' })).status, 401);
});

test('a computer learns nothing of another account\'s key', async () => {
  assert.deepEqual(await (await elsewhere(made.key)).json(), { valid: false, key: null });
});

test('a key whose user has no account takes, on its first check by a computer of an account, that account, and keeps it', async () => {
  const fresh = await post(`${ORIGIN}/api/auth/sign-up/email`, { email: 'made-before@example.test', password: 'scratch-password-123', name: 'Scratch' });
  const freshCookie = fresh.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const freshUser = (await ctx.internalAdapter.findUserByEmail('made-before@example.test')).user;
  const key = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'first' }, freshCookie)).json();
  assert.equal((await (await verify(key.key)).json()).key.metadata?.trillion_account, undefined, 'no account before the check');
  const other = pair(), otherComputer = pair();
  const linked = await (await elsewhere(key.key)).json();
  assert.equal(linked.valid, true);
  assert.equal(linked.key.metadata.trillion_account, address);
  assert.equal((await ctx.internalAdapter.findUserById(freshUser.id)).trillionAccount, address);
  assert.equal((await (await verify(key.key)).json()).key.metadata.trillion_account, address, 'the engine on this computer reads it too');
  const moved = await (await elsewhere(key.key, { by: otherComputer, kept: keptFor([otherComputer.hex], other) })).json();
  assert.deepEqual(moved, { valid: false, key: null }, 'a computer of another account learns nothing and moves nothing');
  assert.equal((await ctx.internalAdapter.findUserById(freshUser.id)).trillionAccount, address);
  const later = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'later' }, freshCookie)).json();
  assert.equal((await (await verify(later.key)).json()).key.metadata.trillion_account, address, 'every key of the user answers the account');
});

test('a party with no account cannot name one for its key', async () => {
  const none = await post(`${ORIGIN}/api/auth/sign-up/email`, { email: 'no-account@example.test', password: 'scratch-password-123', name: 'Scratch' });
  const key = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'named', metadata: { trillion_account: 'ef'.repeat(32), note: 'kept' } }, none.headers.getSetCookie().map(c => c.split(';')[0]).join('; '))).json();
  assert.deepEqual((await (await verify(key.key)).json()).key.metadata, { note: 'kept' });
});

test('a client can never set or change a key\'s trillion_account through the key update', async () => {
  const forged = { trillion_account: 'ef'.repeat(32) };
  const update = await post(`${ORIGIN}/api/auth/api-key/update`, { keyId: made.id, metadata: { ...forged, note: 'changed' } }, cookie);
  assert.ok(update.status === 200 || update.status === 400, `update answered ${update.status}`);
  assert.equal((await (await verify(made.key)).json()).key.metadata.trillion_account, ACCOUNT);
  const none = await post(`${ORIGIN}/api/auth/sign-in/email`, { email: 'no-account@example.test', password: 'scratch-password-123' });
  const noneCookie = none.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const theirsToo = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'plain' }, noneCookie)).json();
  await post(`${ORIGIN}/api/auth/api-key/update`, { keyId: theirsToo.id, metadata: forged }, noneCookie);
  assert.equal((await (await verify(theirsToo.key)).json()).key.metadata?.trillion_account, undefined);
});

test('a client can never set or change its own trillionAccount through the user update', async () => {
  const answer = await post(`${ORIGIN}/api/auth/update-user`, { trillionAccount: 'ef'.repeat(32), name: 'Renamed' }, cookie);
  assert.notEqual(answer.status, 500);
  assert.equal((await ctx.internalAdapter.findUserByEmail('keys@example.test')).user.trillionAccount, ACCOUNT);
});

test('a key made with a bearer session (no cookie) carries its maker\'s account too', async () => {
  const signedIn = await post(`${ORIGIN}/api/auth/sign-in/email`, { email: 'keys@example.test', password: 'scratch-password-123' });
  const token = (await signedIn.json()).token;
  assert.ok(token, 'the sign-in answers a session token');
  const made = await (await fetch(`${ORIGIN}/api/auth/api-key/create`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'by bearer', metadata: { trillion_account: 'ef'.repeat(32) } }) })).json();
  assert.equal((await (await verify(made.key)).json()).key?.metadata?.trillion_account, ACCOUNT);
});

// The engine asks whether a credential still stands, by its id (credential-standing.mjs): a standing key true, a revoked,
// disabled, expired or unknown key false, a user's session true until it ends, and anything of an undeclared kind false.
const standing = credential => post(`http://127.0.0.1:${internal}${settings.credential_standing.path}`, { credential }).then(answer => answer.json());

test('a standing key stands, and a key deleted in Better Auth no longer does', async () => {
  const key = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'to revoke' }, cookie)).json();
  assert.deepEqual(await standing(`key:${key.id}`), { valid: true });
  assert.equal((await post(`${ORIGIN}/api/auth/api-key/delete`, { keyId: key.id }, cookie)).status, 200);
  assert.deepEqual(await standing(`key:${key.id}`), { valid: false });
});

test('a disabled key and an expired key do not stand', async () => {
  const key = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'to disable' }, cookie)).json();
  await post(`${ORIGIN}/api/auth/api-key/update`, { keyId: key.id, enabled: false }, cookie);
  assert.deepEqual(await standing(`key:${key.id}`), { valid: false });
  const expiring = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'to expire' }, cookie)).json();
  await ctx.adapter.update({ model: 'apikey', where: [{ field: 'id', value: expiring.id }], update: { expiresAt: new Date(Date.now() - 1000) } });
  assert.deepEqual(await standing(`key:${expiring.id}`), { valid: false });
});

test('an unknown key, a credential of an undeclared kind and a body that does not read do not stand', async () => {
  assert.deepEqual(await standing('key:no-such-key'), { valid: false });
  assert.deepEqual(await standing(`other:${user.id}`), { valid: false });
  assert.deepEqual(await standing(`session:no-such-user`), { valid: false });
  assert.deepEqual(await standing(''), { valid: false });
  assert.deepEqual(await standing(undefined), { valid: false });
});

test('a session stands while the user holds one that has not ended, and a banned user stands for nothing', async () => {
  const other = await post(`${ORIGIN}/api/auth/sign-up/email`, { email: 'standing@example.test', password: 'scratch-password-123', name: 'Scratch' });
  const person = (await ctx.internalAdapter.findUserByEmail('standing@example.test')).user;
  assert.equal(other.status, 200);
  assert.deepEqual(await standing(`session:${person.id}`), { valid: true });
  const key = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'of the banned' }, other.headers.getSetCookie().map(c => c.split(';')[0]).join('; '))).json();
  assert.deepEqual(await standing(`key:${key.id}`), { valid: true });
  await ctx.adapter.deleteMany({ model: 'session', where: [{ field: 'userId', value: person.id }] });
  assert.deepEqual(await standing(`session:${person.id}`), { valid: false });
  await ctx.internalAdapter.updateUser(person.id, { banned: true });
  assert.deepEqual(await standing(`key:${key.id}`), { valid: false }, 'a banned user\'s key does not stand');
});

test('a client grant stands while a refresh token of the user for that client is not revoked', async () => {
  const person = (await ctx.internalAdapter.findUserByEmail('keys@example.test')).user;
  await ctx.adapter.create({ model: 'oauthClient', data: { clientId: 'a-connector', name: 'A connector', redirectUris: ['http://localhost/cb'], createdAt: new Date(), updatedAt: new Date() } });
  const token = await ctx.adapter.create({ model: 'oauthRefreshToken', data: { token: 'scratch-refresh', clientId: 'a-connector', userId: person.id, scopes: ['openid'], createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000) } });
  assert.deepEqual(await standing(`mcp-access:${person.id}:a-connector`), { valid: true });
  assert.deepEqual(await standing(`mcp-access:${person.id}:another-client`), { valid: false });
  await ctx.adapter.update({ model: 'oauthRefreshToken', where: [{ field: 'id', value: token.id }], update: { revoked: new Date() } });
  assert.deepEqual(await standing(`mcp-access:${person.id}:a-connector`), { valid: false });
});
