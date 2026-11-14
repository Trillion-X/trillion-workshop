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
const settings = { ...base, port, base_url: `http://localhost:${port}`, issuer: `http://localhost:${port}`, audience: `http://localhost:${port}`, trusted_origins: [`http://localhost:${port}`], database_path: 'auth.db', email: { outbox: 'outbox.jsonl', command: null }, internal: { ...base.internal, port: internal } };
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
  assert.deepEqual(answer, { valid: true, key: { id: made.id, userId: user.id, metadata: { trillion_account: ACCOUNT } } });
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
const keptFor = holders => {
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(1n);
  const bytes = Buffer.concat([text(proofSettings.signed_domain), text(address), text(''), revision, list(holders), list(holders), list([])]);
  return { row: { account: address, revision: 1, holders, answering: holders, voters: [], signature: sign(null, bytes, accountKey.privateKey).toString('hex') }, account_key: accountKey.hex };
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
  assert.deepEqual(await answer.json(), { valid: true, key: { id: theirs.id, userId: secondUser.id, metadata: { trillion_account: address } } });
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
