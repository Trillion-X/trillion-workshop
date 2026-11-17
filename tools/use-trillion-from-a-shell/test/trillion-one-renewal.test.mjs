// Many `trillion` runs at once renew the sign-in once. The server rotates the refresh token on every renewal and ends the whole sign-in when a
// token it already rotated comes again (Better Auth's reuse rule); this test issuer does the same, so one unlocked second renewal fails it.
// Test issuer only: nothing here touches a real sign-in.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { credentialFor } from '../do-work/trillion.mjs';
import settings from '../do-work/trillion.json' with { type: 'json' };

const run = promisify(execFile);

async function issuer() {
  const state = { renewals: 0, current: 'refresh-0', dead: false, reuse: 0 };
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const asked = new URLSearchParams(raw);
    const send = (code, value) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (state.dead || asked.get('refresh_token') !== state.current) { if (!state.dead) state.reuse += 1; state.dead = true; return send(400, { error: 'invalid_grant', error_description: 'session not found' }); }
    await new Promise(resolve => setTimeout(resolve, 150));
    state.renewals += 1;
    state.current = `refresh-${state.renewals}`;
    return send(200, { access_token: `access-${state.renewals}`, refresh_token: state.current, expires_in: 3600 });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

const endingGrant = origin => ({ access_token: 'access-0', refresh_token: 'refresh-0', expires_at_ms: Date.now() + 5_000, client_id: 'c', origin, token_endpoint: `${origin}/token`, resource: `${origin}/mcp` });

test('50 runs at once renew the sign-in once, and every one carries the renewed pass', async () => {
  const server = await issuer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'one-renewal-'));
    const file = join(home, 'grant.json');
    writeFileSync(file, JSON.stringify(endingGrant(server.origin)));
    const child = new URL('../test-fixtures/one-renewal-child.mjs', import.meta.url).pathname;
    const answers = await Promise.all(Array.from({ length: 50 }, () => run(process.execPath, [child, file, home]).then(done => done.stdout)));
    assert.equal(server.state.renewals, 1, 'one renewal for fifty runs');
    assert.equal(server.state.reuse, 0, 'no rotated token came again, so the sign-in was not ended');
    assert.deepEqual([...new Set(answers)], ['access-1']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).refresh_token, 'refresh-1');
  } finally { await server.close(); }
});

test('a refused renewal is read against the store again before the sign-in is called ended', async () => {
  const server = await issuer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'one-renewal-'));
    let stored = endingGrant(server.origin);
    let reads = 0;
    // The first read finds the old sign-in; another process renews between our read and our refusal, so the next read has the new one.
    const grants = { where: 'g', write: grant => { stored = grant; }, forget() {}, read: () => {
      reads += 1;
      return reads <= 2 ? stored : { ...stored, access_token: 'access-other', refresh_token: 'refresh-other', expires_at_ms: Date.now() + 3600_000 };
    } };
    server.state.current = 'someone-else-rotated';
    const credential = await credentialFor({ env: {}, store: { read: () => null }, grants, rules: { ...settings, state_folder: home }, home });
    assert.equal(credential.bearer, 'access-other');
    server.state.dead = false;
    reads = 0;
    const ended = { where: 'g', write() {}, forget() {}, read: () => endingGrant(server.origin) };
    await assert.rejects(credentialFor({ env: {}, store: { read: () => null }, grants: ended, rules: { ...settings, state_folder: home }, home }), error => error.status === 3 && error.message === settings.words.sign_in_ended);
  } finally { await server.close(); }
});

test('a lock a dead process left is taken over', async () => {
  const server = await issuer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'one-renewal-'));
    const { mkdirSync, utimesSync } = await import('node:fs');
    const lock = join(home, settings.grant.lock);
    mkdirSync(lock);
    const old = new Date(Date.now() - (settings.grant.lock_stale_seconds + 5) * 1000);
    utimesSync(lock, old, old);
    let stored = endingGrant(server.origin);
    const grants = { where: 'g', read: () => stored, write: grant => { stored = grant; }, forget() {} };
    const credential = await credentialFor({ env: {}, store: { read: () => null }, grants, rules: { ...settings, state_folder: home }, home });
    assert.equal(credential.bearer, 'access-1');
  } finally { await server.close(); }
});
