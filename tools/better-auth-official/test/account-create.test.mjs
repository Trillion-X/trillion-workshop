// tools/better-auth-official/test/account-create.test.mjs
//
// A new person gets their account at the computer beside the tool: with settings.account_claim.create the user-create hook
// posts {} to the computer's loopback POST /accounts/create and the user row is written with the answered address in the
// account field, so the person's first pass carries it. A computer that refuses or does not answer refuses the sign-up and
// no user row is written. With ACCOUNT_CREATE_URL set (a scratch engine's own loopback operation) the same sign-up is made
// against that engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The stand-in computer: answers each POST /accounts/create with the next of `answers` ([status, body]) and counts the calls.
const answers = [];
let calls = 0;
const computer = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    calls += 1;
    const [status, reply] = request.method === 'POST' && request.url === '/accounts/create' && body === '{}' ? answers.shift() : [404, { error: 'not_found' }];
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
});
await new Promise(resolve => computer.listen(0, '127.0.0.1', resolve));
const standIn = `http://127.0.0.1:${computer.address().port}/accounts/create`;

const dir = mkdtempSync(join(tmpdir(), 'account-create-'));
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = {
  ...shipped, database_path: 'auth.db', disabled_paths: [], email: { outbox: 'outbox.jsonl', command: null },
  account_claim: { ...shipped.account_claim, create: { url: process.env.ACCOUNT_CREATE_URL ?? standIn, timeout_ms: 10000 } },
};
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth } = await import('../auth.mjs');
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();

const ORIGIN = settings.base_url;
const signUp = email => auth.handler(new Request(`${ORIGIN}${settings.base_path}/sign-up/email`, {
  method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'scratch-password-123', name: 'Scratch' }),
}));
const userOf = async email => (await (await auth.$context).internalAdapter.findUserByEmail(email))?.user ?? null;
const field = settings.account_claim.field;

test.after(() => computer.close());

test('a sign-up makes the person\'s account at the computer and keeps its address on the user', { skip: Boolean(process.env.ACCOUNT_CREATE_URL) }, async () => {
  const address = 'cd'.repeat(32);
  answers.push([200, { address }]);
  const before = calls;
  assert.equal((await signUp('made@example.test')).status, 200);
  assert.equal(calls, before + 1, 'one account per sign-up');
  assert.equal((await userOf('made@example.test'))[field], address);
});

test('a computer that refuses, answers no address or does not answer refuses the sign-up and writes no user', { skip: Boolean(process.env.ACCOUNT_CREATE_URL) }, async () => {
  answers.push([403, { error: 'sign_up_closed' }], [200, { address: 'not-an-address' }]);
  assert.notEqual((await signUp('closed@example.test')).status, 200);
  assert.equal(await userOf('closed@example.test'), null);
  assert.notEqual((await signUp('no-address@example.test')).status, 200);
  assert.equal(await userOf('no-address@example.test'), null);
  const silent = { ...settings.account_claim.create, url: 'http://127.0.0.1:9/accounts/create' };
  const { accountCreate } = await import('../account-claim.mjs');
  await assert.rejects(accountCreate({ account_claim: { ...settings.account_claim, create: silent } })({ email: 'silent@example.test' }), /did not answer/);
});

test('with no create in the settings no account is made and the user has none', async () => {
  const { accountCreate } = await import('../account-claim.mjs');
  const user = { email: 'none@example.test' };
  const before = calls;
  assert.deepEqual(await accountCreate({ account_claim: { field, claim: 'trillion_account' } })(user), { data: user });
  assert.deepEqual(await accountCreate({})(user), { data: user });
  assert.equal(calls, before);
});

test('a scratch engine at ACCOUNT_CREATE_URL makes the account a sign-up keeps', { skip: !process.env.ACCOUNT_CREATE_URL }, async () => {
  assert.equal((await signUp('engine@example.test')).status, 200);
  assert.match((await userOf('engine@example.test'))[field] ?? '', /^[0-9a-f]{64}$/);
});
